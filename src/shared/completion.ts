// Análisis ligero del texto del editor para el autocompletado: qué tablas usa la consulta y con qué alias.

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
