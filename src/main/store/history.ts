import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { HistoryKind, QueryHistoryEntry, TableRef } from '@shared/types'
import { readJson, writeJson } from './fs-utils'

export const MAX_QUERIES = 500
export const MAX_FILTERS = 30
/** Scripts más largos (volcados, migraciones) no se guardan: llenarían el fichero sin aportar. */
export const MAX_SQL_LENGTH = 100_000

interface HistoryFile {
  version: 1
  queries: Record<string, QueryHistoryEntry[]>
  filters: Record<string, Record<string, string[]>>
}

const tableKey = (ref: TableRef): string => `${ref.database}\u0000${ref.schema ?? ''}\u0000${ref.table}`

/**
 * Historial de consultas (por conexión) y de filtros WHERE (por conexión y tabla), en
 * history.json con permisos 0600. Puede contener datos sensibles escritos en las consultas.
 */
export class HistoryStore {
  private readonly path: string
  // Se cachea la promesa (no el valor) para que dos llamadas simultáneas compartan la misma copia.
  private file: Promise<HistoryFile> | null = null

  constructor(dir: string) {
    this.path = join(dir, 'history.json')
  }

  /** Registra una ejecución. Si repite la última consulta (misma SQL y BBDD), la sustituye. */
  async addQuery(connectionId: string, entry: Omit<QueryHistoryEntry, 'id'>): Promise<void> {
    const sql = entry.sql.trim()
    if (!sql || sql.length > MAX_SQL_LENGTH) return
    const file = await this.load()
    const list = file.queries[connectionId] ?? []
    const last = list[0]
    if (last && last.sql === sql && last.database === entry.database) list.shift()
    list.unshift({ ...entry, sql, id: randomUUID() })
    file.queries[connectionId] = list.slice(0, MAX_QUERIES)
    await writeJson(this.path, file)
  }

  /** Del más reciente al más antiguo; `search` filtra por texto (sin distinguir mayúsculas). */
  async listQueries(connectionId: string, search?: string, limit = MAX_QUERIES): Promise<QueryHistoryEntry[]> {
    const list = (await this.load()).queries[connectionId] ?? []
    const needle = search?.trim().toLowerCase()
    return (needle ? list.filter((e) => e.sql.toLowerCase().includes(needle)) : list).slice(0, limit)
  }

  /** Registra un filtro usado; si ya estaba, pasa a ser el más reciente. */
  async addFilter(connectionId: string, ref: TableRef, where: string): Promise<void> {
    const value = where.trim()
    if (!value) return
    const file = await this.load()
    const tables = (file.filters[connectionId] ??= {})
    const key = tableKey(ref)
    const list = tables[key] ?? []
    if (list[0] === value) return
    tables[key] = [value, ...list.filter((w) => w !== value)].slice(0, MAX_FILTERS)
    await writeJson(this.path, file)
  }

  async listFilters(connectionId: string, ref: TableRef): Promise<string[]> {
    return [...((await this.load()).filters[connectionId]?.[tableKey(ref)] ?? [])]
  }

  async clear(connectionId: string, kind: HistoryKind, ref?: TableRef): Promise<void> {
    const file = await this.load()
    if (kind === 'queries') delete file.queries[connectionId]
    else if (ref) delete file.filters[connectionId]?.[tableKey(ref)]
    else delete file.filters[connectionId]
    await writeJson(this.path, file)
  }

  /** Al borrar una conexión se borra también todo su historial. */
  async deleteConnection(connectionId: string): Promise<void> {
    const file = await this.load()
    delete file.queries[connectionId]
    delete file.filters[connectionId]
    await writeJson(this.path, file)
  }

  private load(): Promise<HistoryFile> {
    this.file ??= readJson<HistoryFile>(this.path, { version: 1, queries: {}, filters: {} })
    return this.file
  }
}
