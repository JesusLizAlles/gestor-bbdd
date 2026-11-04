import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig, McpAccess, McpApprovalRequest, McpState, QueryResult, RunQueryInput } from '@shared/types'
import { buildMcpb, createZip, fillBridge } from '../src/main/mcp/bundle'
import { serverPort, startHttpServer, stopHttpServer } from '../src/main/mcp/http'
import { handleMessage, type ProtocolHandlers } from '../src/main/mcp/protocol'
import { McpService } from '../src/main/mcp/service'
import { effectiveAccess, McpSettingsStore } from '../src/main/mcp/settings'
import { callTool, toolDefinitions, type SessionApi, type ToolBackend } from '../src/main/mcp/tools'
import bridgeSource from '../src/mcp-bridge/bridge.cjs?raw'
import { baseConfig } from './helpers'

const BRIDGE_PATH = join(import.meta.dirname, '../src/mcp-bridge/bridge.cjs')

const result = (overrides: Partial<QueryResult> = {}): QueryResult => ({
  statement: 'SELECT 1',
  columns: [{ name: 'n', type: 'LONG' }],
  rows: [[1]],
  affectedRows: null,
  truncated: false,
  durationMs: 1,
  ...overrides
})

/** Backend de pega: registra lo que se ejecuta y aprueba según se le diga. */
function fakeBackend(list: { config: ConnectionConfig; access: McpAccess }[], { approve = true } = {}) {
  const runs: RunQueryInput[] = []
  const approvals: string[][] = []
  const db: SessionApi = {
    listDatabases: async () => ['hotel'],
    listTables: async () => [{ schema: null, name: 'reservas', kind: 'table' }],
    tableStructure: async () => ({ columns: [], indexes: [], foreignKeys: [], ddl: null }),
    completionColumns: async () => [
      { schema: null, table: 'clientes', column: 'email', dataType: 'varchar' },
      { schema: null, table: 'reservas', column: 'importe', dataType: 'decimal' }
    ],
    run: async (input) => {
      runs.push(input)
      return { results: [result({ statement: input.sql })] }
    }
  }
  const backend: ToolBackend = {
    connections: async () => list,
    withSession: (_config, task) => task(db),
    maxRows: async () => 100,
    approve: async (_config, _db, statements) => {
      approvals.push(statements)
      return approve
    }
  }
  return { backend, runs, approvals }
}

const dev = baseConfig({ id: 'c-dev', name: 'Hotel dev' })
const prod = baseConfig({ id: 'c-prod', name: 'Hotel prod', environment: 'prod' })

describe('effectiveAccess', () => {
  it('recorta el nivel según la conexión', () => {
    expect(effectiveAccess(dev, undefined)).toBe('off')
    expect(effectiveAccess(dev, 'write')).toBe('write')
    expect(effectiveAccess(prod, 'write')).toBe('confirm')
    expect(effectiveAccess(prod, 'confirm')).toBe('confirm')
    expect(effectiveAccess({ ...dev, readOnly: true }, 'write')).toBe('read')
    expect(effectiveAccess({ ...dev, readOnly: true }, 'confirm')).toBe('read')
  })
})

describe('herramientas', () => {
  it('list_connections solo enseña las que tienen acceso, sin secretos ni host', async () => {
    const { backend } = fakeBackend([
      { config: dev, access: 'read' },
      { config: prod, access: 'off' }
    ])
    const out = await callTool('list_connections', {}, backend)
    expect(out.isError).toBe(false)
    const parsed = JSON.parse(out.text)
    expect(parsed.connections.map((c: { name: string }) => c.name)).toEqual(['Hotel dev'])
    expect(out.text).not.toContain('127.0.0.1')
  })

  it('busca la conexión por nombre (sin mayúsculas) o id y explica cuáles hay', async () => {
    const { backend } = fakeBackend([{ config: dev, access: 'read' }])
    expect((await callTool('list_databases', { connection: 'hotel DEV' }, backend)).isError).toBe(false)
    expect((await callTool('list_databases', { connection: 'c-dev' }, backend)).isError).toBe(false)
    const missing = await callTool('list_databases', { connection: 'Hotel prod' }, backend)
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('«Hotel dev»')
  })

  it('run_query rechaza escrituras sin ejecutar nada', async () => {
    const { backend, runs } = fakeBackend([{ config: dev, access: 'write' }])
    for (const sql of ['DELETE FROM reservas', 'SELECT 1; UPDATE reservas SET importe = 0', 'SELECT * FROM t FOR UPDATE']) {
      const out = await callTool('run_query', { connection: 'Hotel dev', sql }, backend)
      expect(out.isError, sql).toBe(true)
      expect(out.outcome).toBe('blocked')
    }
    expect(runs).toEqual([])
  })

  it('run_query ejecuta lecturas con el límite de filas del usuario y marca el origen', async () => {
    const { backend, runs } = fakeBackend([{ config: dev, access: 'read' }])
    const out = await callTool('run_query', { connection: 'Hotel dev', sql: 'SELECT 1', database: 'hotel', max_rows: 5000 }, backend)
    expect(out.isError).toBe(false)
    expect(runs).toEqual([{ sql: 'SELECT 1', database: 'hotel', maxRows: 100, source: 'mcp' }])
    expect(JSON.parse(out.text).results[0]).toMatchObject({ columns: [{ name: 'n' }], rows: [[1]], row_count: 1 })
  })

  it('execute_sql: bloqueado con solo lectura, pide aprobación con confirm y no ejecuta si se rechaza', async () => {
    const read = fakeBackend([{ config: dev, access: 'read' }])
    const blocked = await callTool('execute_sql', { connection: 'Hotel dev', sql: 'DELETE FROM reservas' }, read.backend)
    expect(blocked).toMatchObject({ isError: true, outcome: 'blocked' })
    expect(read.runs).toEqual([])

    const rejected = fakeBackend([{ config: prod, access: 'confirm' }], { approve: false })
    const no = await callTool('execute_sql', { connection: 'Hotel prod', sql: 'DELETE FROM a; DELETE FROM b' }, rejected.backend)
    expect(no).toMatchObject({ isError: true, outcome: 'rejected' })
    expect(rejected.approvals).toEqual([['DELETE FROM a', 'DELETE FROM b']])
    expect(rejected.runs).toEqual([])

    const approved = fakeBackend([{ config: prod, access: 'confirm' }])
    const yes = await callTool('execute_sql', { connection: 'Hotel prod', sql: 'DELETE FROM a' }, approved.backend)
    expect(yes.isError).toBe(false)
    expect(approved.runs[0]).toMatchObject({ sql: 'DELETE FROM a', confirmedWrite: true, source: 'mcp' })
  })

  it('execute_sql con write no pregunta', async () => {
    const { backend, approvals, runs } = fakeBackend([{ config: dev, access: 'write' }])
    expect((await callTool('execute_sql', { connection: 'Hotel dev', sql: 'UPDATE t SET a = 1' }, backend)).isError).toBe(false)
    expect(approvals).toEqual([])
    expect(runs).toHaveLength(1)
  })

  it('search_columns busca en columnas y tablas', async () => {
    const { backend } = fakeBackend([{ config: dev, access: 'read' }])
    const out = await callTool('search_columns', { connection: 'Hotel dev', database: 'hotel', text: 'MAIL' }, backend)
    expect(JSON.parse(out.text).matches).toEqual([{ schema: null, table: 'clientes', column: 'email', type: 'varchar' }])
  })

  it('recorta celdas enormes y respuestas demasiado grandes', async () => {
    const { backend } = fakeBackend([{ config: dev, access: 'read' }])
    backend.withSession = (_c, task) =>
      task({
        run: async () => ({
          results: [result({ rows: Array.from({ length: 300 }, (_, i) => [i, 'x'.repeat(3000)]), columns: [{ name: 'id', type: 'LONG' }, { name: 't', type: 'TEXT' }] }), result({ rows: [['y'.repeat(10_000)]] })]
        })
      } as unknown as SessionApi)
    const out = await callTool('run_query', { connection: 'Hotel dev', sql: 'SELECT 1' }, backend)
    expect(out.text.length).toBeLessThanOrEqual(210_000)
    const [big, small] = JSON.parse(out.text).results
    expect(big.row_count).toBeLessThan(300)
    expect(big.truncated).toContain('demasiado grande')
    expect(small.rows[0][0]).toContain('[recortado: 10000 caracteres]')
  })

  it('argumentos no válidos vuelven como error de la herramienta', async () => {
    const { backend } = fakeBackend([{ config: dev, access: 'read' }])
    const out = await callTool('run_query', { connection: 'Hotel dev' }, backend)
    expect(out.isError).toBe(true)
    expect(out.text).toContain('sql')
  })

  it('las definiciones llevan JSON Schema y anotaciones', () => {
    const defs = toolDefinitions()
    expect(defs.map((d) => d.name)).toEqual([
      'list_connections',
      'list_databases',
      'list_tables',
      'describe_table',
      'search_columns',
      'run_query',
      'execute_sql'
    ])
    const run = defs.find((d) => d.name === 'run_query')!
    expect(run.inputSchema).toMatchObject({ type: 'object', required: ['connection', 'sql'] })
    expect(run.inputSchema).not.toHaveProperty('$schema')
    expect(run.annotations.readOnlyHint).toBe(true)
    expect(defs.find((d) => d.name === 'execute_sql')!.annotations.destructiveHint).toBe(true)
  })
})

const handlers: ProtocolHandlers = {
  serverVersion: '1.2.3',
  listTools: () => [{ name: 'x' }],
  callTool: async (name) => ({ content: [{ type: 'text', text: `hola ${name}` }], isError: false })
}

describe('protocolo', () => {
  it('initialize acepta versiones conocidas y si no ofrece la más nueva', async () => {
    const reply = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, handlers)) as {
      result: { protocolVersion: string; serverInfo: { version: string } }
    }
    expect(reply.result.protocolVersion).toBe('2025-03-26')
    expect(reply.result.serverInfo.version).toBe('1.2.3')
    const other = (await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, handlers)) as {
      result: { protocolVersion: string }
    }
    expect(other.result.protocolVersion).toBe('2025-11-25')
  })

  it('notificaciones sin respuesta, métodos desconocidos con error y lotes', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, handlers)).toBeNull()
    expect(await handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, handlers)).toMatchObject({ error: { code: -32601 } })
    expect(await handleMessage({ foo: 1 }, handlers)).toMatchObject({ error: { code: -32600 } })
    const batch = await handleMessage(
      [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'eco' } }
      ],
      handlers
    )
    expect(batch).toEqual([{ jsonrpc: '2.0', id: 'a', result: { content: [{ type: 'text', text: 'hola eco' }], isError: false } }])
  })
})

/** POST sin fetch para poder mandar cualquier Host. */
function post(port: number, body: unknown, headers: Record<string, string> = {}, method = 'POST') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

describe('servidor HTTP', () => {
  const TOKEN = 't'.repeat(43)
  let server: Server
  let port: number
  beforeEach(async () => {
    server = await startHttpServer({ port: 0, token: () => TOKEN, handlers })
    port = serverPort(server)
  })
  afterEach(() => stopHttpServer(server))

  const auth = { Authorization: `Bearer ${TOKEN}` }
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }

  it('exige el token', async () => {
    expect((await post(port, ping)).status).toBe(401)
    expect((await post(port, ping, { Authorization: 'Bearer otro' })).status).toBe(401)
    const ok = await post(port, ping, auth)
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body)).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  })

  it('rechaza Host y Origin ajenos (DNS rebinding, webs)', async () => {
    expect((await post(port, ping, { ...auth, Host: `evil.example:${port}` })).status).toBe(403)
    expect((await post(port, ping, { ...auth, Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(port, ping, { ...auth, Origin: `http://localhost:${port}` })).status).toBe(200)
  })

  it('202 para notificaciones, 405 para GET, 400 para JSON roto', async () => {
    expect((await post(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status).toBe(202)
    expect((await post(port, undefined, auth, 'GET')).status).toBe(405)
    const broken = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.end('{no es json')
    })
    expect(broken).toBe(400)
  })
})

/** Lanza el puente y le habla por stdin/stdout como lo haría Claude Desktop. */
async function talkToBridge(env: Record<string, string>, messages: unknown[]): Promise<Record<string, unknown>[]> {
  const child = spawn(process.execPath, [BRIDGE_PATH], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (c) => (out += c))
  for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n')
  child.stdin.end()
  await new Promise((resolve) => child.on('exit', resolve))
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

describe('puente de Claude Desktop', () => {
  let dir: string
  let server: Server
  const TOKEN = 'k'.repeat(43)
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-bbdd-mcp-'))
    server = await startHttpServer({ port: 0, token: () => TOKEN, handlers })
  })
  afterEach(async () => {
    await stopHttpServer(server)
    await rm(dir, { recursive: true, force: true })
  })

  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }

  it('reenvía a la app leyendo puerto y token de mcp.json', async () => {
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ enabled: true, port: serverPort(server), token: TOKEN }))
    const replies = await talkToBridge({ GESTOR_BBDD_DATA_DIR: dir }, [
      init,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'eco', arguments: {} } }
    ])
    expect(replies.find((r) => r.id === 1)).toMatchObject({ result: { protocolVersion: '2025-06-18', serverInfo: { version: '1.2.3' } } })
    expect(replies.find((r) => r.id === 2)).toMatchObject({ result: { content: [{ text: 'hola eco' }] } })
    expect(replies).toHaveLength(2)
  })

  it('con la app cerrada o el servidor desactivado contesta él mismo y explica qué hacer', async () => {
    const tools = toolDefinitions()
    const filled = join(dir, 'bridge.cjs')
    await writeFile(filled, fillBridge(bridgeSource, tools, '9.9.9'))
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ enabled: false, port: serverPort(server), token: TOKEN }))
    const child = spawn(process.execPath, [filled], { env: { GESTOR_BBDD_DATA_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stdin.end(
      [init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_query', arguments: {} } }]
        .map((m) => JSON.stringify(m))
        .join('\n') + '\n'
    )
    await new Promise((resolve) => child.on('exit', resolve))
    const replies = out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(replies.find((r) => r.id === 1).result.serverInfo.version).toBe('9.9.9')
    expect(replies.find((r) => r.id === 2).result.tools.map((t: { name: string }) => t.name)).toEqual(tools.map((t) => t.name))
    expect(replies.find((r) => r.id === 3).result).toMatchObject({ isError: true })
    expect(replies.find((r) => r.id === 3).result.content[0].text).toContain('Ajustes')
  })
})

describe('extensión .mcpb', () => {
  /** Lee un zip sencillo (sin zip64) para comprobar lo que genera createZip. */
  function unzip(buf: Buffer): Record<string, Buffer> {
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    const count = buf.readUInt16LE(end + 10)
    let p = buf.readUInt32LE(end + 16)
    const files: Record<string, Buffer> = {}
    for (let i = 0; i < count; i++) {
      expect(buf.readUInt32LE(p)).toBe(0x02014b50)
      const size = buf.readUInt32LE(p + 20)
      const nameLen = buf.readUInt16LE(p + 28)
      const extra = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
      const offset = buf.readUInt32LE(p + 42)
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString()
      const localName = buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28)
      files[name] = inflateRawSync(buf.subarray(offset + 30 + localName, offset + 30 + localName + size))
      p += 46 + nameLen + extra
    }
    return files
  }

  it('createZip produce un zip legible', () => {
    const files = unzip(createZip([{ name: 'a.txt', data: Buffer.from('hola') }, { name: 'dir/ñ.txt', data: Buffer.from('x'.repeat(1000)) }]))
    expect(files['a.txt']!.toString()).toBe('hola')
    expect(files['dir/ñ.txt']!.toString()).toBe('x'.repeat(1000))
  })

  it('lleva manifest, puente con las herramientas y la carpeta de datos', () => {
    const files = unzip(
      buildMcpb({ version: '1.0.0', dataDir: 'C:\\Users\\Ana\\AppData\\Roaming\\Gestor BBDD', bridgeSource, tools: toolDefinitions(), icon: Buffer.from('png') })
    )
    const manifest = JSON.parse(files['manifest.json']!.toString())
    expect(manifest).toMatchObject({
      manifest_version: '0.3',
      name: 'gestor-bbdd',
      version: '1.0.0',
      icon: 'icon.png',
      server: {
        type: 'node',
        entry_point: 'server/index.js',
        mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { GESTOR_BBDD_DATA_DIR: 'C:\\Users\\Ana\\AppData\\Roaming\\Gestor BBDD' } }
      }
    })
    expect(manifest.tools).toHaveLength(7)
    const bridge = files['server/index.js']!.toString()
    expect(bridge).toContain('"execute_sql"')
    expect(bridge).not.toContain('/*@@')
    expect(files['icon.png']!.toString()).toBe('png')
  })
})

describe('McpSettingsStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-bbdd-mcp-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('crea mcp.json con token y permisos 0600, desactivado por defecto', async () => {
    const store = new McpSettingsStore(dir)
    const file = await store.get()
    expect(file.enabled).toBe(false)
    expect(file.token.length).toBeGreaterThanOrEqual(43)
    const onDisk = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))
    expect(onDisk.token).toBe(file.token)
    if (process.platform !== 'win32') expect((await stat(join(dir, 'mcp.json'))).mode & 0o777).toBe(0o600)
    // Otra instancia lee el mismo token.
    expect((await new McpSettingsStore(dir).get()).token).toBe(file.token)
  })

  it('guarda solo los accesos distintos de off, olvida conexiones borradas y regenera el token', async () => {
    const store = new McpSettingsStore(dir)
    const { token } = await store.get()
    await store.save({ enabled: true, port: 40000, maxRows: 50, access: { a: 'read', b: 'off' } })
    expect((await store.get()).access).toEqual({ a: 'read' })
    await store.forgetConnection('a')
    expect((await new McpSettingsStore(dir).get()).access).toEqual({})
    expect((await store.regenerateToken()).token).not.toBe(token)
    await expect(store.save({ enabled: true, port: 80, maxRows: 50, access: {} })).rejects.toThrow()
  })
})

describe('McpService', () => {
  let dir: string
  let service: McpService
  let states: McpState[]
  let approvals: McpApprovalRequest[]
  let opened: number
  let failNext: boolean
  const runs: string[] = []
  const openedReadOnly: boolean[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-bbdd-mcp-'))
    states = []
    approvals = []
    opened = 0
    failNext = false
    runs.length = 0
    openedReadOnly.length = 0
    const settings = new McpSettingsStore(dir)
    service = new McpService({
      settings,
      connections: { list: async () => [dev, prod], secrets: async () => ({}) },
      sessions: {
        open: async (config) => {
          openedReadOnly.push(config.readOnly)
          return { sessionId: `s${++opened}`, connectionId: config.id, server: { product: 'x', version: '1', currentDatabase: null } }
        },
        close: async () => {},
        listDatabases: async () => {
          if (failNext) {
            failNext = false
            throw new Error('El túnel SSH se cerró. Vuelve a conectar.')
          }
          return ['hotel']
        },
        listTables: async () => [],
        tableStructure: async () => ({ columns: [], indexes: [], foreignKeys: [], ddl: null }),
        completionColumns: async () => [],
        run: async (_id, input) => {
          runs.push(input.sql)
          return { results: [result({ statement: input.sql, columns: [], rows: [], affectedRows: 1 })] }
        }
      },
      version: '1.0.0',
      logPath: join(dir, 'logs', 'mcp.log'),
      onState: (s) => states.push(s),
      onApproval: (r) => {
        approvals.push(r)
        return true
      }
    })
    await service.init()
  })
  afterEach(async () => {
    await service.stop()
    await rm(dir, { recursive: true, force: true })
  })

  async function call(state: McpState, name: string, args: unknown) {
    const res = await fetch(state.url!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    return ((await res.json()) as { result: { content: { text: string }[]; isError: boolean } }).result
  }

  it('arranca al activarlo, reutiliza la sesión del agente y reconecta si se cayó', async () => {
    expect((await service.state()).running).toBe(false)
    const state = await service.saveSettings({ enabled: true, port: 0 + 47_000 + Math.floor(Math.random() * 1000), maxRows: 10, access: { 'c-dev': 'read' } })
    expect(state.running).toBe(true)
    expect((await call(state, 'list_databases', { connection: 'Hotel dev' })).isError).toBe(false)
    expect((await call(state, 'list_databases', { connection: 'Hotel dev' })).isError).toBe(false)
    expect(opened).toBe(1)
    failNext = true
    expect((await call(state, 'list_databases', { connection: 'Hotel dev' })).isError).toBe(false)
    expect(opened).toBe(2)
    // Con solo lectura, la sesión del agente se abre como de solo lectura.
    expect(openedReadOnly).toEqual([true, true])
    // Al subir el nivel se reabre en modo escritura.
    const upgraded = await service.saveSettings({ ...state.settings, access: { 'c-dev': 'write' } })
    expect((await call(upgraded, 'list_databases', { connection: 'Hotel dev' })).isError).toBe(false)
    expect(openedReadOnly).toEqual([true, true, false])
    // La conexión de producción no tiene acceso: ni se ve.
    expect((await call(state, 'list_databases', { connection: 'Hotel prod' })).isError).toBe(true)
    const logLines = async () => (await readFile(join(dir, 'logs', 'mcp.log'), 'utf8').catch(() => '')).trim().split('\n').length
    await expect.poll(logLines).toBe(5)
    expect(states.at(-1)!.activity[0]!.tool).toBe('list_databases')
  })

  it('las escrituras en producción esperan a que el usuario las apruebe', async () => {
    const state = await service.saveSettings({ enabled: true, port: 46_000 + Math.floor(Math.random() * 1000), maxRows: 10, access: { 'c-prod': 'write' } })
    const pending = call(state, 'execute_sql', { connection: 'Hotel prod', sql: 'DELETE FROM reservas WHERE id = 1' })
    await expect.poll(() => approvals.length).toBe(1)
    expect(approvals[0]).toMatchObject({ connectionName: 'Hotel prod', environment: 'prod', statements: ['DELETE FROM reservas WHERE id = 1'] })
    expect((await service.state()).pendingApprovals).toEqual([approvals[0]!.id])
    expect(runs).toEqual([])
    service.respondApproval(approvals[0]!.id, true)
    expect((await pending).isError).toBe(false)
    expect(runs).toEqual(['DELETE FROM reservas WHERE id = 1'])

    const second = call(state, 'execute_sql', { connection: 'Hotel prod', sql: 'DROP TABLE reservas' })
    await expect.poll(() => approvals.length).toBe(2)
    service.respondApproval(approvals[1]!.id, false)
    expect(await second).toMatchObject({ isError: true })
    expect(runs).toHaveLength(1)
  })

  it('informa del puerto ocupado sin romperse', async () => {
    const other = await startHttpServer({ port: 0, token: () => 'x', handlers })
    const state = await service.saveSettings({ enabled: true, port: serverPort(other), maxRows: 10, access: {} })
    expect(state.running).toBe(false)
    expect(state.error).toContain('ya está en uso')
    await stopHttpServer(other)
  })
})
