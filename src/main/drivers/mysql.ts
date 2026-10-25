import mysql, { type Connection, type ConnectionOptions, type FieldPacket, type ResultSetHeader } from 'mysql2'
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
import { groupBy } from './group'
import { friendlyDbError } from './errors'
import type { DbDriver, DriverConnectOptions, ExecuteOptions } from './types'
import { normalizeValue } from './values'

const TYPE_NAMES = new Map<number, string>(Object.entries(mysql.Types).map(([name, id]) => [id as number, name]))

// Nombres del protocolo → nombres SQL que reconoce cualquiera.
const SQL_NAMES: Record<string, string> = {
  DECIMAL: 'decimal', NEWDECIMAL: 'decimal', TINY: 'tinyint', SHORT: 'smallint', LONG: 'int', INT24: 'mediumint',
  LONGLONG: 'bigint', FLOAT: 'float', DOUBLE: 'double', NULL: 'null', TIMESTAMP: 'timestamp', DATE: 'date',
  NEWDATE: 'date', TIME: 'time', DATETIME: 'datetime', YEAR: 'year', BIT: 'bit', JSON: 'json', GEOMETRY: 'geometry',
  VECTOR: 'vector', ENUM: 'enum', SET: 'set'
}
const BINARY_CHARSET = 63
const ENUM_FLAG = 256
const SET_FLAG = 2048

function sqlTypeName(field: FieldPacket): string {
  const raw = TYPE_NAMES.get(field.columnType ?? field.type ?? -1) ?? ''
  const flags = typeof field.flags === 'number' ? field.flags : 0
  const binary = field.characterSet === BINARY_CHARSET
  // MariaDB 10.5+ informa del tipo real de JSON, UUID, INET4/6… en sus metadatos extendidos.
  if (field.extendedTypeName) return field.extendedTypeName
  if (field.extendedFormat) return field.extendedFormat
  if (flags & ENUM_FLAG) return 'enum'
  if (flags & SET_FLAG) return 'set'
  if (raw === 'VAR_STRING' || raw === 'VARCHAR') return binary ? 'varbinary' : 'varchar'
  if (raw === 'STRING') return binary ? 'binary' : 'char'
  if (raw.endsWith('BLOB')) {
    // TINY_BLOB → tinytext/tinyblob, BLOB → text/blob… (el servidor manda TEXT como BLOB con juego de caracteres).
    const size = raw.replace(/_?BLOB$/, '').toLowerCase()
    return `${size}${binary ? 'blob' : 'text'}`
  }
  return SQL_NAMES[raw] ?? raw.toLowerCase()
}

const quoteIdent = (name: string): string => `\`${name.replace(/`/g, '``')}\``

export function rowChangedError(label: string, affected: number): Error {
  return new Error(
    affected === 0
      ? `No se guardó nada: ${label} ya no existe o su clave ha cambiado. Recarga la tabla.`
      : `No se guardó nada: el cambio de ${label} afectaría a ${affected} filas en lugar de a una.`
  )
}

/**
 * MySQL / MariaDB sobre mysql2. Usa dos conexiones: una para las consultas del usuario
 * (conserva el estado de sesión: USE, variables, transacciones) y otra para metadatos
 * y para cancelar con KILL QUERY sin esperar a que termine la consulta en curso.
 */
export class MysqlDriver implements DbDriver {
  private query: Connection | null = null
  private meta: Connection | null = null
  private selectLimit: number | null = null
  private readonly target: string

  constructor(private readonly opts: DriverConnectOptions) {
    const { config } = opts
    this.target = opts.tunneled ? `${config.host}:${config.port} (vía SSH)` : `${config.host}:${config.port}`
  }

  async connect(): Promise<ServerInfo> {
    try {
      this.query = await this.open()
      this.meta = await this.open()
    } catch (err) {
      await this.close()
      throw friendlyDbError(err, this.target)
    }
    if (this.opts.config.readOnly) {
      // Defensa en profundidad: el servidor rechaza escrituras aunque el clasificador falle.
      await this.run(this.query, 'SET SESSION TRANSACTION READ ONLY')
    }
    const [row] = await this.metaRows<{ version: string; db: string | null }>('SELECT VERSION() AS version, DATABASE() AS db')
    const version = row?.version ?? ''
    return {
      product: /mariadb/i.test(version) ? 'MariaDB' : 'MySQL',
      version: version.replace(/-MariaDB.*$/i, ''),
      currentDatabase: row?.db ?? null
    }
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.metaRows<{ name: string }>('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME')
    return rows.map((r) => r.name)
  }

  async listTables(database: string): Promise<TableInfo[]> {
    const rows = await this.metaRows<{ name: string; type: string }>(
      'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [database]
    )
    return rows.map((r) => ({ schema: null, name: r.name, kind: /VIEW/i.test(r.type) ? 'view' : 'table' }))
  }

  async listColumns(database: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.metaRows<{ name: string; type: string; nullable: string; ckey: string; def: string | null; extra: string }>(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS ckey, COLUMN_DEFAULT AS def,
              EXTRA AS extra
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [database, table]
    )
    return rows.map((r) => ({
      name: r.name,
      dataType: String(r.type),
      nullable: r.nullable === 'YES',
      isPrimaryKey: r.ckey === 'PRI',
      defaultValue: r.def === null ? null : String(r.def),
      autoIncrement: /auto_increment/i.test(r.extra ?? '')
    }))
  }

  async completionColumns(database: string): Promise<CompletionColumn[]> {
    const rows = await this.metaRows<{ t: string; c: string; d: string }>(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 20000`,
      [database]
    )
    return rows.map((r) => ({ schema: null, table: r.t, column: r.c, dataType: String(r.d) }))
  }

  async listIndexes({ database, table }: TableRef): Promise<IndexInfo[]> {
    const rows = await this.metaRows<{ name: string; nonUnique: number | string; col: string }>(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
      [database, table]
    )
    return groupBy(rows, (r) => r.name).map(([name, cols]) => ({
      name,
      columns: cols.map((c) => c.col),
      unique: Number(cols[0]!.nonUnique) === 0,
      primary: name === 'PRIMARY'
    }))
  }

  async listForeignKeys({ database, table }: TableRef): Promise<ForeignKeyInfo[]> {
    const rows = await this.metaRows<{ name: string; col: string; refDb: string; refTable: string; refCol: string }>(
      `SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS col, REFERENCED_TABLE_SCHEMA AS refDb,
              REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refCol
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [database, table]
    )
    return groupBy(rows, (r) => r.name).map(([name, cols]) => ({
      name,
      columns: cols.map((c) => c.col),
      refDatabase: cols[0]!.refDb,
      refSchema: null,
      refTable: cols[0]!.refTable,
      refColumns: cols.map((c) => c.refCol)
    }))
  }

  async tableDdl({ database, table }: TableRef): Promise<string | null> {
    const [row] = await this.metaRows<Record<string, string>>(`SHOW CREATE TABLE ${quoteIdent(database)}.${quoteIdent(table)}`)
    // Para vistas, MySQL devuelve la columna "Create View" en lugar de "Create Table".
    return row?.['Create Table'] ?? row?.['Create View'] ?? null
  }

  async useDatabase(database: string): Promise<void> {
    await this.run(this.requireQuery(), `USE ${quoteIdent(database)}`)
  }

  async execute(statement: string, { maxRows }: ExecuteOptions): Promise<QueryResult[]> {
    const conn = this.requireQuery()
    // Como hace Connector/J con setMaxRows: el servidor corta los SELECT y no viajan filas de más.
    // Pedimos una fila extra para saber si el resultado se truncó.
    if (this.selectLimit !== maxRows + 1) {
      await this.run(conn, `SET SQL_SELECT_LIMIT = ${maxRows + 1}`)
      this.selectLimit = maxRows + 1
    }
    const started = performance.now()
    return new Promise((resolve, reject) => {
      const results: QueryResult[] = []
      let current: QueryResult | null = null
      const base = (): QueryResult => ({
        statement,
        columns: [],
        rows: [],
        affectedRows: null,
        truncated: false,
        durationMs: 0
      })

      const q = conn.query({ sql: statement, rowsAsArray: true })
      q.on('fields', (fields: FieldPacket[] | undefined) => {
        // mysql2 emite 'fields' sin columnas justo antes del OK de un INSERT/UPDATE.
        if (!fields) return
        current = base()
        current.columns = fields.map((f) => ({ name: f.name, type: sqlTypeName(f) }))
        results.push(current)
      })
      q.on('result', (row: unknown[] | ResultSetHeader) => {
        if (Array.isArray(row)) {
          if (!current) return
          if (current.rows.length >= maxRows) current.truncated = true
          else current.rows.push(row.map(normalizeValue))
        } else {
          current = null
          // Tras las filas de un CALL llega un OK final que no aporta nada al usuario.
          if (results.some((r) => r.columns.length > 0)) return
          results.push({ ...base(), affectedRows: row.affectedRows ?? 0 })
        }
      })
      q.on('error', (err: Error) => reject(err))
      q.on('end', () => {
        const durationMs = Math.round(performance.now() - started)
        for (const r of results) r.durationMs = durationMs
        resolve(results.length > 0 ? results : [{ ...base(), affectedRows: 0, durationMs }])
      })
    })
  }

  async executeChanges(statements: ParamStatement[]): Promise<void> {
    const conn = this.requireQuery()
    await this.run(conn, 'START TRANSACTION')
    try {
      for (const [i, st] of statements.entries()) {
        const label = st.label ?? `el cambio nº ${i + 1}`
        // Con FOUND_ROWS (activo por defecto en mysql2) cuenta filas encontradas, no solo modificadas.
        const header = await new Promise<ResultSetHeader>((resolve, reject) =>
          conn.query(st.sql, st.params, (err, result) => (err ? reject(err) : resolve(result as ResultSetHeader)))
        )
        if (header.affectedRows !== 1) throw rowChangedError(label, header.affectedRows)
      }
      await this.run(conn, 'COMMIT')
    } catch (err) {
      await this.run(conn, 'ROLLBACK').catch(() => {})
      throw err
    }
  }

  async cancel(): Promise<void> {
    const threadId = this.query?.threadId
    if (!threadId || !this.meta) return
    await this.run(this.meta, `KILL QUERY ${Number(threadId)}`)
  }

  async close(): Promise<void> {
    await Promise.all(
      [this.query, this.meta].map(
        (c) =>
          new Promise<void>((resolve) => {
            if (!c) return resolve()
            c.end(() => resolve())
            setTimeout(() => {
              c.destroy()
              resolve()
            }, 2000).unref()
          })
      )
    )
    this.query = null
    this.meta = null
  }

  private open(): Promise<Connection> {
    const { config, host, port, password, tunneled, ca } = this.opts
    const options: ConnectionOptions = {
      host,
      port,
      user: config.username,
      password,
      database: config.database,
      charset: 'utf8mb4',
      connectTimeout: 15_000,
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      // BIGINT como número salvo que no quepa sin perder precisión (entonces texto).
      bigNumberStrings: false,
      jsonStrings: true,
      enableKeepAlive: true
    }
    if (config.tls.enabled) {
      options.ssl = {
        rejectUnauthorized: config.tls.verifyServerCert,
        // Con túnel el host es 127.0.0.1 y no puede coincidir con el certificado: se valida la cadena, no el nombre.
        verifyIdentity: config.tls.verifyServerCert && !tunneled,
        ...(ca ? { ca } : {})
      }
    }
    return new Promise((resolve, reject) => {
      const conn = mysql.createConnection(options)
      conn.once('connect', () => {
        conn.removeAllListeners('error')
        conn.on('error', () => {})
        resolve(conn)
      })
      conn.once('error', reject)
    })
  }

  private requireQuery(): Connection {
    if (!this.query) throw new Error('La conexión está cerrada')
    return this.query
  }

  private run(conn: Connection | null, sql: string): Promise<void> {
    if (!conn) return Promise.reject(new Error('La conexión está cerrada'))
    return new Promise((resolve, reject) => conn.query(sql, (err) => (err ? reject(err) : resolve())))
  }

  private metaRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const conn = this.meta
    if (!conn) return Promise.reject(new Error('La conexión está cerrada'))
    return new Promise((resolve, reject) =>
      conn.query({ sql, values: params }, (err, rows) => (err ? reject(err) : resolve(rows as T[])))
    )
  }
}
