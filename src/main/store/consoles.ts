import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConsoleState } from '@shared/types'
import { readJson, writeJson } from './fs-utils'

interface ConsolesFile {
  version: 1
  consoles: Record<string, ConsoleState & { updatedAt: string }>
}

const keyOf = (connectionId: string, database: string | null): string => `${connectionId}\u0000${database ?? ''}`

/**
 * Lo escrito en cada consola (una por conexión y base de datos), en consoles.json con permisos
 * 0600. Como el historial, puede contener datos sensibles escritos en las consultas.
 */
export class ConsoleStore {
  private readonly path: string
  // Se cachea la promesa (no el valor) para que dos llamadas simultáneas compartan la misma copia.
  private file: Promise<ConsolesFile> | null = null
  private loaded: ConsolesFile | null = null
  /** Cambios hechos y cambios ya escritos en disco: si difieren, al salir se escribe en síncrono. */
  private changes = 0
  private written = 0

  constructor(dir: string) {
    this.path = join(dir, 'consoles.json')
  }

  async get(connectionId: string, database: string | null): Promise<ConsoleState | null> {
    const saved = (await this.load()).consoles[keyOf(connectionId, database)]
    if (!saved) return null
    const { updatedAt: _updatedAt, ...state } = saved
    return state
  }

  /** Una consola vacía no se guarda: al reabrirla sale en blanco igualmente. */
  async save(connectionId: string, database: string | null, state: ConsoleState): Promise<void> {
    const file = await this.load()
    const key = keyOf(connectionId, database)
    if (state.text.trim()) file.consoles[key] = { ...state, updatedAt: new Date().toISOString() }
    else if (key in file.consoles) delete file.consoles[key]
    else return
    await this.write(file)
  }

  async deleteConnection(connectionId: string): Promise<void> {
    const file = await this.load()
    const prefix = keyOf(connectionId, '')
    const keys = Object.keys(file.consoles).filter((k) => k.startsWith(prefix))
    if (keys.length === 0) return
    for (const k of keys) delete file.consoles[k]
    await this.write(file)
  }

  /**
   * Al cerrar la app: Electron no espera a las escrituras asíncronas, así que si queda alguna
   * pendiente se escribe aquí en síncrono (temporal + rename, como writeJson).
   */
  flushSync(): void {
    if (!this.loaded || this.written === this.changes) return
    const tmp = `${this.path}.${process.pid}.sync.tmp`
    writeFileSync(tmp, JSON.stringify(this.loaded, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
    this.written = this.changes
  }

  private async write(file: ConsolesFile): Promise<void> {
    const change = ++this.changes
    await writeJson(this.path, file)
    this.written = Math.max(this.written, change)
  }

  private load(): Promise<ConsolesFile> {
    this.file ??= readJson<ConsolesFile>(this.path, { version: 1, consoles: {} }).then((file) => (this.loaded = file))
    return this.file
  }
}
