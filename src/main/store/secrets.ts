import { join } from 'node:path'
import type { SecretKey, SecretsPatch, SecretStorageStatus } from '@shared/types'
import { readJson, writeJson } from './fs-utils'

/** Cifrado del sistema. En la app es safeStorage de Electron; en tests, una implementación falsa. */
export interface SecretCipher {
  status(): Promise<SecretStorageStatus>
  encrypt(plain: string): Promise<Buffer>
  /** `reencrypt` = la clave del sistema rotó y conviene volver a cifrar el valor. */
  decrypt(data: Buffer): Promise<{ value: string; reencrypt: boolean }>
}

type Entry = Partial<Record<SecretKey, string>>

interface SecretsFile {
  version: 1
  entries: Record<string, Entry>
}

/**
 * Guarda contraseñas cifradas con el llavero del sistema.
 * Si no hay llavero real, los secretos viven solo en memoria durante la sesión.
 */
export class SecretVault {
  private readonly path: string
  private memory = new Map<string, Entry>()
  // Se cachea la promesa (no el valor) para que dos llamadas simultáneas compartan la misma copia.
  private file: Promise<SecretsFile> | null = null
  private cachedStatus: Promise<SecretStorageStatus> | null = null

  constructor(dir: string, private readonly cipher: SecretCipher) {
    this.path = join(dir, 'secrets.json')
  }

  status(): Promise<SecretStorageStatus> {
    this.cachedStatus ??= this.cipher.status()
    return this.cachedStatus
  }

  async get(id: string): Promise<Entry> {
    if (!(await this.status()).persistent) return { ...this.memory.get(id) }
    const file = await this.load()
    const entry = file.entries[id] ?? {}
    const out: Entry = {}
    let rotated = false
    for (const [key, value] of Object.entries(entry) as [SecretKey, string][]) {
      const { value: plain, reencrypt } = await this.cipher.decrypt(Buffer.from(value, 'base64'))
      out[key] = plain
      if (reencrypt) {
        entry[key] = (await this.cipher.encrypt(plain)).toString('base64')
        rotated = true
      }
    }
    if (rotated) await writeJson(this.path, file)
    return out
  }

  async storedKeys(id: string): Promise<SecretKey[]> {
    if (!(await this.status()).persistent) return Object.keys(this.memory.get(id) ?? {}) as SecretKey[]
    return Object.keys((await this.load()).entries[id] ?? {}) as SecretKey[]
  }

  async apply(id: string, patch: SecretsPatch | undefined): Promise<void> {
    if (!patch) return
    const persistent = (await this.status()).persistent
    const file = persistent ? await this.load() : null
    const entry: Entry = { ...(persistent ? file!.entries[id] : this.memory.get(id)) }
    for (const [key, value] of Object.entries(patch) as [SecretKey, string | null | undefined][]) {
      if (value === null) delete entry[key]
      else if (typeof value === 'string') entry[key] = persistent ? (await this.cipher.encrypt(value)).toString('base64') : value
    }
    if (!file) {
      this.memory.set(id, entry)
      return
    }
    file.entries[id] = entry
    await writeJson(this.path, file)
  }

  async delete(id: string): Promise<void> {
    this.memory.delete(id)
    if (!(await this.status()).persistent) return
    const file = await this.load()
    delete file.entries[id]
    await writeJson(this.path, file)
  }

  private load(): Promise<SecretsFile> {
    this.file ??= readJson<SecretsFile>(this.path, { version: 1, entries: {} })
    return this.file
  }
}
