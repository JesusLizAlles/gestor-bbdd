// Tipos compartidos entre el proceso principal, el preload y la interfaz.
// Nada de lo que hay aquí contiene secretos: las contraseñas nunca viajan al renderer.

export type Engine = 'mysql' | 'mssql'

export type Environment = 'dev' | 'test' | 'prod'

export type SshAuthMethod = 'password' | 'privateKey' | 'agent'

export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  username: string
  authMethod: SshAuthMethod
  /** Ruta absoluta a la clave privada (solo authMethod = privateKey). */
  privateKeyPath?: string
}

export interface TlsConfig {
  enabled: boolean
  /** false = aceptar cualquier certificado (útil con certificados autofirmados). */
  verifyServerCert: boolean
  /** Ruta a un fichero PEM con la CA (opcional). */
  caPath?: string
}

export interface ConnectionConfig {
  id: string
  name: string
  engine: Engine
  host: string
  port: number
  username: string
  /** Base de datos inicial (opcional). */
  database?: string
  /** Solo SQL Server: instancia con nombre. Se ignora con SSH (SQL Browser usa UDP). */
  instanceName?: string
  environment: Environment
  readOnly: boolean
  tls: TlsConfig
  ssh: SshConfig
}

export type SecretKey = 'password' | 'sshPassword' | 'sshPassphrase'

/**
 * Cambios de secretos al guardar una conexión:
 * undefined = dejar como está, null = borrar, string = nuevo valor.
 */
export type SecretsPatch = Partial<Record<SecretKey, string | null>>

export interface ConnectionSummary extends ConnectionConfig {
  storedSecrets: SecretKey[]
}

export interface SaveConnectionInput {
  config: Omit<ConnectionConfig, 'id'> & { id?: string }
  secrets?: SecretsPatch
}

export interface SecretStorageStatus {
  /** true si los secretos se cifran con el llavero del sistema y se guardan en disco. */
  persistent: boolean
  backend: string
}

export interface ServerInfo {
  product: string
  version: string
  currentDatabase: string | null
  /** Huella SHA256 de la clave del servidor SSH, si se usó túnel. */
  sshHostFingerprint?: string
}

export interface SessionInfo {
  sessionId: string
  connectionId: string
  server: ServerInfo
}

export type ObjectKind = 'table' | 'view'

export interface TableInfo {
  schema: string | null
  name: string
  kind: ObjectKind
}

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
  defaultValue: string | null
  /** AUTO_INCREMENT (MySQL) o IDENTITY (SQL Server): el servidor pone el valor al insertar. */
  autoIncrement: boolean
}

export interface CompletionColumn {
  schema: string | null
  table: string
  column: string
  dataType: string
}

/** Valores ya normalizados para viajar por IPC y pintarse sin conversiones. */
export type CellValue = string | number | boolean | null

export interface ResultColumn {
  name: string
  type: string
}

export interface QueryResult {
  statement: string
  columns: ResultColumn[]
  rows: CellValue[][]
  /** Filas afectadas para sentencias que no devuelven filas. */
  affectedRows: number | null
  /** true si se alcanzó el límite de filas y se descartó el resto. */
  truncated: boolean
  durationMs: number
  error?: string
}

export interface RunQueryInput {
  sql: string
  database?: string | null
  maxRows?: number
  /** El usuario confirmó ejecutar sentencias de escritura en una conexión de producción. */
  confirmedWrite?: boolean
}

export interface RunQueryOutput {
  results: QueryResult[]
  /** Si se bloqueó la ejecución, motivo legible para el usuario. */
  blocked?: 'readOnly' | 'needsConfirmation'
  blockedStatements?: string[]
}

/** Tabla o vista concreta dentro de una sesión. */
export interface TableRef {
  database: string
  schema: string | null
  table: string
}

export type SortDirection = 'asc' | 'desc'

export interface SortSpec {
  column: string
  direction: SortDirection
}

export interface TableDataInput extends TableRef {
  offset: number
  limit: number
  sort: SortSpec[]
  /** Condición WHERE escrita por el usuario (sin la palabra WHERE). Solo se admite lectura. */
  where?: string
}

export interface TablePage {
  columns: ResultColumn[]
  rows: CellValue[][]
  offset: number
  /** Hay más filas después de esta página. */
  hasMore: boolean
  durationMs: number
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
}

export interface ForeignKeyInfo {
  name: string
  columns: string[]
  /** Base de datos referenciada (MySQL permite FK entre bases de datos). */
  refDatabase: string
  refSchema: string | null
  refTable: string
  refColumns: string[]
}

export interface TableStructure {
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
  /** Sentencia CREATE si el motor la ofrece (MySQL siempre; SQL Server solo vistas). */
  ddl: string | null
}

export interface CellChange {
  column: string
  value: CellValue
}

/** Cambios de una fila: `key` identifica la fila por su clave primaria (valores originales). */
export interface RowUpdate {
  key: CellChange[]
  set: CellChange[]
}

/** Cambios de la rejilla que se guardan juntos, en una transacción. */
export interface RowChangesInput extends TableRef {
  updates?: RowUpdate[]
  /** Filas nuevas: columnas con valor; las que faltan toman su valor por defecto. */
  inserts?: CellChange[][]
  /** Filas a borrar, identificadas por su clave primaria (valores originales). */
  deletes?: CellChange[][]
  /** El usuario confirmó guardar en una conexión de producción. */
  confirmedWrite?: boolean
}

export interface RowChangesOutput {
  updated: number
  inserted: number
  deleted: number
  /** Conexión de producción sin confirmar: no se guardó nada y se devuelve qué se haría. */
  needsConfirmation?: boolean
  preview?: string[]
}

export interface ExportInput {
  defaultName: string
  format: 'csv' | 'json' | 'sql'
  content: string
}

/** API expuesta por el preload en window.api. */
export interface DbApi {
  secretStorageStatus(): Promise<SecretStorageStatus>
  listConnections(): Promise<ConnectionSummary[]>
  saveConnection(input: SaveConnectionInput): Promise<ConnectionSummary>
  deleteConnection(id: string): Promise<void>
  testConnection(input: SaveConnectionInput): Promise<ServerInfo>
  openSession(connectionId: string): Promise<SessionInfo>
  closeSession(sessionId: string): Promise<void>
  listDatabases(sessionId: string): Promise<string[]>
  listTables(sessionId: string, database: string): Promise<TableInfo[]>
  listColumns(sessionId: string, database: string, table: string, schema: string | null): Promise<ColumnInfo[]>
  completionColumns(sessionId: string, database: string): Promise<CompletionColumn[]>
  fetchTableData(sessionId: string, input: TableDataInput): Promise<TablePage>
  countTableRows(sessionId: string, input: TableRef & { where?: string }): Promise<number>
  tableStructure(sessionId: string, ref: TableRef): Promise<TableStructure>
  saveRowChanges(sessionId: string, input: RowChangesInput): Promise<RowChangesOutput>
  runQuery(sessionId: string, input: RunQueryInput): Promise<RunQueryOutput>
  cancelQuery(sessionId: string): Promise<void>
  exportFile(input: ExportInput): Promise<string | null>
  pickFile(title: string): Promise<string | null>
}

export const DEFAULT_MAX_ROWS = 500

export const PAGE_SIZES = [100, 500, 1000, 5000]

export const DEFAULT_PORTS: Record<Engine, number> = { mysql: 3306, mssql: 1433 }
