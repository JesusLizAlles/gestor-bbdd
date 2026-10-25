import { createServer, type Server, type Socket } from 'node:net'
import { Client, type ConnectConfig } from 'ssh2'
import { fingerprintOf, type KnownHosts } from './known-hosts'

export type SshAuth =
  | { method: 'password'; password: string }
  | { method: 'privateKey'; privateKey: Buffer; passphrase?: string }
  | { method: 'agent'; agentSocket: string }

export interface TunnelOptions {
  sshHost: string
  sshPort: number
  username: string
  auth: SshAuth
  /** Destino visto desde el servidor SSH (p. ej. 127.0.0.1 si la BD está en la misma máquina). */
  dstHost: string
  dstPort: number
  knownHosts: KnownHosts
  readyTimeoutMs?: number
}

export interface Tunnel {
  /** Puerto en 127.0.0.1 al que debe conectar el driver. */
  localPort: number
  fingerprint: string
  /** Último error al abrir un canal hacia el destino (p. ej. el servidor SSH no llega a la BD). */
  lastForwardError(): string | null
  close(): Promise<void>
  /** Se llama una vez si el túnel se cae por su cuenta (no al cerrarlo nosotros). */
  onUnexpectedClose(listener: (reason: string) => void): void
}

export class SshTunnelError extends Error {
  constructor(message: string, readonly code: 'HOST_KEY_CHANGED' | 'AUTH' | 'NETWORK' | 'FORWARD') {
    super(message)
    this.name = 'SshTunnelError'
  }
}

function describeError(err: Error & { level?: string; code?: string }, host: string, port: number): SshTunnelError {
  if (err.level === 'client-authentication') {
    return new SshTunnelError('Autenticación SSH rechazada: revisa usuario, contraseña o clave', 'AUTH')
  }
  if (/passphrase|encrypted private key/i.test(err.message)) {
    return new SshTunnelError('No se pudo descifrar la clave privada: revisa la frase de paso', 'AUTH')
  }
  switch (err.code) {
    case 'ECONNREFUSED':
      return new SshTunnelError(`El servidor SSH ${host}:${port} rechazó la conexión`, 'NETWORK')
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new SshTunnelError(`No se encuentra el servidor SSH ${host}`, 'NETWORK')
    case 'ETIMEDOUT':
      return new SshTunnelError(`Tiempo de espera agotado conectando a ${host}:${port}`, 'NETWORK')
  }
  if (/timed out while waiting for handshake/i.test(err.message)) {
    return new SshTunnelError(`Tiempo de espera agotado en la negociación SSH con ${host}:${port}`, 'NETWORK')
  }
  return new SshTunnelError(`Error SSH: ${err.message}`, 'NETWORK')
}

/**
 * Abre una conexión SSH y un servidor local en 127.0.0.1:<puerto libre> que reenvía
 * cada conexión entrante a dstHost:dstPort a través del servidor SSH (ssh -L).
 */
export async function openSshTunnel(opts: TunnelOptions): Promise<Tunnel> {
  const client = new Client()
  let fingerprint = ''
  let hostKeyChanged = false

  const config: ConnectConfig = {
    host: opts.sshHost,
    port: opts.sshPort,
    username: opts.username,
    readyTimeout: opts.readyTimeoutMs ?? 20_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,
    hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
      fingerprint = fingerprintOf(key)
      opts.knownHosts
        .check(opts.sshHost, opts.sshPort, fingerprint)
        .then(async (result) => {
          if (result === 'changed') {
            hostKeyChanged = true
            verify(false)
            return
          }
          if (result === 'new') await opts.knownHosts.remember(opts.sshHost, opts.sshPort, fingerprint)
          verify(true)
        })
        .catch(() => verify(false))
    }
  }
  if (opts.auth.method === 'password') config.password = opts.auth.password
  if (opts.auth.method === 'privateKey') {
    config.privateKey = opts.auth.privateKey
    if (opts.auth.passphrase) config.passphrase = opts.auth.passphrase
  }
  if (opts.auth.method === 'agent') config.agent = opts.auth.agentSocket

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      client.removeListener('ready', onReady)
      client.end()
      if (hostKeyChanged) {
        reject(
          new SshTunnelError(
            `La huella del servidor SSH ${opts.sshHost}:${opts.sshPort} ha cambiado (${fingerprint}). ` +
              'Puede ser un ataque de intermediario o una reinstalación del servidor.',
            'HOST_KEY_CHANGED'
          )
        )
      } else reject(describeError(err, opts.sshHost, opts.sshPort))
    }
    const onReady = (): void => {
      client.removeListener('error', onError)
      resolve()
    }
    client.once('ready', onReady)
    client.once('error', onError)
    try {
      client.connect(config)
    } catch (err) {
      onError(err as Error)
    }
  })

  const sockets = new Set<Socket>()
  let forwardError: string | null = null
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    client.forwardOut('127.0.0.1', socket.remotePort ?? 0, opts.dstHost, opts.dstPort, (err, stream) => {
      if (err) {
        forwardError = err.message
        socket.destroy()
        return
      }
      forwardError = null
      stream.on('error', () => socket.destroy())
      stream.on('close', () => socket.destroy())
      socket.on('close', () => stream.destroy())
      socket.pipe(stream).pipe(socket)
    })
  })

  const localPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new SshTunnelError('No se pudo abrir el puerto local del túnel', 'FORWARD'))
    })
  })

  let closing = false
  let unexpectedListener: ((reason: string) => void) | null = null
  const shutdown = (): Promise<void> =>
    new Promise((resolve) => {
      for (const socket of sockets) socket.destroy()
      client.end()
      server.close(() => resolve())
    })

  client.on('error', () => {})
  client.on('close', () => {
    if (closing) return
    closing = true
    void shutdown()
    unexpectedListener?.('Se perdió la conexión SSH')
  })

  return {
    localPort,
    fingerprint,
    lastForwardError: () => forwardError,
    close: async () => {
      if (closing) return
      closing = true
      await shutdown()
    },
    onUnexpectedClose: (listener) => {
      unexpectedListener = listener
    }
  }
}
