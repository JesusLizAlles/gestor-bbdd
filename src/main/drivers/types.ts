import type {
  ColumnInfo,
  CompletionColumn,
  ConnectionConfig,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  ServerInfo,
  TableInfo,
  TableRef
} from '@shared/types'
import type { ParamStatement } from '@shared/table-query'

/** Parámetros ya resueltos para conectar: con túnel, host/port apuntan a 127.0.0.1:<puerto local>. */
export interface DriverConnectOptions {
  config: ConnectionConfig
  host: string
  port: number
  password: string
  tunneled: boolean
  /** Contenido PEM de la CA si la conexión la define. */
  ca?: string
}

export interface ExecuteOptions {
  maxRows: number
}

export interface DbDriver {
  connect(): Promise<ServerInfo>
  listDatabases(): Promise<string[]>
  listTables(database: string): Promise<TableInfo[]>
  listColumns(database: string, table: string, schema: string | null): Promise<ColumnInfo[]>
  completionColumns(database: string): Promise<CompletionColumn[]>
  listIndexes(ref: TableRef): Promise<IndexInfo[]>
  listForeignKeys(ref: TableRef): Promise<ForeignKeyInfo[]>
  /** CREATE TABLE/VIEW, o null si el motor no lo ofrece para ese objeto. */
  tableDdl(ref: TableRef): Promise<string | null>
  /** Cambia la base de datos activa de la conexión de consultas. */
  useDatabase(database: string): Promise<void>
  /**
   * Ejecuta los INSERT/UPDATE/DELETE en una transacción. Cada uno debe afectar exactamente a
   * una fila; si alguno no, se deshace todo y se lanza un error.
   */
  executeChanges(statements: ParamStatement[]): Promise<void>
  /** Ejecuta una sentencia; puede devolver varios resultados (procedimientos, lotes T-SQL). */
  execute(statement: string, options: ExecuteOptions): Promise<QueryResult[]>
  cancel(): Promise<void>
  close(): Promise<void>
}
