import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type {
  CellChange,
  ColumnInfo,
  CompletionColumn,
  ConnectionConfig,
  QueryResult,
  RunQueryInput,
  RunQueryOutput,
  SecretKey,
  ServerInfo,
  SessionInfo,
  TableDataInput,
  TableInfo,
  TablePage,
  TableRef,
  TableStructure,
  UpdateRowsInput,
  UpdateRowsOutput
} from '@shared/types'
import { DEFAULT_MAX_ROWS } from '@shared/types'
import { isReadOnlyStatement, splitStatements } from '@shared/sql'
import {
  buildCountQuery,
  buildPageQuery,
  buildUpdate,
  mssqlDateParam,
  previewUpdate,
  validateWhere,
  type ParamStatement
} from '@shared/table-query'
import type { DriverFactory } from './drivers'
import type { DbDriver } from './drivers/types'
import type { KnownHosts } from './ssh/known-hosts'
import { openSshTunnel, type SshAuth, type Tunnel } from './ssh/tunnel'

type Secrets = Partial<Record<SecretKey, string>>

interface Session {
  id: string
  config: ConnectionConfig
  driver: DbDriver
  tunnel: Tunnel | null
  running: boolean
  broken: string | null
  /** Cola de la conexión de consultas: cada operación espera a la anterior. */
  queue: Promise<void>
  /** Columnas por tabla, para validar el orden y paginar por clave primaria. */
  columns: Map<string, ColumnInfo[]>
}

const refKey = (ref: TableRef): string => `${ref.database}\u0000${ref.schema ?? ''}\u0000${ref.table}`

export interface SessionDeps {
  createDriver: DriverFactory
  knownHosts: KnownHosts
  /** Socket del agente SSH (SSH_AUTH_SOCK); inyectable para tests. */
  agentSocket?: string
}

/** Abre conexiones (con túnel si procede) y ejecuta consultas sobre ellas. */
export class SessionManager {
  private sessions = new Map<string, Session>()

  constructor(private readonly deps: SessionDeps) {}

  async open(config: ConnectionConfig, secrets: Secrets): Promise<SessionInfo> {
    const { driver, tunnel, server } = await this.connect(config, secrets)
    const session: Session = {
      id: randomUUID(),
      config,
      driver,
      tunnel,
      running: false,
      broken: null,
      queue: Promise.resolve(),
      columns: new Map()
    }
    tunnel?.onUnexpectedClose((reason) => {
      session.broken = reason
    })
    this.sessions.set(session.id, session)
    return { sessionId: session.id, connectionId: config.id, server }
  }

  /** Prueba una configuración (aunque no esté guardada) y cierra todo al terminar. */
  async test(config: ConnectionConfig, secrets: Secrets): Promise<ServerInfo> {
    const { driver, tunnel, server } = await this.connect(config, secrets)
    await driver.close()
    await tunnel?.close()
    return server
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    await session.driver.close().catch(() => {})
    await session.tunnel?.close()
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }

  listDatabases(sessionId: string): Promise<string[]> {
    return this.get(sessionId).driver.listDatabases()
  }

  listTables(sessionId: string, database: string): Promise<TableInfo[]> {
    return this.get(sessionId).driver.listTables(database)
  }

  listColumns(sessionId: string, database: string, table: string, schema: string | null): Promise<ColumnInfo[]> {
    return this.get(sessionId).driver.listColumns(database, table, schema)
  }

  completionColumns(sessionId: string, database: string): Promise<CompletionColumn[]> {
    return this.get(sessionId).driver.completionColumns(database)
  }

  async run(sessionId: string, input: RunQueryInput): Promise<RunQueryOutput> {
    const session = this.get(sessionId)
    const { config, driver } = session
    const statements = splitStatements(input.sql, config.engine)
    if (statements.length === 0) return { results: [] }

    const writes = statements.filter((s) => !isReadOnlyStatement(s.words)).map((s) => s.text)
    if (writes.length > 0 && config.readOnly) {
      return { results: [], blocked: 'readOnly', blockedStatements: writes }
    }
    if (writes.length > 0 && config.environment === 'prod' && !input.confirmedWrite) {
      return { results: [], blocked: 'needsConfirmation', blockedStatements: writes }
    }

    // Si hay algo en marcha en esta conexión (otra pestaña, otra consola), espera su turno.
    return this.exclusive(session, async () => {
      const results: QueryResult[] = []
      if (input.database) await driver.useDatabase(input.database)
      const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS
      for (const statement of statements) {
        const started = performance.now()
        try {
          results.push(...(await driver.execute(statement.text, { maxRows })))
        } catch (err) {
          // Igual que un cliente SQL: se para en el primer error y se informa de qué sentencia falló.
          results.push({
            statement: statement.text,
            columns: [],
            rows: [],
            affectedRows: null,
            truncated: false,
            durationMs: Math.round(performance.now() - started),
            error: (err as Error).message
          })
          break
        }
      }
      return { results }
    })
  }

  /** Una página de datos de una tabla, con el SQL generado aquí y nunca en la interfaz. */
  async fetchTableData(sessionId: string, input: TableDataInput): Promise<TablePage> {
    const session = this.get(sessionId)
    const { engine } = session.config
    const ref: TableRef = { database: input.database, schema: input.schema, table: input.table }
    const where = validateWhere(input.where, engine)
    const columns = await this.tableColumns(session, ref)
    for (const s of input.sort) {
      if (!columns.some((c) => c.name === s.column)) throw new Error(`La columna ${s.column} no existe en ${input.table}`)
    }
    const sql = buildPageQuery(engine, ref, {
      where,
      sort: input.sort,
      fallbackOrder: columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
      offset: input.offset,
      limit: input.limit
    })
    const started = performance.now()
    const [result] = await this.exclusive(session, () => session.driver.execute(sql, { maxRows: input.limit + 1 }))
    const rows = result?.rows ?? []
    return {
      columns: result?.columns ?? [],
      rows: rows.slice(0, input.limit),
      offset: input.offset,
      hasMore: rows.length > input.limit,
      durationMs: Math.round(performance.now() - started)
    }
  }

  async countTableRows(sessionId: string, input: TableRef & { where?: string }): Promise<number> {
    const session = this.get(sessionId)
    const sql = buildCountQuery(session.config.engine, input, validateWhere(input.where, session.config.engine))
    const [result] = await this.exclusive(session, () => session.driver.execute(sql, { maxRows: 1 }))
    return Number(result?.rows[0]?.[0] ?? 0)
  }

  /** Guarda cambios hechos en la rejilla: un UPDATE por fila, localizada por su clave primaria. */
  async updateRows(sessionId: string, input: UpdateRowsInput): Promise<UpdateRowsOutput> {
    const session = this.get(sessionId)
    const { engine, readOnly, environment } = session.config
    if (readOnly) throw new Error('Conexión de solo lectura: no se pueden guardar cambios')
    if (input.updates.length === 0) return { applied: 0 }

    const ref: TableRef = { database: input.database, schema: input.schema, table: input.table }
    const columns = await this.tableColumns(session, ref)
    const pk = columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
    if (pk.length === 0) throw new Error(`${ref.table} no tiene clave primaria: no se puede editar desde la rejilla`)
    const types = new Map(columns.map((c) => [c.name, c.dataType]))

    const updates = input.updates.map((u) => {
      const keyColumns = u.key.map((k) => k.column).sort()
      if (keyColumns.join('\u0000') !== [...pk].sort().join('\u0000')) {
        throw new Error('Cada cambio debe identificar la fila por toda su clave primaria')
      }
      if (u.set.length === 0) throw new Error('Hay un cambio sin columnas que modificar')
      for (const c of u.set) if (!types.has(c.column)) throw new Error(`La columna ${c.column} no existe en ${ref.table}`)
      const fix = (c: CellChange): CellChange => ({
        column: c.column,
        value: engine === 'mssql' ? mssqlDateParam(c.value, types.get(c.column)) : c.value
      })
      return { key: u.key.map(fix), set: u.set.map(fix) }
    })

    if (environment === 'prod' && !input.confirmedWrite) {
      return { applied: 0, needsConfirmation: true, preview: updates.map((u) => previewUpdate(engine, ref, u)) }
    }

    let paramIndex = 0
    const statements: ParamStatement[] = updates.map((u) => {
      const st = buildUpdate(engine, ref, u, paramIndex)
      paramIndex += st.params.length
      return st
    })
    await this.exclusive(session, () => session.driver.executeUpdates(statements))
    return { applied: statements.length }
  }

  async tableStructure(sessionId: string, ref: TableRef): Promise<TableStructure> {
    const { driver, columns: cache } = this.get(sessionId)
    const [columns, indexes, foreignKeys, ddl] = await Promise.all([
      driver.listColumns(ref.database, ref.table, ref.schema),
      driver.listIndexes(ref),
      driver.listForeignKeys(ref),
      driver.tableDdl(ref).catch(() => null)
    ])
    cache.set(refKey(ref), columns)
    return { columns, indexes, foreignKeys, ddl }
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.get(sessionId)
    if (session.running) await session.driver.cancel()
  }

  private async tableColumns(session: Session, ref: TableRef): Promise<ColumnInfo[]> {
    const key = refKey(ref)
    let columns = session.columns.get(key)
    if (!columns) {
      columns = await session.driver.listColumns(ref.database, ref.table, ref.schema)
      if (columns.length === 0) throw new Error(`La tabla ${ref.table} no existe o no tienes permisos`)
      session.columns.set(key, columns)
    }
    return columns
  }

  /** Serializa el uso de la conexión de consultas: varias pestañas de la misma conexión esperan turno. */
  private async exclusive<T>(session: Session, task: () => Promise<T>): Promise<T> {
    const previous = session.queue
    let release!: () => void
    session.queue = new Promise<void>((resolve) => (release = resolve))
    await previous
    session.running = true
    try {
      return await task()
    } finally {
      session.running = false
      release()
    }
  }

  private get(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('La sesión ya no existe; vuelve a conectar')
    if (session.broken) throw new Error(`${session.broken}. Vuelve a conectar.`)
    return session
  }

  private async connect(
    config: ConnectionConfig,
    secrets: Secrets
  ): Promise<{ driver: DbDriver; tunnel: Tunnel | null; server: ServerInfo }> {
    let tunnel: Tunnel | null = null
    if (config.ssh.enabled) {
      tunnel = await openSshTunnel({
        sshHost: config.ssh.host,
        sshPort: config.ssh.port,
        username: config.ssh.username,
        auth: await this.sshAuth(config, secrets),
        dstHost: config.host,
        dstPort: config.port,
        knownHosts: this.deps.knownHosts
      })
    }
    let driver: DbDriver | null = null
    try {
      const ca = config.tls.enabled && config.tls.caPath ? await readFile(config.tls.caPath, 'utf8') : undefined
      driver = this.deps.createDriver({
        config,
        host: tunnel ? '127.0.0.1' : config.host,
        port: tunnel ? tunnel.localPort : config.port,
        password: secrets.password ?? '',
        tunneled: Boolean(tunnel),
        ca
      })
      const server = await driver.connect()
      if (tunnel) server.sshHostFingerprint = tunnel.fingerprint
      return { driver, tunnel, server }
    } catch (err) {
      await driver?.close().catch(() => {})
      const forwardError = tunnel?.lastForwardError()
      await tunnel?.close()
      if (forwardError) {
        throw new Error(
          `El servidor SSH no pudo conectar con ${config.host}:${config.port} (${forwardError}). ` +
            'Recuerda que ese servidor y puerto se resuelven desde la máquina SSH.'
        )
      }
      throw err
    }
  }

  private async sshAuth(config: ConnectionConfig, secrets: Secrets): Promise<SshAuth> {
    switch (config.ssh.authMethod) {
      case 'password':
        return { method: 'password', password: secrets.sshPassword ?? '' }
      case 'privateKey': {
        const path = (config.ssh.privateKeyPath ?? '').replace(/^~(?=$|[\\/])/, homedir())
        const privateKey = await readFile(path).catch(() => {
          throw new Error(`No se puede leer la clave privada ${path}`)
        })
        return { method: 'privateKey', privateKey, passphrase: secrets.sshPassphrase }
      }
      case 'agent': {
        const agentSocket =
          this.deps.agentSocket ??
          process.env.SSH_AUTH_SOCK ??
          (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
        if (!agentSocket) throw new Error('No hay agente SSH disponible (SSH_AUTH_SOCK vacío)')
        return { method: 'agent', agentSocket }
      }
    }
  }
}
