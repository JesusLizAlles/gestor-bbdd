import { checkServerIdentity } from 'node:tls'
import pg from 'pg'
import Cursor from 'pg-cursor'
import type {
  ColumnInfo,
  CompletionColumn,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  ServerInfo,
  TableInfo,
  TableRef
} from '@shared/types'
import type { ParamStatement } from '@shared/table-query'
import { COMPLETION_COLUMN_LIMIT } from '@shared/completion'
import { quoteIdent } from '@shared/format'
import { splitStatements } from '@shared/sql'
import { groupBy } from './group'
import { DdlError, friendlyDbError, rowChangedError } from './errors'
import type { DbDriver, DriverConnectOptions, ExecuteOptions } from './types'
import { normalizeValue } from './values'

const raw = (value: string): string => value
const integer = (value: string): number | string => {
  const n = Number(value)
  // BIGINT como número salvo que no quepa sin perder precisión (entonces texto), igual que en MySQL.
  return Number.isSafeInteger(n) ? n : value
}

/**
 * Valores tal como los escribe el servidor, salvo booleanos y números. Así las fechas no pierden los
 * microsegundos ni cambian de zona, y arrays, intervalos o JSON se pueden editar y volver a guardar
 * con el mismo texto que se ve.
 */
export const PG_TYPES = {
  getTypeParser(oid: number, format?: 'text' | 'binary'): (value: string) => unknown {
    if (format === 'binary') return pg.types.getTypeParser(oid, 'binary')
    switch (oid) {
      case 16: // bool
        return (value) => value === 't'
      case 17: // bytea → Buffer (normalizeValue lo enseña en hexadecimal)
        return pg.types.getTypeParser(17, 'text')
      case 20: // int8
      case 21: // int2
      case 23: // int4
      case 26: // oid
        return integer
      case 700: // float4
      case 701: // float8
        return Number
      default:
        return raw
    }
  }
}

/** Nombres cortos (los de pg_type) de los tipos más comunes, sin preguntar al servidor. */
const TYPE_NAMES = new Map<number, string>([
  [16, 'bool'], [17, 'bytea'], [18, 'char'], [19, 'name'], [20, 'int8'], [21, 'int2'], [23, 'int4'], [25, 'text'],
  [26, 'oid'], [114, 'json'], [142, 'xml'], [650, 'cidr'], [700, 'float4'], [701, 'float8'], [790, 'money'],
  [829, 'macaddr'], [869, 'inet'], [1042, 'bpchar'], [1043, 'varchar'], [1082, 'date'], [1083, 'time'],
  [1114, 'timestamp'], [1184, 'timestamptz'], [1186, 'interval'], [1266, 'timetz'], [1560, 'bit'],
  [1562, 'varbit'], [1700, 'numeric'], [2950, 'uuid'], [3802, 'jsonb'], [2249, 'record'], [2278, 'void']
])

/** Esquemas del sistema que no se enseñan en el explorador. */
const USER_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`

/** Error del servidor con el detalle y la pista que añade PostgreSQL (p. ej. «You might need to specify USING…»). */
function serverError(err: unknown): Error {
  const e = err as Error & { detail?: string; hint?: string; code?: string }
  if (!(e instanceof Error) || !e.code) return e instanceof Error ? e : new Error(String(err))
  const extra = [e.detail, e.hint].filter(Boolean).join(' ')
  return new Error(extra ? `${e.message}. ${extra}` : e.message)
}

interface QueryConnection {
  client: pg.Client
  /** Proceso del servidor que atiende la conexión, para cancelar con pg_cancel_backend. */
  pid: number
}

interface ColumnRow {
  name: string
  type: string
  notnull: boolean
  def: string | null
  ident: string
  gen: string
  comment: string | null
  collation: string | null
  pk: boolean
}

/**
 * PostgreSQL sobre pg. Una conexión solo ve una base de datos, así que se abren por base de datos y
 * bajo demanda: una para las consultas del usuario (conserva SET, temporales y transacciones de esa
 * base de datos) y otra para metadatos y para cancelar sin esperar a la consulta en curso.
 */
export class PostgresDriver implements DbDriver {
  private readonly queryConns = new Map<string, Promise<QueryConnection>>()
  private readonly metaConns = new Map<string, Promise<pg.Client>>()
  private readonly typeNames = new Map<string, string>()
  private readonly target: string
  private readonly initialDatabase: string
  /** Base de datos de la conexión de consultas activa (useDatabase). */
  private active: string
  private running: QueryConnection | null = null
  private serverVersion = 0
  private closed = false

  constructor(private readonly opts: DriverConnectOptions) {
    const { config } = opts
    this.target = opts.tunneled ? `${config.host}:${config.port} (vía SSH)` : `${config.host}:${config.port}`
    this.initialDatabase = config.database?.trim() || 'postgres'
    this.active = this.initialDatabase
  }

  async connect(): Promise<ServerInfo> {
    try {
      await this.queryConn(this.initialDatabase)
      await this.meta(this.initialDatabase)
    } catch (err) {
      await this.close()
      throw err
    }
    const [row] = await this.metaRows<{ version: string; num: number; db: string }>(
      this.initialDatabase,
      "SELECT current_setting('server_version') AS version, current_setting('server_version_num')::int AS num, current_database() AS db"
    )
    this.serverVersion = row?.num ?? 0
    return { product: 'PostgreSQL', version: (row?.version ?? '').split(' ')[0] ?? '', currentDatabase: row?.db ?? null }
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.metaRows<{ name: string }>(
      this.initialDatabase,
      `SELECT datname AS name FROM pg_database
        WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname, 'CONNECT')
        ORDER BY datname`
    )
    return rows.map((r) => r.name)
  }

  async listTables(database: string): Promise<TableInfo[]> {
    // Las particiones de una tabla particionada no se enseñan: se consultan a través de la tabla madre.
    const partitions = this.serverVersion >= 100000 ? 'AND NOT c.relispartition' : ''
    const rows = await this.metaRows<{ s: string; name: string; kind: string }>(
      database,
      `SELECT n.nspname AS s, c.relname AS name, c.relkind AS kind
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') ${partitions} AND ${USER_SCHEMAS}
        ORDER BY n.nspname, c.relname`
    )
    return rows.map((r) => ({ schema: r.s, name: r.name, kind: r.kind === 'v' || r.kind === 'm' ? 'view' : 'table' }))
  }

  async listColumns(database: string, table: string, schema: string | null): Promise<ColumnInfo[]> {
    const rows = await this.columnRows(database, schema ?? 'public', table)
    return rows.map((r) => ({
      name: r.name,
      dataType: r.type,
      nullable: !r.notnull,
      isPrimaryKey: r.pk,
      defaultValue: r.gen ? null : r.def,
      autoIncrement: r.ident !== '',
      comment: r.comment,
      collation: r.collation,
      generated: r.gen && r.def !== null ? { expression: r.def, stored: true } : null
    }))
  }

  async completionColumns(database: string): Promise<CompletionColumn[]> {
    const rows = await this.metaRows<{ s: string; t: string; c: string; d: string }>(
      database,
      `SELECT n.nspname AS s, c.relname AS t, a.attname AS c, format_type(a.atttypid, NULL) AS d
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped AND ${USER_SCHEMAS}
        ORDER BY n.nspname, c.relname, a.attnum
        LIMIT ${COMPLETION_COLUMN_LIMIT}`
    )
    return rows.map((r) => ({ schema: r.s, table: r.t, column: r.c, dataType: r.d }))
  }

  async listIndexes({ database, schema, table }: TableRef): Promise<IndexInfo[]> {
    const keyColumns = this.serverVersion >= 110000 ? 'x.indnkeyatts' : 'x.indnatts'
    const rows = await this.metaRows<{ name: string; uq: boolean; pk: boolean; uc: boolean; col: string }>(
      database,
      `SELECT i.relname AS name, x.indisunique AS uq, x.indisprimary AS pk, COALESCE(con.contype = 'u', false) AS uc,
              COALESCE(a.attname, pg_get_indexdef(x.indexrelid, k.n, true)) AS col
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class c ON c.oid = x.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_constraint con ON con.conrelid = x.indrelid AND con.conindid = x.indexrelid AND con.contype IN ('p', 'u', 'x')
         CROSS JOIN LATERAL generate_series(1, ${keyColumns}) AS k(n)
         LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = x.indkey[k.n - 1] AND x.indkey[k.n - 1] <> 0
        WHERE n.nspname = $1 AND c.relname = $2 AND con.contype IS DISTINCT FROM 'x'
        ORDER BY x.indisprimary DESC, i.relname, k.n`,
      [schema ?? 'public', table]
    )
    return groupBy(rows, (r) => r.name).map(([name, cols]) => ({
      name,
      columns: cols.map((c) => c.col),
      unique: cols[0]!.uq,
      primary: cols[0]!.pk,
      uniqueConstraint: cols[0]!.uc
    }))
  }

  async listForeignKeys({ database, schema, table }: TableRef): Promise<ForeignKeyInfo[]> {
    const rows = await this.metaRows<{ name: string; col: string; rs: string; rt: string; rc: string }>(
      database,
      `SELECT con.conname AS name, a.attname AS col, rn.nspname AS rs, rc.relname AS rt, ra.attname AS rc
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(col, refcol, ord)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.col
         JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refcol
        WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2
        ORDER BY con.conname, k.ord`,
      [schema ?? 'public', table]
    )
    return groupBy(rows, (r) => r.name).map(([name, cols]) => ({
      name,
      columns: cols.map((c) => c.col),
      refDatabase: database,
      refSchema: cols[0]!.rs,
      refTable: cols[0]!.rt,
      refColumns: cols.map((c) => c.rc)
    }))
  }

  /** PostgreSQL no guarda el CREATE TABLE: se reconstruye con las columnas, restricciones e índices. */
  async tableDdl({ database, schema, table }: TableRef): Promise<string | null> {
    const s = schema ?? 'public'
    const name = `${quoteIdent(s, 'postgres')}.${quoteIdent(table, 'postgres')}`
    const [rel] = await this.metaRows<{ oid: number; kind: string; view: string | null; part: string | null; comment: string | null }>(
      database,
      `SELECT c.oid::int AS oid, c.relkind AS kind,
              CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS view,
              ${this.serverVersion >= 100000 ? "CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END" : 'NULL'} AS part,
              obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [s, table]
    )
    if (!rel) return null
    if (rel.view !== null) {
      return `CREATE ${rel.kind === 'm' ? 'MATERIALIZED ' : ''}VIEW ${name} AS\n${rel.view.trim()}`
    }
    const [columns, constraints, indexes] = await Promise.all([
      this.columnRows(database, s, table),
      this.metaRows<{ name: string; def: string }>(
        database,
        `SELECT conname AS name, pg_get_constraintdef(oid, true) AS def FROM pg_constraint
          WHERE conrelid = $1 AND contype IN ('p', 'u', 'f', 'c', 'x')
          ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'f' THEN 3 ELSE 4 END, conname`,
        [rel.oid]
      ),
      this.metaRows<{ def: string }>(
        database,
        `SELECT pg_get_indexdef(x.indexrelid) AS def FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
          WHERE x.indrelid = $1
            AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = x.indrelid AND c.conindid = x.indexrelid)
          ORDER BY i.relname`,
        [rel.oid]
      )
    ])
    const lines = columns.map((c) => {
      const parts = [quoteIdent(c.name, 'postgres'), c.type]
      if (c.collation) parts.push(`COLLATE ${quoteIdent(c.collation, 'postgres')}`)
      if (c.gen) parts.push(`GENERATED ALWAYS AS (${c.def}) STORED`)
      if (c.ident) parts.push(`GENERATED ${c.ident === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`)
      if (c.notnull) parts.push('NOT NULL')
      if (c.def !== null && !c.gen) parts.push(`DEFAULT ${c.def}`)
      return `  ${parts.join(' ')}`
    })
    for (const con of constraints) lines.push(`  CONSTRAINT ${quoteIdent(con.name, 'postgres')} ${con.def}`)
    const out = [`CREATE TABLE ${name} (\n${lines.join(',\n')}\n)${rel.part ? ` PARTITION BY ${rel.part}` : ''};`]
    for (const ix of indexes) out.push(`${ix.def};`)
    const literal = (text: string) => `'${text.replace(/'/g, "''")}'`
    if (rel.comment) out.push(`COMMENT ON TABLE ${name} IS ${literal(rel.comment)};`)
    for (const c of columns) {
      if (c.comment) out.push(`COMMENT ON COLUMN ${name}.${quoteIdent(c.name, 'postgres')} IS ${literal(c.comment)};`)
    }
    return out.join('\n')
  }

  async useDatabase(database: string): Promise<void> {
    await this.queryConn(database)
    this.active = database
  }

  async execute(statement: string, { maxRows }: ExecuteOptions): Promise<QueryResult[]> {
    const words = splitStatements(statement, 'postgres')[0]?.words ?? []
    if (words[0] === 'COPY' && (words.includes('STDIN') || words.includes('STDOUT'))) {
      throw new Error("COPY … FROM STDIN / TO STDOUT no se puede usar aquí: usa una SELECT, INSERT … VALUES o COPY con un fichero del servidor")
    }
    const database = this.active
    const conn = await this.queryConn(database)
    const started = performance.now()
    // Con un cursor el servidor manda como mucho maxRows + 1 filas (la de más indica que hay truncado).
    // Además va por el protocolo extendido, que no admite varias sentencias en el mismo texto.
    const cursor = conn.client.query(
      Object.assign(new Cursor(statement, undefined, { rowMode: 'array', types: PG_TYPES }), {
        // pg-cursor no conoce el subprotocolo de COPY: sin esto, un COPY con STDIN/STDOUT que llegue
        // hasta aquí lanzaría una excepción fuera de cualquier promesa y tumbaría el proceso.
        handleCopyInResponse: (connection: { sendCopyFail(message: string): void }) => connection.sendCopyFail('COPY FROM STDIN no admitido'),
        handleCopyData: () => {}
      })
    )
    this.running = conn
    try {
      const { rows, result } = await new Promise<{ rows: unknown[][]; result: pg.QueryResult }>((resolve, reject) => {
        let settled = false
        cursor.read(maxRows + 1, (err, rows, result) => {
          if (settled) return
          settled = true
          if (err) reject(err)
          else resolve({ rows: rows as unknown[][], result })
        })
      })
      const truncated = rows.length > maxRows
      if (truncated) await cursor.close()
      const durationMs = Math.round(performance.now() - started)
      if (result.fields.length === 0) {
        return [{ statement, columns: [], rows: [], affectedRows: result.rowCount ?? 0, truncated: false, durationMs }]
      }
      const names = await this.resultTypeNames(database, result.fields.map((f) => f.dataTypeID))
      return [
        {
          statement,
          columns: result.fields.map((f, i) => ({ name: f.name, type: names[i]! })),
          rows: rows.slice(0, maxRows).map((row) => row.map(normalizeValue)),
          affectedRows: null,
          truncated,
          durationMs
        }
      ]
    } catch (err) {
      const e = err as { code?: string }
      if (e.code === '57014') throw new Error('Consulta cancelada por el usuario')
      throw serverError(err)
    } finally {
      this.running = null
    }
  }

  async executeChanges(statements: ParamStatement[]): Promise<void> {
    const { client } = await this.queryConn(this.active)
    await client.query('BEGIN')
    try {
      for (const [i, st] of statements.entries()) {
        const label = st.label ?? `el cambio nº ${i + 1}`
        const result = await client.query({ text: st.sql, values: st.params })
        if (result.rowCount !== 1) throw rowChangedError(label, result.rowCount ?? 0)
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw serverError(err)
    }
  }

  /** En una transacción: el DDL de PostgreSQL también se deshace, así que si algo falla no queda nada aplicado. */
  async executeDdl(statements: string[]): Promise<number> {
    const { client } = await this.queryConn(this.active)
    await client.query('BEGIN')
    try {
      for (const [i, st] of statements.entries()) {
        try {
          // Protocolo extendido: una sola sentencia por mensaje, pase lo que pase con el texto.
          await client.query({ text: st, queryMode: 'extended' } as pg.QueryConfig)
        } catch (err) {
          throw new Error(`Sentencia ${i + 1} de ${statements.length}: ${serverError(err).message}`)
        }
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw new DdlError((err as Error).message, 0)
    }
    return statements.length
  }

  async cancel(): Promise<void> {
    const running = this.running
    if (!running) return
    await this.metaRows(this.active, 'SELECT pg_cancel_backend($1)', [running.pid])
  }

  async close(): Promise<void> {
    this.closed = true
    const pending = [
      ...[...this.queryConns.values()].map((p) => p.then((c) => c.client)),
      ...this.metaConns.values()
    ]
    this.queryConns.clear()
    this.metaConns.clear()
    await Promise.all(
      pending.map(async (p) => {
        const client = await p.catch(() => null)
        if (!client) return
        await Promise.race([client.end().catch(() => {}), new Promise((r) => setTimeout(r, 2000).unref())])
      })
    )
  }

  private columnRows(database: string, schema: string, table: string): Promise<ColumnRow[]> {
    const v = this.serverVersion
    return this.metaRows<ColumnRow>(
      database,
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
              pg_get_expr(d.adbin, d.adrelid) AS def,
              ${v >= 100000 ? 'a.attidentity::text' : "''"} AS ident,
              ${v >= 120000 ? 'a.attgenerated::text' : "''"} AS gen,
              col_description(c.oid, a.attnum) AS comment,
              CASE WHEN a.attcollation <> t.typcollation THEN co.collname END AS collation,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS pk
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN pg_collation co ON co.oid = a.attcollation
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, table]
    )
  }

  /** Nombre del tipo de cada columna de un resultado; los poco comunes se preguntan una vez por base de datos. */
  private async resultTypeNames(database: string, oids: number[]): Promise<string[]> {
    const key = (oid: number) => `${database}\u0000${oid}`
    const unknown = [...new Set(oids.filter((oid) => !TYPE_NAMES.has(oid) && !this.typeNames.has(key(oid))))]
    if (unknown.length) {
      const rows = await this.metaRows<{ oid: number; name: string }>(
        database,
        `SELECT t.oid::int AS oid,
                CASE WHEN t.typcategory = 'A' AND e.oid IS NOT NULL THEN e.typname || '[]' ELSE t.typname END AS name
           FROM pg_type t LEFT JOIN pg_type e ON e.oid = t.typelem
          WHERE t.oid = ANY ($1::oid[])`,
        [unknown]
      ).catch(() => [])
      for (const r of rows) this.typeNames.set(key(r.oid), r.name)
    }
    return oids.map((oid) => TYPE_NAMES.get(oid) ?? this.typeNames.get(key(oid)) ?? String(oid))
  }

  private queryConn(database: string): Promise<QueryConnection> {
    let conn = this.queryConns.get(database)
    if (!conn) {
      conn = this.open(database).then(async (client) => {
        const [row] = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows
        return { client, pid: row!.pid }
      })
      this.track(this.queryConns, database, conn, (c) => c.client)
    }
    return conn
  }

  private meta(database: string): Promise<pg.Client> {
    let conn = this.metaConns.get(database)
    if (!conn) {
      conn = this.open(database)
      this.track(this.metaConns, database, conn, (c) => c)
    }
    return conn
  }

  /** Guarda la conexión y la olvida si falla al abrirse o se cae después: la siguiente vez se abre otra. */
  private track<T>(map: Map<string, Promise<T>>, database: string, conn: Promise<T>, client: (c: T) => pg.Client): void {
    map.set(database, conn)
    const forget = () => {
      if (map.get(database) === conn) map.delete(database)
    }
    conn.then((c) => client(c).on('end', forget), forget)
  }

  private async open(database: string): Promise<pg.Client> {
    if (this.closed) throw new Error('La conexión está cerrada')
    const { config, host, port, password, tunneled, ca } = this.opts
    const verify = config.tls.verifyServerCert
    const client = new pg.Client({
      host,
      port,
      user: config.username,
      password,
      database,
      application_name: 'Gestor BBDD',
      connectionTimeoutMillis: 15_000,
      keepAlive: true,
      types: PG_TYPES,
      ssl: config.tls.enabled
        ? {
            rejectUnauthorized: verify,
            ...(ca ? { ca } : {}),
            // Con túnel el host es 127.0.0.1: el certificado se valida contra el servidor real.
            ...(tunneled && verify ? { checkServerIdentity: (_host: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(config.host, cert) } : {})
          }
        : false
    })
    // Sin este manejador, una conexión que se cae tumbaría el proceso principal.
    client.on('error', () => {})
    client.on('notice', () => {})
    try {
      await client.connect()
      // Fechas en ISO 8601 vengan como vengan configuradas en el servidor. En solo lectura, además,
      // el servidor rechaza escrituras aunque el clasificador falle (defensa en profundidad).
      await client.query(
        config.readOnly ? 'SET DateStyle = ISO; SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY' : 'SET DateStyle = ISO'
      )
    } catch (err) {
      await client.end().catch(() => {})
      throw friendlyDbError(err, this.target)
    }
    return client
  }

  private async metaRows<T>(database: string, text: string, values: unknown[] = []): Promise<T[]> {
    const client = await this.meta(database)
    try {
      return (await client.query({ text, values })).rows as T[]
    } catch (err) {
      throw serverError(err)
    }
  }
}
