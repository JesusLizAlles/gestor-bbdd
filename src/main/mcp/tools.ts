// Herramientas que el servidor MCP ofrece a un agente. No saben nada de HTTP ni de JSON-RPC:
// reciben argumentos ya parseados y devuelven texto, para poder probarlas con un backend falso.
import { z } from 'zod'
import { isReadOnlyStatement, splitStatements } from '@shared/sql'
import type {
  CellValue,
  CompletionColumn,
  ConnectionConfig,
  McpAccess,
  QueryResult,
  RunQueryInput,
  RunQueryOutput,
  TableInfo,
  TableRef,
  TableStructure
} from '@shared/types'

/** Lo que las herramientas necesitan del resto de la app. */
export interface ToolBackend {
  /** Conexiones guardadas con su acceso efectivo (ya recortado por solo lectura y producción). */
  connections(): Promise<{ config: ConnectionConfig; access: McpAccess }[]>
  /** Ejecuta `task` con una sesión propia del agente para esa conexión (la abre si hace falta). */
  withSession<T>(config: ConnectionConfig, task: (db: SessionApi) => Promise<T>): Promise<T>
  maxRows(): Promise<number>
  /** Pide al usuario que apruebe una escritura; false si la rechaza o no responde a tiempo. */
  approve(config: ConnectionConfig, database: string | null, statements: string[]): Promise<boolean>
}

/** Operaciones de SessionManager sobre una sesión concreta. */
export interface SessionApi {
  listDatabases(): Promise<string[]>
  listTables(database: string): Promise<TableInfo[]>
  tableStructure(ref: TableRef): Promise<TableStructure>
  completionColumns(database: string): Promise<CompletionColumn[]>
  run(input: RunQueryInput): Promise<RunQueryOutput>
}

/** Error que se le explica al agente (isError en la respuesta), no un fallo del servidor. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly outcome: 'error' | 'blocked' | 'rejected' = 'error'
  ) {
    super(message)
  }
}

export interface ToolCallInfo {
  connection: string | null
  summary: string
}

interface ToolSpec<S extends z.ZodType> {
  name: string
  title: string
  description: string
  input: S
  readOnly: boolean
  destructive?: boolean
  /** Para el registro de actividad: conexión y resumen de lo pedido. */
  describe(args: z.infer<S>): ToolCallInfo
  run(args: z.infer<S>, backend: ToolBackend): Promise<unknown>
}

const ACCESS_TEXT: Record<McpAccess, string> = {
  off: 'sin acceso',
  read: 'solo lectura',
  confirm: 'lectura y escritura; cada escritura la aprueba el usuario',
  write: 'lectura y escritura sin confirmación'
}

/** Celdas de texto muy largas se recortan: un LONGTEXT de megas no aporta nada al agente. */
const MAX_CELL_CHARS = 4000
/** Tope de la respuesta entera (caracteres JSON); por encima se quitan filas del final. */
const MAX_RESPONSE_CHARS = 200_000

const connectionArg = z
  .string()
  .min(1)
  .max(255)
  .describe('Nombre (o id) de la conexión, tal como lo devuelve list_connections')
const databaseArg = z.string().min(1).max(256)

async function findConnection(backend: ToolBackend, wanted: string): Promise<{ config: ConnectionConfig; access: McpAccess }> {
  const visible = (await backend.connections()).filter((c) => c.access !== 'off')
  const byId = visible.find((c) => c.config.id === wanted)
  if (byId) return byId
  const matches = visible.filter((c) => c.config.name.toLowerCase() === wanted.trim().toLowerCase())
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) throw new ToolError(`Hay varias conexiones llamadas «${wanted}»: usa su id (${matches.map((m) => m.config.id).join(', ')})`)
  const names = visible.map((c) => `«${c.config.name}»`).join(', ')
  throw new ToolError(
    `No hay ninguna conexión «${wanted}» a la que tengas acceso.` + (names ? ` Disponibles: ${names}.` : ' El usuario no ha dado acceso a ninguna.')
  )
}

const clip = (value: CellValue): CellValue =>
  typeof value === 'string' && value.length > MAX_CELL_CHARS
    ? `${value.slice(0, MAX_CELL_CHARS)}… [recortado: ${value.length} caracteres]`
    : value

interface ResultOut {
  statement: string
  error?: string
  columns?: { name: string; type: string }[]
  rows?: CellValue[][]
  row_count?: number
  truncated?: string
  affected_rows?: number | null
  duration_ms: number
}

function formatResults(results: QueryResult[], maxRows: number): { results: ResultOut[] } {
  const out = results.map((r): ResultOut => {
    if (r.error) return { statement: r.statement, error: r.error, duration_ms: r.durationMs }
    if (r.columns.length === 0) return { statement: r.statement, affected_rows: r.affectedRows, duration_ms: r.durationMs }
    return {
      statement: r.statement,
      columns: r.columns.map((c) => ({ name: c.name, type: c.type })),
      rows: r.rows.map((row) => row.map(clip)),
      row_count: r.rows.length,
      ...(r.truncated ? { truncated: `Solo se devuelven las primeras ${maxRows} filas: usa LIMIT/TOP o filtra más` } : {}),
      duration_ms: r.durationMs
    }
  })
  // Si no cabe, se van quitando filas del resultado más grande hasta que quepa.
  while (JSON.stringify(out).length > MAX_RESPONSE_CHARS) {
    const biggest = out.filter((r) => (r.rows?.length ?? 0) > 1).sort((a, b) => b.rows!.length - a.rows!.length)[0]
    if (!biggest) break
    const keep = Math.max(1, Math.floor(biggest.rows!.length * 0.7))
    biggest.rows = biggest.rows!.slice(0, keep)
    biggest.row_count = keep
    biggest.truncated = `Respuesta demasiado grande: solo se devuelven ${keep} filas. Pide menos columnas o menos filas`
  }
  return { results: out }
}

function tableRef(config: ConnectionConfig, database: string, table: string, schema: string | undefined): TableRef {
  return { database, table, schema: schema ?? (config.engine === 'mssql' ? 'dbo' : null) }
}

const summarizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim().slice(0, 300)

function define<S extends z.ZodType>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec
}

const tools = [
  define({
    name: 'list_connections',
    title: 'Conexiones disponibles',
    description:
      'Lista las conexiones de base de datos a las que el usuario te ha dado acceso en Gestor BBDD, con su motor ' +
      '(mysql = MySQL/MariaDB, mssql = SQL Server), entorno (dev, test, prod) y nivel de acceso. Empieza siempre por aquí.',
    input: z.object({}),
    readOnly: true,
    describe: () => ({ connection: null, summary: '' }),
    async run(_args, backend) {
      const list = (await backend.connections()).filter((c) => c.access !== 'off')
      return {
        connections: list.map(({ config, access }) => ({
          name: config.name,
          id: config.id,
          engine: config.engine,
          environment: config.environment,
          access,
          access_description: ACCESS_TEXT[access],
          default_database: config.database ?? null
        }))
      }
    }
  }),
  define({
    name: 'list_databases',
    title: 'Bases de datos',
    description: 'Lista las bases de datos de una conexión.',
    input: z.object({ connection: connectionArg }),
    readOnly: true,
    describe: (a) => ({ connection: a.connection, summary: '' }),
    async run(args, backend) {
      const { config } = await findConnection(backend, args.connection)
      return { databases: await backend.withSession(config, (db) => db.listDatabases()) }
    }
  }),
  define({
    name: 'list_tables',
    title: 'Tablas y vistas',
    description: 'Lista las tablas y vistas de una base de datos (en SQL Server, con su esquema).',
    input: z.object({ connection: connectionArg, database: databaseArg.describe('Base de datos') }),
    readOnly: true,
    describe: (a) => ({ connection: a.connection, summary: a.database }),
    async run(args, backend) {
      const { config } = await findConnection(backend, args.connection)
      const tables = await backend.withSession(config, (db) => db.listTables(args.database))
      return { database: args.database, tables: tables.map((t) => ({ name: t.name, schema: t.schema, kind: t.kind })) }
    }
  }),
  define({
    name: 'describe_table',
    title: 'Estructura de una tabla',
    description: 'Columnas (tipo, nulos, clave primaria, valor por defecto), índices, claves foráneas y, si el motor lo da, el CREATE de una tabla o vista.',
    input: z.object({
      connection: connectionArg,
      database: databaseArg.describe('Base de datos'),
      table: z.string().min(1).max(256).describe('Nombre de la tabla o vista'),
      schema: z.string().min(1).max(256).optional().describe('Solo SQL Server: esquema (dbo si no se indica)')
    }),
    readOnly: true,
    describe: (a) => ({ connection: a.connection, summary: `${a.database}.${a.schema ? `${a.schema}.` : ''}${a.table}` }),
    async run(args, backend) {
      const { config } = await findConnection(backend, args.connection)
      const ref = tableRef(config, args.database, args.table, args.schema)
      const s = await backend.withSession(config, (db) => db.tableStructure(ref))
      if (s.columns.length === 0) throw new ToolError(`La tabla ${args.table} no existe en ${args.database} o no hay permisos para verla`)
      return {
        table: ref,
        columns: s.columns.map((c) => ({
          name: c.name,
          type: c.dataType,
          nullable: c.nullable,
          primary_key: c.isPrimaryKey,
          default: c.defaultValue,
          auto_increment: c.autoIncrement,
          ...(c.comment ? { comment: c.comment } : {}),
          ...(c.generated ? { generated: c.generated.expression } : {})
        })),
        indexes: s.indexes,
        foreign_keys: s.foreignKeys,
        ddl: s.ddl
      }
    }
  }),
  define({
    name: 'search_columns',
    title: 'Buscar columnas',
    description:
      'Busca en toda una base de datos las columnas cuyo nombre (o el de su tabla) contiene un texto, sin distinguir ' +
      'mayúsculas. Útil para encontrar dónde se guarda algo sin revisar tabla por tabla.',
    input: z.object({
      connection: connectionArg,
      database: databaseArg.describe('Base de datos'),
      text: z.string().min(1).max(100).describe('Texto a buscar en los nombres de columna y de tabla')
    }),
    readOnly: true,
    describe: (a) => ({ connection: a.connection, summary: `${a.database}: ${a.text}` }),
    async run(args, backend) {
      const { config } = await findConnection(backend, args.connection)
      const needle = args.text.toLowerCase()
      const columns = await backend.withSession(config, (db) => db.completionColumns(args.database))
      const found = columns.filter((c) => c.column.toLowerCase().includes(needle) || c.table.toLowerCase().includes(needle))
      return {
        matches: found.slice(0, 500).map((c) => ({ schema: c.schema, table: c.table, column: c.column, type: c.dataType })),
        ...(found.length > 500 ? { truncated: `Hay ${found.length} coincidencias; solo se devuelven 500. Busca algo más concreto` } : {})
      }
    }
  }),
  define({
    name: 'run_query',
    title: 'Consulta de lectura',
    description:
      'Ejecuta consultas de solo lectura (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN) y devuelve columnas y filas en JSON. ' +
      'Puede llevar varias sentencias separadas por «;». Rechaza cualquier escritura: para eso está execute_sql. ' +
      'Las filas tienen un máximo por consulta: usa LIMIT (MySQL) o TOP (SQL Server) y agrega en SQL en vez de traer tablas enteras.',
    input: z.object({
      connection: connectionArg,
      sql: z.string().min(1).max(1_000_000).describe('SQL en el dialecto del motor de la conexión'),
      database: databaseArg.optional().describe('Base de datos sobre la que se ejecuta (USE); si no, la por defecto de la conexión'),
      max_rows: z.number().int().min(1).optional().describe('Filas máximas por resultado (no puede pasar del límite que fijó el usuario)')
    }),
    readOnly: true,
    describe: (a) => ({ connection: a.connection, summary: summarizeSql(a.sql) }),
    async run(args, backend) {
      const { config } = await findConnection(backend, args.connection)
      const statements = splitStatements(args.sql, config.engine)
      if (statements.length === 0) throw new ToolError('No hay ninguna sentencia que ejecutar')
      const writes = statements.filter((s) => !isReadOnlyStatement(s.words))
      if (writes.length > 0) {
        throw new ToolError(
          `run_query solo admite lecturas y esto no lo es:\n${writes.map((w) => w.text).join('\n;\n')}\n` +
            'Si de verdad hay que modificar datos o estructura, usa execute_sql.',
          'blocked'
        )
      }
      const maxRows = Math.min(args.max_rows ?? Infinity, await backend.maxRows())
      const out = await backend.withSession(config, (db) =>
        db.run({ sql: args.sql, database: args.database ?? null, maxRows, source: 'mcp' })
      )
      return formatResults(out.results, maxRows)
    }
  }),
  define({
    name: 'execute_sql',
    title: 'Ejecutar SQL que modifica',
    description:
      'Ejecuta SQL que modifica datos o estructura (INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, EXEC…). Solo en conexiones ' +
      'con acceso de escritura. Con acceso «confirm» el usuario ve el SQL en Gestor BBDD y decide si se ejecuta; si lo ' +
      'rechaza, no insistas: pregunta qué quiere hacer. Se detiene en la primera sentencia que falle; en MySQL las ' +
      'anteriores no se deshacen. Antes de un UPDATE o DELETE comprueba con run_query cuántas filas afectará.',
    input: z.object({
      connection: connectionArg,
      sql: z.string().min(1).max(1_000_000).describe('SQL en el dialecto del motor de la conexión'),
      database: databaseArg.optional().describe('Base de datos sobre la que se ejecuta (USE); si no, la por defecto de la conexión')
    }),
    readOnly: false,
    destructive: true,
    describe: (a) => ({ connection: a.connection, summary: summarizeSql(a.sql) }),
    async run(args, backend) {
      const { config, access } = await findConnection(backend, args.connection)
      if (access === 'read') {
        throw new ToolError(`La conexión «${config.name}» es de solo lectura para el agente: el usuario no ha permitido escribir en ella`, 'blocked')
      }
      const statements = splitStatements(args.sql, config.engine)
      if (statements.length === 0) throw new ToolError('No hay ninguna sentencia que ejecutar')
      if (access === 'confirm') {
        const approved = await backend.approve(config, args.database ?? null, statements.map((s) => s.text))
        if (!approved) throw new ToolError('El usuario no ha aprobado este SQL: no se ha ejecutado nada', 'rejected')
      }
      const maxRows = await backend.maxRows()
      const out = await backend.withSession(config, (db) =>
        db.run({ sql: args.sql, database: args.database ?? null, maxRows, confirmedWrite: true, source: 'mcp' })
      )
      if (out.blocked) throw new ToolError('La conexión es de solo lectura: no se ha ejecutado nada', 'blocked')
      return formatResults(out.results, maxRows)
    }
  })
] as const

export interface ToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
}

/** Definiciones para tools/list (JSON Schema sacado de los esquemas zod). */
export function toolDefinitions(): ToolDefinition[] {
  return tools.map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: schema,
      annotations: {
        title: t.title,
        readOnlyHint: t.readOnly,
        destructiveHint: Boolean(t.destructive),
        idempotentHint: t.readOnly,
        openWorldHint: false
      }
    }
  })
}

export interface ToolOutcome {
  text: string
  isError: boolean
  outcome: 'ok' | 'error' | 'blocked' | 'rejected'
  info: ToolCallInfo
}

/** Ejecuta una herramienta. Los fallos esperables vuelven como texto con isError, no como excepción. */
export async function callTool(name: string, rawArgs: unknown, backend: ToolBackend): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === name) as ToolSpec<z.ZodType> | undefined
  if (!tool) throw new UnknownToolError(name)
  const parsed = tool.input.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'argumentos'}: ${i.message}`).join('; ')
    return { text: `Argumentos no válidos: ${issues}`, isError: true, outcome: 'error', info: { connection: null, summary: '' } }
  }
  const info = tool.describe(parsed.data)
  try {
    const result = await tool.run(parsed.data, backend)
    return { text: JSON.stringify(result), isError: false, outcome: 'ok', info }
  } catch (err) {
    const outcome = err instanceof ToolError ? err.outcome : 'error'
    return { text: (err as Error).message, isError: true, outcome, info }
  }
}

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`Herramienta desconocida: ${name}`)
  }
}
