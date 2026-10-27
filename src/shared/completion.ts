// Análisis ligero del texto del editor para el autocompletado: qué tablas usa la consulta y con qué alias.
import type { CompletionColumn } from './types'

/**
 * Columnas que se cargan de golpe al elegir base de datos. Si la base tiene más, la lista llega
 * recortada y las columnas de cada tabla se piden cuando la consulta la usa.
 */
export const COMPLETION_COLUMN_LIMIT = 20_000

const NOT_ALIAS = new Set([
  'WHERE', 'ON', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'GROUP', 'ORDER', 'HAVING',
  'LIMIT', 'UNION', 'SET', 'VALUES', 'AS', 'USING', 'WITH', 'NATURAL', 'STRAIGHT_JOIN', 'OFFSET', 'FETCH', 'FOR'
])

const IDENT = String.raw`(?:\`[^\`]+\`|\[[^\]]+\]|"[^"]+"|[\w$#]+)`
const TABLE_REF = new RegExp(
  String.raw`\b(?:FROM|JOIN|UPDATE|INTO)\s+(${IDENT}(?:\s*\.\s*${IDENT}){0,2})(?:\s+(?:AS\s+)?(${IDENT}))?`,
  'gi'
)

const unquote = (name: string): string => name.replace(/^[`["]|[`\]"]$/g, '')

/** Nombre de la tabla (última parte de `bd.esquema.tabla`) sin comillas. */
const lastPart = (qualified: string): string => unquote(qualified.split(/\s*\.\s*/).at(-1) ?? qualified)

/**
 * Tablas citadas en FROM / JOIN / UPDATE / INTO y sus alias.
 * Devuelve alias o nombre (en minúsculas) → nombre de la tabla.
 */
export function tableAliases(sql: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const match of sql.matchAll(TABLE_REF)) {
    const table = lastPart(match[1]!)
    map.set(table.toLowerCase(), table)
    const alias = match[2] ? unquote(match[2]) : null
    if (alias && !NOT_ALIAS.has(alias.toUpperCase())) map.set(alias.toLowerCase(), table)
  }
  return map
}

interface CompletionTable {
  name: string
  schema: string | null
}

/**
 * Columnas del autocompletado a partir de la carga inicial. Si llegó recortada, las de cada tabla se
 * piden con `fetch` la primera vez que la consulta la usa; las peticiones en curso se comparten y un
 * fallo no se recuerda, así que se reintenta en la siguiente sugerencia.
 */
export function completionColumns(
  tables: CompletionTable[],
  initial: CompletionColumn[],
  fetch: (table: CompletionTable) => Promise<CompletionColumn[]>
): { columns: CompletionColumn[]; ensureColumns: (tables: string[]) => Promise<void> } {
  if (initial.length < COMPLETION_COLUMN_LIMIT) return { columns: initial, ensureColumns: async () => {} }
  // La última tabla puede venir a medias: se descarta y se pedirá entera.
  const last = initial.at(-1)!
  const columns = initial.filter((c) => c.table !== last.table || c.schema !== last.schema)
  const loaded = new Set(columns.map((c) => c.table.toLowerCase()))
  const pending = new Map<string, Promise<void>>()

  const load = (key: string): Promise<void> => {
    let p = pending.get(key)
    if (!p) {
      const matches = tables.filter((t) => t.name.toLowerCase() === key)
      p = Promise.all(matches.map(fetch))
        .then((lists) => {
          columns.push(...lists.flat())
          loaded.add(key)
        })
        .catch(() => {})
        .finally(() => pending.delete(key))
      pending.set(key, p)
    }
    return p
  }

  return {
    columns,
    ensureColumns: async (names) => {
      await Promise.all(names.map((n) => n.toLowerCase()).filter((key) => !loaded.has(key)).map(load))
    }
  }
}
