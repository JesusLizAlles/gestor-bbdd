import { connect, type AddressInfo, type Server as NetServer } from 'node:net'
import { Server as SshServer } from 'ssh2'
import type { ConnectionConfig } from '../src/shared/types'

export const SSH_USER = 'tester'
export const SSH_PASSWORD = 'clave-correcta'

export function listen(server: NetServer | SshServer, port = 0): Promise<number> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

/** Servidor SSH mínimo en proceso: acepta usuario/contraseña y reenvía direct-tcpip (ssh -L). */
export function startSshServer(hostKey: string): SshServer {
  return new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === SSH_USER && ctx.password === SSH_PASSWORD) ctx.accept()
      else ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const upstream = connect(info.destPort, info.destIP)
        upstream.once('connect', () => {
          const channel = accept()
          channel.pipe(upstream).pipe(channel)
          upstream.on('error', () => channel.destroy())
          channel.on('close', () => upstream.destroy())
        })
        upstream.once('error', () => reject())
      })
    })
    client.on('error', () => {})
  })
}

export function baseConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'test',
    name: 'test',
    engine: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    username: '',
    environment: 'dev',
    readOnly: false,
    tls: { enabled: false, verifyServerCert: false },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    ...overrides
  }
}
