import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ConnectionConfig, ConnectionSummary, SaveConnectionInput } from '@shared/types'
import { connectionConfigSchema } from '../validation'
import { readJson, writeJson } from './fs-utils'
import type { SecretVault } from './secrets'

interface ConnectionsFile {
  version: 1
  connections: ConnectionConfig[]
}

/** Conexiones guardadas en connections.json (sin secretos; esos van al SecretVault). */
export class ConnectionStore {
  private readonly path: string
  // Se cachea la promesa (no el valor) para que dos llamadas simultáneas compartan la misma copia.
  private file: Promise<ConnectionsFile> | null = null

  constructor(dir: string, private readonly vault: SecretVault) {
    this.path = join(dir, 'connections.json')
  }

  async list(): Promise<ConnectionSummary[]> {
    const { connections } = await this.load()
    return Promise.all(connections.map((c) => this.summarize(c)))
  }

  async get(id: string): Promise<ConnectionConfig> {
    const found = (await this.load()).connections.find((c) => c.id === id)
    if (!found) throw new Error('La conexión no existe')
    return found
  }

  async save(input: SaveConnectionInput): Promise<ConnectionSummary> {
    const parsed = connectionConfigSchema.parse(input.config)
    const file = await this.load()
    const id = parsed.id ?? randomUUID()
    const config: ConnectionConfig = { ...parsed, id }
    const index = file.connections.findIndex((c) => c.id === id)
    // La selección de bases de datos no viene del formulario: se conserva al editar.
    const visible = index >= 0 ? file.connections[index]!.visibleDatabases : undefined
    if (visible) config.visibleDatabases = visible
    if (index >= 0) file.connections[index] = config
    else file.connections.push(config)
    await writeJson(this.path, file)
    await this.vault.apply(id, input.secrets)
    return this.summarize(config)
  }

  /** Bases de datos visibles en el explorador; null = todas. */
  async setVisibleDatabases(id: string, databases: string[] | null): Promise<ConnectionSummary> {
    const file = await this.load()
    const config = file.connections.find((c) => c.id === id)
    if (!config) throw new Error('La conexión no existe')
    if (databases) config.visibleDatabases = [...new Set(databases)]
    else delete config.visibleDatabases
    await writeJson(this.path, file)
    return this.summarize(config)
  }

  async delete(id: string): Promise<void> {
    const file = await this.load()
    file.connections = file.connections.filter((c) => c.id !== id)
    await writeJson(this.path, file)
    await this.vault.delete(id)
  }

  private async summarize(config: ConnectionConfig): Promise<ConnectionSummary> {
    return { ...config, storedSecrets: await this.vault.storedKeys(config.id) }
  }

  private async load(): Promise<ConnectionsFile> {
    this.file ??= readJson<ConnectionsFile>(this.path, { version: 1, connections: [] })
    return this.file
  }
}
