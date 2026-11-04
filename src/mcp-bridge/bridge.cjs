#!/usr/bin/env node
// Puente stdio ↔ HTTP para Claude Desktop (extensión .mcpb de Gestor BBDD).
//
// Claude Desktop lanza este script y le habla MCP por stdin/stdout (un mensaje JSON por línea).
// Cada mensaje se reenvía al servidor MCP de Gestor BBDD (http://127.0.0.1:<puerto>/mcp) con el
// token, que se lee en cada petición del mcp.json de la app: cambiar el puerto o regenerar el
// token no obliga a reinstalar la extensión.
//
// Si la app está cerrada o el servidor desactivado, contesta él mismo: initialize y tools/list
// funcionan (con la lista de herramientas guardada al crear la extensión) y tools/call explica
// qué hacer, para que Claude no dé la extensión por rota.
//
// Variables de entorno (las pone el manifest):
//   GESTOR_BBDD_DATA_DIR   carpeta de datos de la app, donde está mcp.json
//   GESTOR_BBDD_URL, GESTOR_BBDD_TOKEN   alternativa sin fichero (p. ej. para pruebas)
'use strict'

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const readline = require('node:readline')

// Los rellena Gestor BBDD al crear la extensión.
const OFFLINE_TOOLS = /*@@TOOLS@@*/ []
const VERSION = /*@@VERSION@@*/ '0.0.0'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const OFFLINE_MESSAGE =
  'Gestor BBDD no está abierto o su servidor MCP está desactivado. Pide al usuario que abra Gestor BBDD y ' +
  'active el servidor en Ajustes → Servidor MCP; después vuelve a intentarlo.'
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000

const log = (...args) => process.stderr.write(`[gestor-bbdd] ${args.join(' ')}\n`)

/** Dónde y con qué token hablar con la app; null si está desactivado o sin configurar. */
function endpoint() {
  if (process.env.GESTOR_BBDD_URL && process.env.GESTOR_BBDD_TOKEN) {
    return { url: process.env.GESTOR_BBDD_URL, token: process.env.GESTOR_BBDD_TOKEN }
  }
  const dir = process.env.GESTOR_BBDD_DATA_DIR
  if (!dir) return null
  try {
    const file = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))
    if (!file.enabled || !file.token || !file.port) return null
    return { url: `http://127.0.0.1:${file.port}/mcp`, token: file.token }
  } catch {
    return null
  }
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })

/** Respuesta local cuando la app no está disponible. */
function answerOffline(msg, why) {
  if (msg.id === undefined) return
  switch (msg.method) {
    case 'initialize': {
      const wanted = msg.params && msg.params.protocolVersion
      return reply(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'gestor-bbdd', title: 'Gestor BBDD', version: VERSION },
        instructions: OFFLINE_MESSAGE
      })
    }
    case 'ping':
      return reply(msg.id, {})
    case 'tools/list':
      return reply(msg.id, { tools: OFFLINE_TOOLS })
    case 'tools/call':
      return reply(msg.id, { content: [{ type: 'text', text: why }], isError: true })
    default:
      return replyError(msg.id, -32601, `Método no soportado: ${msg.method}`)
  }
}

async function forward(msg) {
  const target = endpoint()
  if (!target) return answerOffline(msg, OFFLINE_MESSAGE)
  let res
  try {
    res = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${target.token}`
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (err) {
    log('sin conexión con la app:', err && err.cause ? err.cause.code || err.cause.message : err)
    return answerOffline(msg, OFFLINE_MESSAGE)
  }
  if (res.status === 202) return
  const text = await res.text()
  if (res.status === 401) {
    return answerOffline(msg, 'Gestor BBDD ha rechazado el token. Cierra y vuelve a abrir Claude Desktop; si sigue, vuelve a crear la extensión desde Ajustes → Servidor MCP.')
  }
  const type = res.headers.get('content-type') || ''
  if (type.includes('text/event-stream')) {
    // No lo usa Gestor BBDD, pero así el puente sirve con cualquier servidor Streamable HTTP.
    for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) process.stdout.write(line.slice(5).trim() + '\n')
    return
  }
  try {
    write(JSON.parse(text))
  } catch {
    if (msg.id !== undefined) replyError(msg.id, -32603, `Respuesta no válida de Gestor BBDD (HTTP ${res.status})`)
  }
}

let inFlight = 0
let closed = false
const exitIfDone = () => closed && inFlight === 0 && process.exit(0)

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return replyError(null, -32700, 'JSON no válido')
  }
  inFlight++
  forward(msg)
    .catch((err) => {
      log('error:', err && err.stack ? err.stack : err)
      if (msg && msg.id !== undefined) replyError(msg.id, -32603, String(err && err.message ? err.message : err))
    })
    .finally(() => {
      inFlight--
      exitIfDone()
    })
})
// Al cerrarse stdin se terminan de contestar las peticiones en curso antes de salir.
rl.on('close', () => {
  closed = true
  exitIfDone()
})
log(`puente ${VERSION} listo`)
