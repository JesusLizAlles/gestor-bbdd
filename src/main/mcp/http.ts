// Transporte «Streamable HTTP» de MCP, en su forma más simple: POST con JSON y respuesta JSON.
// Escucha solo en 127.0.0.1 y exige el token en cada petición.
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleMessage, RPC, type ProtocolHandlers } from './protocol'

export const MCP_PATH = '/mcp'
/** El SQL más largo que se admite por IPC ronda los 5 MB; con algo de margen para el JSON. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

export interface HttpOptions {
  port: number
  /** Se consulta en cada petición: regenerar el token surte efecto sin reiniciar. */
  token: () => string
  handlers: ProtocolHandlers
  /** Petición rechazada antes de llegar a MCP (token, origen…), para el registro. */
  onRejected?: (reason: string) => void
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Defensa contra DNS rebinding: una web que resuelva su dominio a 127.0.0.1 enviaría otro Host.
 * Y un navegador siempre manda Origin: si viene, debe ser local.
 */
function trustedHost(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

function trustedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  return origin === undefined || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(text)
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', id: null, error: { code, message } })

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too-large'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function startHttpServer(opts: HttpOptions): Promise<Server> {
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, rpcError(RPC.internalError, (err as Error).message))
      else res.end()
    })
  })

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0]
    if (!trustedHost(req, serverPort(server)) || !trustedOrigin(req)) {
      opts.onRejected?.(`Origen no permitido (Host: ${req.headers.host ?? '-'}, Origin: ${req.headers.origin ?? '-'})`)
      return send(res, 403, rpcError(RPC.invalidRequest, 'Origen no permitido'))
    }
    if (path !== MCP_PATH) return send(res, 404, rpcError(RPC.invalidRequest, `Ruta desconocida; el servidor MCP está en ${MCP_PATH}`))
    const auth = req.headers.authorization ?? ''
    const given = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? ''
    if (!sameToken(given, opts.token())) {
      opts.onRejected?.('Token ausente o incorrecto')
      return send(res, 401, rpcError(RPC.invalidRequest, 'Token ausente o incorrecto'), { 'WWW-Authenticate': 'Bearer' })
    }
    // Sin flujo de eventos del servidor (GET) ni sesiones (DELETE): todo va en la respuesta al POST.
    if (req.method !== 'POST') return send(res, 405, rpcError(RPC.invalidRequest, 'Solo se admite POST'), { Allow: 'POST' })
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return send(res, 415, rpcError(RPC.invalidRequest, 'El cuerpo debe ser application/json'))
    }

    let body: string
    try {
      body = await readBody(req)
    } catch {
      return send(res, 413, rpcError(RPC.invalidRequest, 'Petición demasiado grande'))
    }
    let message: unknown
    try {
      message = JSON.parse(body)
    } catch {
      return send(res, 400, rpcError(RPC.parseError, 'JSON no válido'))
    }
    const reply = await handleMessage(message, opts.handlers)
    if (reply === null) return send(res, 202)
    send(res, 200, reply)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}

export const serverPort = (server: Server): number => (server.address() as AddressInfo).port

export function stopHttpServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    // Conexiones keep-alive de los clientes: sin esto, close() esperaría a que caduquen.
    server.closeAllConnections()
  })
}
