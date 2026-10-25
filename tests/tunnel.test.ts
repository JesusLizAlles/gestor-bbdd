import { mkdtemp, rm } from 'node:fs/promises'
import { connect, createServer, type AddressInfo, type Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server as SshServer, utils } from 'ssh2'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { KnownHosts } from '../src/main/ssh/known-hosts'
import { openSshTunnel, SshTunnelError, type Tunnel } from '../src/main/ssh/tunnel'

const USER = 'tester'
const PASSWORD = 'clave-correcta'

function listen(server: NetServer | SshServer): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

/** Servidor SSH mínimo que acepta usuario/contraseña y reenvía direct-tcpip. */
function startSshServer(hostKey: string): SshServer {
  return new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASSWORD) ctx.accept()
      else ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const upstream = connect(info.destPort, info.destIP)
        upstream.once('connect', () => {
          const channel = accept()
          channel.pipe(upstream).pipe(channel)
          upstream.on('error', () => channel.destroy())
        })
        upstream.once('error', () => reject())
      })
    })
    client.on('error', () => {})
  })
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(payload))
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk.toString()
      if (received.length >= payload.length) {
        socket.end()
        resolve(received)
      }
    })
    socket.on('error', reject)
    socket.on('close', () => reject(new Error('Conexión cerrada sin respuesta')))
  })
}

describe('openSshTunnel', () => {
  let dir: string
  let echo: NetServer
  let echoPort: number
  let ssh: SshServer
  let sshPort: number
  let tunnel: Tunnel | null = null
  const keyA = utils.generateKeyPairSync('ed25519').private
  const keyB = utils.generateKeyPairSync('ed25519').private

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-bbdd-ssh-'))
    echo = createServer((s) => s.pipe(s))
    echoPort = await listen(echo)
    ssh = startSshServer(keyA)
    sshPort = await listen(ssh)
  })

  afterEach(async () => {
    await tunnel?.close()
    tunnel = null
  })

  afterAll(async () => {
    ssh.close()
    echo.close()
    await rm(dir, { recursive: true, force: true })
  })

  const baseOptions = (knownHosts: KnownHosts, password = PASSWORD) => ({
    sshHost: '127.0.0.1',
    sshPort,
    username: USER,
    auth: { method: 'password' as const, password },
    dstHost: '127.0.0.1',
    dstPort: echoPort,
    knownHosts
  })

  it('reenvía tráfico a través del servidor SSH y recuerda la huella', async () => {
    const knownHosts = new KnownHosts(dir)
    tunnel = await openSshTunnel(baseOptions(knownHosts))
    expect(tunnel.localPort).toBeGreaterThan(0)
    expect(tunnel.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(await roundTrip(tunnel.localPort, 'hola-bbdd')).toBe('hola-bbdd')
    // Varias conexiones simultáneas por el mismo túnel (como hace un pool).
    const results = await Promise.all(['a', 'b', 'c'].map((p) => roundTrip(tunnel!.localPort, p.repeat(1000))))
    expect(results.map((r) => r.length)).toEqual([1000, 1000, 1000])
    expect(await knownHosts.check('127.0.0.1', sshPort, tunnel.fingerprint)).toBe('trusted')
  })

  it('rechaza una contraseña incorrecta con un error de autenticación', async () => {
    const err = await openSshTunnel(baseOptions(new KnownHosts(dir), 'mala')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SshTunnelError)
    expect((err as SshTunnelError).code).toBe('AUTH')
  })

  it('rechaza la conexión si la huella del servidor cambia', async () => {
    const knownHosts = new KnownHosts(dir)
    // Servidor distinto en el mismo host:puerto que ya conocíamos.
    ssh.close()
    ssh = startSshServer(keyB)
    await new Promise<void>((resolve) => ssh.listen(sshPort, '127.0.0.1', () => resolve()))
    const err = await openSshTunnel(baseOptions(knownHosts)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SshTunnelError)
    expect((err as SshTunnelError).code).toBe('HOST_KEY_CHANGED')
  })

  it('informa de un servidor SSH inaccesible', async () => {
    const closed = createServer()
    const port = await listen(closed)
    closed.close()
    const err = await openSshTunnel({ ...baseOptions(new KnownHosts(dir)), sshPort: port }).catch((e: unknown) => e)
    expect((err as SshTunnelError).code).toBe('NETWORK')
  })

  it('recuerda por qué el servidor SSH no pudo llegar al destino', async () => {
    const closed = createServer()
    const deadPort = await listen(closed)
    closed.close()
    tunnel = await openSshTunnel({ ...baseOptions(new KnownHosts(join(dir, 'destino'))), dstPort: deadPort })
    expect(tunnel.lastForwardError()).toBeNull()
    await expect(roundTrip(tunnel.localPort, 'x')).rejects.toThrow()
    expect(tunnel.lastForwardError()).toBeTruthy()
  })

  it('libera el puerto local al cerrar', async () => {
    tunnel = await openSshTunnel(baseOptions(new KnownHosts(join(dir, 'otro'))))
    const port = tunnel.localPort
    await tunnel.close()
    tunnel = null
    await expect(roundTrip(port, 'x')).rejects.toThrow()
  })
})
