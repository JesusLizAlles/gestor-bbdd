import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJson, writeJson } from '../store/fs-utils'

interface KnownHostsFile {
  version: 1
  hosts: Record<string, string>
}

/** Huella en el mismo formato que muestra OpenSSH: `SHA256:<base64 sin relleno>`. */
export function fingerprintOf(hostKey: Buffer): string {
  return `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`
}

export type HostCheck = 'trusted' | 'new' | 'changed'

/**
 * Claves de servidores SSH conocidos. Política TOFU: la primera conexión se acepta y se
 * recuerda; si la huella cambia después, la conexión se rechaza.
 */
export class KnownHosts {
  private readonly path: string
  // Se cachea la promesa (no el valor) para que dos llamadas simultáneas compartan la misma copia.
  private file: Promise<KnownHostsFile> | null = null

  constructor(dir: string) {
    this.path = join(dir, 'known_hosts.json')
  }

  async check(host: string, port: number, fingerprint: string): Promise<HostCheck> {
    const known = (await this.load()).hosts[`${host}:${port}`]
    if (!known) return 'new'
    return known === fingerprint ? 'trusted' : 'changed'
  }

  async remember(host: string, port: number, fingerprint: string): Promise<void> {
    const file = await this.load()
    file.hosts[`${host}:${port}`] = fingerprint
    await writeJson(this.path, file)
  }

  async forget(host: string, port: number): Promise<void> {
    const file = await this.load()
    delete file.hosts[`${host}:${port}`]
    await writeJson(this.path, file)
  }

  private async load(): Promise<KnownHostsFile> {
    this.file ??= readJson<KnownHostsFile>(this.path, { version: 1, hosts: {} })
    return this.file
  }
}
