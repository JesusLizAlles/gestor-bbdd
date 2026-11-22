// Servidor MCP de la app: arranca y para el HTTP según los ajustes, abre conexiones propias para el
// agente (no comparte las de las pestañas: un USE del agente no debe cambiar la base de datos de
// la consola del usuario), pide aprobación de escrituras y registra cada llamada.
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, stat, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Server } from 'node:http'
import type { ConnectionConfig, McpActivity, McpApprovalRequest, McpSettings, McpState, SecretKey, SessionInfo } from '@shared/types'
import type { SessionManager } from '../sessions'
import { MCP_PATH, serverPort, startHttpServer, stopHttpServer } from './http'
import { RPC, RpcError, type ProtocolHandlers } from './protocol'
import { effectiveAccess, type McpSettingsStore } from './settings'
import { callTool, toolDefinitions, UnknownToolError, type SessionApi, type ToolBackend } from './tools'

const MAX_ACTIVITY = 200
const MAX_LOG_BYTES = 5_000_000
/** Una conexión del agente sin usar se cierra pasado este tiempo. */
const IDLE_MS = 10 * 60 * 1000
/** Una escritura sin respuesta del usuario se da por rechazada. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

export interface McpServiceDeps {
  settings: McpSettingsStore
  connections: { list(): Promise<ConnectionConfig[]>; secrets(id: string): Promise<Partial<Record<SecretKey, string>>> }
  sessions: Pick<SessionManager, 'open' | 'close' | 'listDatabases' | 'listTables' | 'tableStructure' | 'completionColumns' | 'run'>
  version: string
  logPath: string
  /** Avisa a la interfaz de cualquier cambio (estado, actividad). */
  onState(state: McpState): void
  /** Pide a la interfaz que muestre la aprobación; false si no hay ventana que pueda hacerlo. */
  onApproval(request: McpApprovalRequest): boolean
}

interface AgentSession {
  info: SessionInfo
  idle: NodeJS.Timeout
}

export class McpService {
  private server: Server | null = null
  private error: string | null = null
  private activity: McpActivity[] = []
  private agentSessions = new Map<string, Promise<AgentSession>>()
  private approvals = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>()
  private token = ''
  /** Escrituras al registro, una detrás de otra. */
  private logQueue = Promise.resolve()

  constructor(private readonly deps: McpServiceDeps) {}

  /** Arranca el servidor si quedó activado la última vez. */
  async init(): Promise<void> {
    await this.apply()
  }

  async state(): Promise<McpState> {
    const { version: _v, token, ...settings } = await this.deps.settings.get()
    return {
      settings,
      token,
      running: this.server !== null,
      url: this.server ? `http://127.0.0.1:${serverPort(this.server)}${MCP_PATH}` : null,
      error: this.error,
      activity: this.activity,
      logPath: this.deps.logPath,
      pendingApprovals: [...this.approvals.keys()]
    }
  }

  async saveSettings(settings: McpSettings): Promise<McpState> {
    const before = await this.deps.settings.get()
    const after = await this.deps.settings.save(settings)
    // Si cambia el acceso a una conexión, lo que el agente tuviera abierto se cierra: sin acceso no
    // debe quedar nada, y con otro nivel se reabre en modo lectura o escritura según toque.
    for (const id of [...this.agentSessions.keys()]) {
      if ((after.access[id] ?? 'off') !== (before.access[id] ?? 'off')) await this.closeConnection(id)
    }
    await this.apply(before.port !== after.port)
    return this.publish()
  }

  async regenerateToken(): Promise<McpState> {
    await this.deps.settings.regenerateToken()
    await this.apply()
    return this.publish()
  }

  respondApproval(id: string, approved: boolean): void {
    const pending = this.approvals.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.approvals.delete(id)
    pending.resolve(approved)
  }

  /** La configuración de una conexión cambió o se borró: el agente reconectará con la nueva. */
  async closeConnection(connectionId: string): Promise<void> {
    const pending = this.agentSessions.get(connectionId)
    if (!pending) return
    this.agentSessions.delete(connectionId)
    const session = await pending.catch(() => null)
    if (session) {
      clearTimeout(session.idle)
      await this.deps.sessions.close(session.info.sessionId).catch(() => {})
    }
  }

  async stop(): Promise<void> {
    for (const id of [...this.approvals.keys()]) this.respondApproval(id, false)
    if (this.server) await stopHttpServer(this.server)
    this.server = null
    await Promise.all([...this.agentSessions.keys()].map((id) => this.closeConnection(id)))
  }

  /** Deja el servidor como dicen los ajustes. */
  private async apply(restart = false): Promise<void> {
    const file = await this.deps.settings.get()
    this.token = file.token
    if (!file.enabled) {
      await this.stop()
      this.error = null
      return
    }
    if (this.server && !restart) return
    if (this.server) {
      await stopHttpServer(this.server)
      this.server = null
    }
    try {
      this.server = await startHttpServer({
        port: file.port,
        token: () => this.token,
        handlers: this.handlers(),
        onRejected: (reason) => this.record({ tool: 'http', connection: null, summary: '', outcome: 'blocked', detail: reason, durationMs: 0 })
      })
      this.error = null
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      this.error =
        code === 'EADDRINUSE'
          ? `El puerto ${file.port} ya está en uso por otro programa. Elige otro.`
          : `No se pudo arrancar el servidor: ${(err as Error).message}`
    }
  }

  private handlers(): ProtocolHandlers {
    const backend = this.backend()
    return {
      serverVersion: this.deps.version,
      listTools: () => toolDefinitions(),
      callTool: async (name, args) => {
        const started = performance.now()
        try {
          const result = await callTool(name, args, backend)
          this.record({
            tool: name,
            connection: result.info.connection,
            summary: result.info.summary,
            outcome: result.outcome,
            ...(result.isError ? { detail: result.text.slice(0, 500) } : {}),
            durationMs: Math.round(performance.now() - started)
          })
          return { content: [{ type: 'text', text: result.text }], isError: result.isError }
        } catch (err) {
          if (err instanceof UnknownToolError) throw new RpcError(RPC.invalidParams, err.message)
          throw err
        }
      }
    }
  }

  private backend(): ToolBackend {
    return {
      connections: async () => {
        const { access } = await this.deps.settings.get()
        return (await this.deps.connections.list()).map((config) => ({ config, access: effectiveAccess(config, access[config.id]) }))
      },
      maxRows: async () => (await this.deps.settings.get()).maxRows,
      withSession: (config, task) => this.withSession(config, task),
      approve: (config, database, statements) => this.approve(config, database, statements)
    }
  }

  private async withSession<T>(config: ConnectionConfig, task: (db: SessionApi) => Promise<T>): Promise<T> {
    const attempt = async () => {
      const session = await this.agentSession(config)
      const id = session.info.sessionId
      // El plazo de inactividad cuenta desde que termina la operación, no desde que empieza.
      const done = () => session.idle.refresh()
      return task({
        listDatabases: () => this.deps.sessions.listDatabases(id),
        listTables: (database) => this.deps.sessions.listTables(id, database),
        tableStructure: (ref) => this.deps.sessions.tableStructure(id, ref),
        completionColumns: (database) => this.deps.sessions.completionColumns(id, database),
        run: (input) => this.deps.sessions.run(id, input)
      }).finally(done)
    }
    try {
      return await attempt()
    } catch (err) {
      // Sesión caída (túnel SSH cortado, servidor reiniciado…): esos errores salen antes de
      // ejecutar nada, así que se puede reconectar y repetir sin riesgo de hacerlo dos veces.
      if (!/vuelve a conectar\.?$/i.test((err as Error).message)) throw err
      await this.closeConnection(config.id)
      return attempt()
    }
  }

  private agentSession(config: ConnectionConfig): Promise<AgentSession> {
    let pending = this.agentSessions.get(config.id)
    if (!pending) {
      pending = (async () => {
        // Con acceso de solo lectura, la sesión del agente se abre como de solo lectura: en MySQL/MariaDB y
        // PostgreSQL eso pone las transacciones en READ ONLY, una segunda barrera en el propio servidor.
        const { access } = await this.deps.settings.get()
        const readOnly = config.readOnly || effectiveAccess(config, access[config.id]) === 'read'
        const info = await this.deps.sessions.open({ ...config, readOnly }, await this.deps.connections.secrets(config.id))
        return { info, idle: setTimeout(() => void this.closeConnection(config.id), IDLE_MS) }
      })()
      this.agentSessions.set(config.id, pending)
      // Si no llega a conectar, el siguiente intento vuelve a probar.
      pending.catch(() => {
        if (this.agentSessions.get(config.id) === pending) this.agentSessions.delete(config.id)
      })
    }
    return pending.then((session) => {
      session.idle.refresh()
      return session
    })
  }

  private approve(config: ConnectionConfig, database: string | null, statements: string[]): Promise<boolean> {
    const request: McpApprovalRequest = {
      id: randomUUID(),
      connectionName: config.name,
      environment: config.environment,
      database,
      statements
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.respondApproval(request.id, false), APPROVAL_TIMEOUT_MS)
      this.approvals.set(request.id, { resolve, timer })
      if (!this.deps.onApproval(request)) this.respondApproval(request.id, false)
    })
  }

  private record(entry: Omit<McpActivity, 'id' | 'at'>): void {
    const item: McpActivity = { id: randomUUID(), at: new Date().toISOString(), ...entry }
    this.activity = [item, ...this.activity].slice(0, MAX_ACTIVITY)
    this.logQueue = this.logQueue.then(() => this.appendLog(item))
    void this.publish()
  }

  private async appendLog(item: McpActivity): Promise<void> {
    const { logPath } = this.deps
    try {
      await mkdir(dirname(logPath), { recursive: true })
      const size = await stat(logPath).then((s) => s.size, () => 0)
      if (size > MAX_LOG_BYTES) await truncate(logPath, 0)
      await appendFile(logPath, JSON.stringify(item) + '\n', { mode: 0o600 })
    } catch {
      // El registro nunca debe hacer fallar al agente.
    }
  }

  private async publish(): Promise<McpState> {
    const state = await this.state()
    this.deps.onState(state)
    return state
  }
}
