import sql, { type config as MssqlConfig, type ConnectionPool, type Request } from 'mssql'
import type {
  ColumnInfo,
  CompletionColumn,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  ResultColumn,
  ServerInfo,
  TableInfo,
  TableRef
} from '@shared/types'
import type { ParamStatement } from '@shared/table-query'
import { groupBy } from './group'
import { friendlyDbError } from './errors'
import type { DbDriver, DriverConnectOptions, ExecuteOptions } from './types'
import { normalizeValue } from './values'

const quoteIdent = (name: string): string => `[${name.replace(/]/g, ']]')}]`
const objectName = (database: string, schema: string | null, table: string): string =>
  [database, schema ?? 'dbo', table].map(quoteIdent).join('.')

interface MssqlColumnMeta {
  name: string
  type?: { declaration?: string }
}

/**
 * SQL Server sobre mssql/tedious. Igual que en MySQL, un pool de una sola conexión para
 * las consultas del usuario (mantiene USE, #temporales y transacciones entre ejecuciones)
 * y otro aparte para metadatos.
 */
export class MssqlDriver implements DbDriver {
  private query: ConnectionPool | null = null
  private meta: ConnectionPool | null = null
  private current: Request | null = null
  private userCancelled = false
  private readonly target: string

  constructor(private readonly opts: DriverConnectOptions) {
    const { config } = opts
    this.target = opts.tunneled ? `${config.host}:${config.port} (vía SSH)` : `${config.host}:${config.port}`
  }

  async connect(): Promise<ServerInfo> {
    try {
      this.query = await new sql.ConnectionPool(this.poolConfig(1)).connect()
      this.meta = await new sql.ConnectionPool(this.poolConfig(2)).connect()
    } catch (err) {
      await this.close()
      throw friendlyDbError(err, this.target)
    }
    const [row] = await this.metaRows<{ v: string; pv: string; db: string | null }>(
      "SELECT @@VERSION AS v, CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS pv, DB_NAME() AS db"
    )
    const edition = /Azure/i.test(row?.v ?? '') ? 'Azure SQL' : 'SQL Server'
    return { product: edition, version: row?.pv ?? '', currentDatabase: row?.db ?? null }
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.metaRows<{ name: string }>('SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name')
    return rows.map((r) => r.name)
  }

  async listTables(database: string): Promise<TableInfo[]> {
    const db = quoteIdent(database)
    const rows = await this.metaRows<{ s: string; name: string; type: string }>(
      `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS name, TABLE_TYPE AS type FROM ${db}.INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME`
    )
    return rows.map((r) => ({ schema: r.s, name: r.name, kind: /VIEW/i.test(r.type) ? 'view' : 'table' }))
  }

  async listColumns(database: string, table: string, schema: string | null): Promise<ColumnInfo[]> {
    const db = quoteIdent(database)
    const rows = await this.metaRows<{ name: string; dataType: string; nullable: string; def: string | null; pk: number; ident: number | null }>(
      `SELECT c.COLUMN_NAME AS name,
              c.DATA_TYPE + CASE
                WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN '(max)'
                WHEN c.CHARACTER_MAXIMUM_LENGTH IS NOT NULL THEN '(' + CAST(c.CHARACTER_MAXIMUM_LENGTH AS varchar(10)) + ')'
                WHEN c.DATA_TYPE IN ('decimal', 'numeric') THEN '(' + CAST(c.NUMERIC_PRECISION AS varchar(10)) + ',' + CAST(c.NUMERIC_SCALE AS varchar(10)) + ')'
                ELSE '' END AS dataType,
              c.IS_NULLABLE AS nullable,
              c.COLUMN_DEFAULT AS def,
              CASE WHEN EXISTS (
                SELECT 1 FROM ${db}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                  JOIN ${db}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
                    ON k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k.TABLE_SCHEMA = tc.TABLE_SCHEMA
                 WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = c.TABLE_SCHEMA
                   AND tc.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME
              ) THEN 1 ELSE 0 END AS pk,
              COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_CATALOG) + '.' + QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)),
                             c.COLUMN_NAME, 'IsIdentity') AS ident
         FROM ${db}.INFORMATION_SCHEMA.COLUMNS c
        WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
        ORDER BY c.ORDINAL_POSITION`,
      { schema: schema ?? 'dbo', table }
    )
    return rows.map((r) => ({
      name: r.name,
      dataType: r.dataType,
      nullable: r.nullable === 'YES',
      isPrimaryKey: r.pk === 1,
      defaultValue: r.def,
      autoIncrement: r.ident === 1
    }))
  }

  async completionColumns(database: string): Promise<CompletionColumn[]> {
    const rows = await this.metaRows<{ s: string; t: string; c: string; d: string }>(
      `SELECT TOP 20000 TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d
         FROM ${quoteIdent(database)}.INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`
    )
    return rows.map((r) => ({ schema: r.s, table: r.t, column: r.c, dataType: r.d }))
  }

  async listIndexes({ database, schema, table }: TableRef): Promise<IndexInfo[]> {
    const db = quoteIdent(database)
    const rows = await this.metaRows<{ name: string; uq: boolean; pk: boolean; col: string }>(
      `SELECT i.name AS name, i.is_unique AS uq, i.is_primary_key AS pk, c.name AS col
         FROM ${db}.sys.indexes i
         JOIN ${db}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN ${db}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.object_id = OBJECT_ID(@obj) AND i.name IS NOT NULL AND ic.is_included_column = 0
        ORDER BY i.is_primary_key DESC, i.name, ic.key_ordinal`,
      { obj: objectName(database, schema, table) }
    )
    return groupBy(rows, (r) => r.name).map(([name, cols]) => ({
      name,
      columns: cols.map((c) => c.col),
      unique: Boolean(cols[0]!.uq),
      primary: Boolean(cols[0]!.pk)
    }))
  }

  async listForeignKeys({ database, schema, table }: TableRef): Promise<ForeignKeyInfo[]> {
    const db = quoteIdent(database)
    const rows = await this.metaRows<{ name: string; col: string; refSchema: string; refTable: string; refCol: string }>(
      `SELECT fk.name AS name, pc.name AS col, rs.name AS refSchema, rt.name AS refTable, rc.name AS refCol
         FROM ${db}.sys.foreign_keys fk
         JOIN ${db}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN ${db}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
         JOIN ${db}.sys.objects rt ON rt.object_id = fkc.referenced_object_id
         JOIN ${db}.sys.schemas rs ON rs.schema_id = rt.schema_id
         JOIN ${db}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        WHERE fk.parent_object_id = OBJECT_ID(@obj)
        ORDER BY fk.name, fkc.constraint_column_id`,
      { obj: objectName(database, schema, table) }
    )
    return groupBy(rows, (r) => r.name).map(([name, cols]) => ({
      name,
      columns: cols.map((c) => c.col),
      refDatabase: database,
      refSchema: cols[0]!.refSchema,
      refTable: cols[0]!.refTable,
      refColumns: cols.map((c) => c.refCol)
    }))
  }

  async tableDdl({ database, schema, table }: TableRef): Promise<string | null> {
    // SQL Server no guarda el CREATE TABLE; solo la definición de vistas, procedimientos y funciones.
    const [row] = await this.metaRows<{ ddl: string | null }>('SELECT OBJECT_DEFINITION(OBJECT_ID(@obj)) AS ddl', {
      obj: objectName(database, schema, table)
    })
    return row?.ddl ?? null
  }

  async useDatabase(database: string): Promise<void> {
    await this.requireQuery().request().batch(`USE ${quoteIdent(database)}`)
  }

  execute(statement: string, { maxRows }: ExecuteOptions): Promise<QueryResult[]> {
    const request = this.requireQuery().request()
    request.stream = true
    request.arrayRowMode = true
    this.current = request
    this.userCancelled = false
    const started = performance.now()

    return new Promise((resolve, reject) => {
      const results: QueryResult[] = []
      let current: QueryResult | null = null
      let affected: number | null = null
      let truncatedByLimit = false
      let failure: Error | null = null

      request.on('recordset', (columns: MssqlColumnMeta[]) => {
        const cols: ResultColumn[] = columns.map((c) => ({ name: c.name, type: c.type?.declaration ?? '' }))
        current = { statement, columns: cols, rows: [], affectedRows: null, truncated: false, durationMs: 0 }
        results.push(current)
      })
      request.on('row', (row: unknown[]) => {
        if (!current) return
        if (current.rows.length >= maxRows) {
          current.truncated = true
          if (!truncatedByLimit) {
            // Cortamos en el servidor para no seguir recibiendo filas que vamos a descartar.
            truncatedByLimit = true
            request.cancel()
          }
          return
        }
        current.rows.push(row.map(normalizeValue))
      })
      request.on('rowsaffected', (count: number) => {
        affected = (affected ?? 0) + count
      })
      request.on('error', (err: Error & { code?: string }) => {
        if (err.code === 'ECANCEL' && truncatedByLimit && !this.userCancelled) return
        failure = err.code === 'ECANCEL' ? new Error('Consulta cancelada por el usuario') : err
      })
      request.on('done', () => {
        this.current = null
        if (failure) return reject(failure)
        const durationMs = Math.round(performance.now() - started)
        if (results.length === 0) {
          results.push({ statement, columns: [], rows: [], affectedRows: affected ?? 0, truncated: false, durationMs })
        }
        for (const r of results) r.durationMs = durationMs
        resolve(results)
      })
      // batch y no query: query usa sp_executesql y las #temporales morirían al terminar.
      void request.batch(statement)
    })
  }

  async executeChanges(statements: ParamStatement[]): Promise<void> {
    // Un solo lote: XACT_ABORT deshace la transacción entera ante cualquier error o THROW.
    const request = this.requireQuery().request()
    let index = 0
    const body = statements
      .map((st, i) => {
        for (const value of st.params) request.input(`p${index++}`, value)
        const label = (st.label ?? `el cambio nº ${i + 1}`).replace(/'/g, "''")
        return `${st.sql};\nIF @@ROWCOUNT <> 1 THROW 50001, N'No se guardó nada: ${label} ya no existe, su clave ha cambiado o afecta a varias filas. Recarga la tabla.', 1;`
      })
      .join('\n')
    await request.query(`SET XACT_ABORT ON;\nBEGIN TRANSACTION;\n${body}\nCOMMIT TRANSACTION;`)
  }

  async cancel(): Promise<void> {
    if (!this.current) return
    this.userCancelled = true
    this.current.cancel()
  }

  async close(): Promise<void> {
    await Promise.all([this.query?.close(), this.meta?.close()].map((p) => p?.catch(() => {})))
    this.query = null
    this.meta = null
  }

  private poolConfig(max: number): MssqlConfig {
    const { config, host, port, password, tunneled, ca } = this.opts
    // Las instancias con nombre se resuelven con SQL Browser (UDP 1434), que no atraviesa un túnel SSH.
    const useInstance = Boolean(config.instanceName) && !tunneled
    return {
      server: host,
      ...(useInstance ? {} : { port }),
      user: config.username,
      password,
      database: config.database,
      connectionTimeout: 15_000,
      requestTimeout: 0,
      pool: { max, min: 0, idleTimeoutMillis: 2_147_483_647 },
      options: {
        appName: 'Gestor BBDD',
        encrypt: config.tls.enabled,
        trustServerCertificate: !config.tls.verifyServerCert,
        // Con túnel, el certificado se valida contra el host real y no contra 127.0.0.1.
        ...(tunneled ? { serverName: config.host } : {}),
        ...(useInstance ? { instanceName: config.instanceName } : {}),
        ...(ca ? { cryptoCredentialsDetails: { ca } } : {}),
        useUTC: false,
        enableArithAbort: true
      }
    }
  }

  private requireQuery(): ConnectionPool {
    if (!this.query) throw new Error('La conexión está cerrada')
    return this.query
  }

  private async metaRows<T>(text: string, params: Record<string, string> = {}): Promise<T[]> {
    if (!this.meta) throw new Error('La conexión está cerrada')
    const request = this.meta.request()
    for (const [name, value] of Object.entries(params)) request.input(name, sql.NVarChar, value)
    const result = await request.query<T>(text)
    return result.recordset
  }
}
