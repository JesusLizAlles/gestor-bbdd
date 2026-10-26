// Resaltado y autocompletado del campo WHERE del visor de tablas. Sin dependencias: se prueba en Node.
import type { Engine } from './types'

export type TokenType = 'keyword' | 'function' | 'column' | 'ident' | 'string' | 'number' | 'operator' | 'comment' | 'space'

export interface Token {
  type: TokenType
  text: string
  start: number
  end: number
  /** Cadena o comentario sin cerrar: el cursor al final sigue dentro. */
  open?: boolean
}

const KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN',
  'ELSE', 'END', 'AS', 'ESCAPE', 'COLLATE', 'INTERVAL', 'DAY', 'MONTH', 'YEAR', 'HOUR', 'MINUTE', 'SECOND', 'WEEK',
  'DATE', 'TIME', 'TIMESTAMP', 'REGEXP', 'RLIKE', 'XOR', 'DIV', 'MOD', 'SELECT', 'FROM', 'WHERE', 'ANY', 'ALL',
  'SOME', 'BINARY', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CURRENT_TIME', 'UNKNOWN'
])

const NOT_CALLS = new Set(['IN', 'EXISTS', 'NOT', 'AND', 'OR', 'XOR', 'ANY', 'ALL', 'SOME', 'AS', 'BETWEEN', 'LIKE', 'IS', 'WHEN', 'THEN', 'ELSE'])

const WORD_START = /[A-Za-z_@$#À-￿]/
const WORD_CHAR = /[\w@$#À-￿]/
const OPERATORS = ['<=>', '<>', '!=', '>=', '<=', '||', '&&', '=', '<', '>', '+', '-', '*', '/', '%', '(', ')', ',', '.', ';', '!', '&', '|', '^', '~']

/** Trocea un filtro para colorearlo. Las columnas se reconocen por nombre (sin distinguir mayúsculas). */
export function tokenize(text: string, engine: Engine, columns: Iterable<string> = []): Token[] {
  const isMy = engine === 'mysql'
  const known = new Set([...columns].map((c) => c.toLowerCase()))
  const tokens: Token[] = []
  const push = (type: TokenType, start: number, end: number, open = false) =>
    tokens.push({ type, text: text.slice(start, end), start, end, ...(open ? { open } : {}) })
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]!
    const next = text[i + 1]
    const start = i
    if (/\s/.test(ch)) {
      while (i < n && /\s/.test(text[i]!)) i++
      push('space', start, i)
    } else if ((ch === '-' && next === '-') || (isMy && ch === '#')) {
      while (i < n && text[i] !== '\n') i++
      push('comment', start, i)
    } else if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2)
      i = close < 0 ? n : close + 2
      push('comment', start, i, close < 0)
    } else if (ch === "'" || (ch === '"' && isMy) || ((ch === 'N' || ch === 'n') && next === "'" && !isMy)) {
      // En MySQL las comillas dobles son cadenas y la barra invertida escapa; en T-SQL N'…' es Unicode.
      const quote = ch === '"' ? '"' : "'"
      i += ch === quote ? 1 : 2
      let closed = false
      while (i < n) {
        if (isMy && text[i] === '\\') i += 2
        else if (text[i] === quote && text[i + 1] === quote) i += 2
        else if (text[i] === quote) {
          i++
          closed = true
          break
        } else i++
      }
      push('string', start, Math.min(i, n), !closed)
    } else if (ch === '`' || ch === '[' || ch === '"') {
      const close = ch === '[' ? ']' : ch
      const end = text.indexOf(close, i + 1)
      i = end < 0 ? n : end + 1
      const name = text.slice(start + 1, end < 0 ? n : end)
      push(known.has(name.toLowerCase()) ? 'column' : 'ident', start, i, end < 0)
    } else if (/\d/.test(ch) || (ch === '.' && /\d/.test(next ?? ''))) {
      const m = /^(?:0x[0-9a-f]+|\d*\.?\d+(?:e[+-]?\d+)?)/i.exec(text.slice(i))!
      i += m[0].length
      push('number', start, i)
    } else if (WORD_START.test(ch)) {
      while (i < n && WORD_CHAR.test(text[i]!)) i++
      const word = text.slice(start, i)
      const upper = word.toUpperCase()
      // Una palabra seguida de "(" es una llamada, salvo operadores como IN (…) o EXISTS (…).
      const call = /^\s*\(/.test(text.slice(i)) && !NOT_CALLS.has(upper)
      const type: TokenType = known.has(word.toLowerCase())
        ? 'column'
        : call
          ? 'function'
          : KEYWORDS.has(upper)
            ? 'keyword'
            : FUNCTION_NAMES.has(upper)
              ? 'function'
              : 'ident'
      push(type, start, i)
    } else {
      const op = OPERATORS.find((o) => text.startsWith(o, i)) ?? ch
      i += op.length
      push('operator', start, i)
    }
  }
  return tokens
}

export type SuggestionKind = 'column' | 'keyword' | 'operator' | 'function' | 'value'

export interface Suggestion {
  label: string
  kind: SuggestionKind
  /** Texto que se inserta en lugar de la palabra a medio escribir. */
  insert: string
  /** Posición del cursor dentro de `insert` tras insertarlo; sin ella va al final (seguido de un espacio). */
  caret?: number
  detail?: string
}

export interface CompletionResult {
  /** Tramo [from, to) que sustituye la sugerencia elegida. */
  from: number
  to: number
  /** Lo escrito de la palabra hasta el cursor. */
  prefix: string
  items: Suggestion[]
}

export interface FilterColumn {
  name: string
  dataType: string
}

interface Fn {
  name: string
  /** Texto insertado; `|` marca dónde queda el cursor. */
  template: string
  detail: string
}

const MYSQL_FUNCTIONS: Fn[] = [
  { name: 'NOW', template: 'NOW()|', detail: 'fecha y hora actual' },
  { name: 'CURDATE', template: 'CURDATE()|', detail: 'fecha de hoy' },
  { name: 'DATE', template: 'DATE(|)', detail: 'parte de fecha' },
  { name: 'YEAR', template: 'YEAR(|)', detail: 'año' },
  { name: 'MONTH', template: 'MONTH(|)', detail: 'mes' },
  { name: 'DAY', template: 'DAY(|)', detail: 'día del mes' },
  { name: 'DATE_SUB', template: 'DATE_SUB(CURDATE(), INTERVAL |1 DAY)', detail: 'restar a una fecha' },
  { name: 'DATE_ADD', template: 'DATE_ADD(CURDATE(), INTERVAL |1 DAY)', detail: 'sumar a una fecha' },
  { name: 'DATEDIFF', template: 'DATEDIFF(|, CURDATE())', detail: 'días entre fechas' },
  { name: 'DATE_FORMAT', template: "DATE_FORMAT(|, '%Y-%m-%d')", detail: 'formatear fecha' },
  { name: 'LOWER', template: 'LOWER(|)', detail: 'minúsculas' },
  { name: 'UPPER', template: 'UPPER(|)', detail: 'mayúsculas' },
  { name: 'TRIM', template: 'TRIM(|)', detail: 'quitar espacios' },
  { name: 'LENGTH', template: 'LENGTH(|)', detail: 'longitud en bytes' },
  { name: 'CHAR_LENGTH', template: 'CHAR_LENGTH(|)', detail: 'longitud en caracteres' },
  { name: 'CONCAT', template: 'CONCAT(|)', detail: 'concatenar' },
  { name: 'SUBSTRING', template: 'SUBSTRING(|, 1, 10)', detail: 'subcadena' },
  { name: 'IFNULL', template: 'IFNULL(|, 0)', detail: 'valor si es NULL' },
  { name: 'COALESCE', template: 'COALESCE(|)', detail: 'primer valor no NULL' },
  { name: 'CAST', template: 'CAST(| AS DATE)', detail: 'convertir tipo' }
]

const MSSQL_FUNCTIONS: Fn[] = [
  { name: 'GETDATE', template: 'GETDATE()|', detail: 'fecha y hora actual' },
  { name: 'SYSDATETIME', template: 'SYSDATETIME()|', detail: 'fecha y hora precisa' },
  { name: 'CAST', template: 'CAST(| AS date)', detail: 'convertir tipo' },
  { name: 'CONVERT', template: 'CONVERT(date, |)', detail: 'convertir tipo' },
  { name: 'YEAR', template: 'YEAR(|)', detail: 'año' },
  { name: 'MONTH', template: 'MONTH(|)', detail: 'mes' },
  { name: 'DAY', template: 'DAY(|)', detail: 'día del mes' },
  { name: 'DATEADD', template: 'DATEADD(day, |-1, GETDATE())', detail: 'sumar a una fecha' },
  { name: 'DATEDIFF', template: 'DATEDIFF(day, |, GETDATE())', detail: 'diferencia entre fechas' },
  { name: 'DATEPART', template: 'DATEPART(weekday, |)', detail: 'parte de una fecha' },
  { name: 'EOMONTH', template: 'EOMONTH(|)', detail: 'fin de mes' },
  { name: 'FORMAT', template: "FORMAT(|, 'yyyy-MM-dd')", detail: 'formatear' },
  { name: 'LOWER', template: 'LOWER(|)', detail: 'minúsculas' },
  { name: 'UPPER', template: 'UPPER(|)', detail: 'mayúsculas' },
  { name: 'TRIM', template: 'TRIM(|)', detail: 'quitar espacios' },
  { name: 'LTRIM', template: 'LTRIM(|)', detail: 'quitar espacios a la izquierda' },
  { name: 'RTRIM', template: 'RTRIM(|)', detail: 'quitar espacios a la derecha' },
  { name: 'LEN', template: 'LEN(|)', detail: 'longitud' },
  { name: 'SUBSTRING', template: 'SUBSTRING(|, 1, 10)', detail: 'subcadena' },
  { name: 'ISNULL', template: 'ISNULL(|, 0)', detail: 'valor si es NULL' },
  { name: 'COALESCE', template: 'COALESCE(|)', detail: 'primer valor no NULL' }
]

const FUNCTION_NAMES = new Set([...MYSQL_FUNCTIONS, ...MSSQL_FUNCTIONS].map((f) => f.name))

const fromTemplate = (template: string, kind: SuggestionKind, label: string, detail?: string): Suggestion => {
  const caret = template.indexOf('|')
  const insert = template.replace('|', '')
  return { label, kind, insert, ...(caret >= 0 && caret < insert.length ? { caret } : {}), ...(detail ? { detail } : {}) }
}

const isDate = (type: string) => /date|time/i.test(type)
const isText = (type: string) => /char|text|uniqueidentifier|enum|set|xml/i.test(type)

/** Comparadores tras una columna; si es una fecha, los ejemplos ya llevan fechas. */
function operators(column: FilterColumn | undefined, today: string): Suggestion[] {
  const date = column && isDate(column.dataType)
  const simple = ['=', '<>', '>', '<', '>=', '<='].map((op) => ({ label: op, kind: 'operator' as const, insert: op }))
  return [
    ...simple,
    fromTemplate("LIKE '%|%'", 'operator', 'LIKE', 'contiene'),
    fromTemplate("NOT LIKE '%|%'", 'operator', 'NOT LIKE'),
    fromTemplate('IN (|)', 'operator', 'IN', 'en una lista'),
    fromTemplate('NOT IN (|)', 'operator', 'NOT IN'),
    date
      ? { label: 'BETWEEN', kind: 'operator', insert: `BETWEEN '${today.slice(0, 8)}01' AND '${today}'`, detail: 'entre dos fechas' }
      : fromTemplate('BETWEEN | AND ', 'operator', 'BETWEEN', 'entre dos valores'),
    { label: 'IS NULL', kind: 'operator', insert: 'IS NULL' },
    { label: 'IS NOT NULL', kind: 'operator', insert: 'IS NOT NULL' }
  ]
}

/** Valores tras un comparador, según el tipo de la columna comparada. */
function values(engine: Engine, column: FilterColumn | undefined, today: string): Suggestion[] {
  const isMy = engine === 'mysql'
  const out: Suggestion[] = []
  if (column && isDate(column.dataType)) {
    out.push({ label: `'${today}'`, kind: 'value', insert: `'${today}'`, detail: 'hoy' })
    if (isMy) {
      out.push(
        { label: 'CURDATE()', kind: 'value', insert: 'CURDATE()', detail: 'hoy' },
        { label: 'NOW()', kind: 'value', insert: 'NOW()', detail: 'ahora' },
        fromTemplate('DATE_SUB(CURDATE(), INTERVAL |7 DAY)', 'value', 'DATE_SUB(CURDATE(), INTERVAL 7 DAY)', 'hace 7 días'),
        fromTemplate('DATE_SUB(CURDATE(), INTERVAL |1 MONTH)', 'value', 'DATE_SUB(CURDATE(), INTERVAL 1 MONTH)', 'hace un mes')
      )
    } else {
      out.push(
        { label: 'CAST(GETDATE() AS date)', kind: 'value', insert: 'CAST(GETDATE() AS date)', detail: 'hoy' },
        { label: 'GETDATE()', kind: 'value', insert: 'GETDATE()', detail: 'ahora' },
        fromTemplate('DATEADD(day, |-7, CAST(GETDATE() AS date))', 'value', 'DATEADD(day, -7, CAST(GETDATE() AS date))', 'hace 7 días'),
        fromTemplate('DATEADD(month, |-1, CAST(GETDATE() AS date))', 'value', 'DATEADD(month, -1, CAST(GETDATE() AS date))', 'hace un mes')
      )
    }
  } else if (column && isText(column.dataType)) {
    out.push(fromTemplate(isMy ? "'|'" : "N'|'", 'value', isMy ? "'…'" : "N'…'", 'cadena'))
  }
  out.push({ label: 'NULL', kind: 'keyword', insert: 'NULL' })
  if (isMy) out.push({ label: 'TRUE', kind: 'keyword', insert: 'TRUE' }, { label: 'FALSE', kind: 'keyword', insert: 'FALSE' })
  return out
}

const quoteName = (engine: Engine, name: string) =>
  /^[A-Za-z_][\w$]*$/.test(name) ? name : engine === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `[${name.replace(/]/g, ']]')}]`

const significant = (t: Token) => t.type !== 'space' && t.type !== 'comment'

/**
 * Sugerencias para el cursor en `cursor`, según lo que hay delante: al empezar una condición,
 * columnas y funciones; tras una columna, comparadores; tras un comparador, valores; tras un valor, AND/OR.
 * Dentro de cadenas o comentarios no se sugiere nada.
 */
export function suggest(
  text: string,
  cursor: number,
  engine: Engine,
  columns: FilterColumn[],
  today: string = localDate(new Date())
): CompletionResult {
  const tokens = tokenize(text, engine, columns.map((c) => c.name))
  const none = { from: cursor, to: cursor, prefix: '', items: [] }
  const inside = tokens.find((t) => t.start < cursor && (cursor < t.end || (cursor === t.end && t.open)))
  if (inside && (inside.type === 'string' || inside.type === 'comment' || inside.type === 'number')) return none
  if (inside && (inside.type === 'column' || inside.type === 'ident') && /^[`["]/.test(inside.text)) return none

  // Palabra a medio escribir alrededor del cursor.
  let from = cursor
  while (from > 0 && WORD_CHAR.test(text[from - 1]!)) from--
  let to = cursor
  while (to < text.length && WORD_CHAR.test(text[to]!)) to++
  const prefix = text.slice(from, cursor)
  if (/^\d/.test(prefix)) return none

  const before = tokens.filter((t) => t.end <= from && significant(t))
  const last = before.at(-1)
  const upper = (t: Token | undefined) => (t && (t.type === 'keyword' || t.type === 'operator') ? t.text.toUpperCase() : '')
  const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c]))
  const columnOf = (t: Token | undefined) =>
    t && t.type === 'column' ? byName.get(t.text.replace(/^[`["]|[`\]"]$/g, '').toLowerCase()) : undefined
  const startsCondition = (t: Token | undefined) => !t || ['AND', 'OR', 'XOR', 'NOT', '('].includes(upper(t))
  // Columna de la condición actual (`col = …`, `col IN (…, …`, `col BETWEEN x AND …`). Si el
  // operando es una expresión, como YEAR(fecha), no se sabe su tipo.
  const subject = (): FilterColumn | undefined => {
    for (let k = before.length - 1; k >= 0; k--) {
      const t = before[k]!
      const word = upper(t)
      if (t.type === 'column') return columnOf(t)
      if (word === ')') return undefined
      if (word === '(' && startsCondition(before[k - 1])) return undefined
      if ((word === 'AND' && upper(before[k - 2]) !== 'BETWEEN') || word === 'OR' || word === 'XOR') return undefined
    }
    return undefined
  }

  // ¿El paréntesis abierto más interno es de una función o de IN (…)?
  const openParen = (): Token | undefined => {
    let depth = 0
    for (let k = before.length - 1; k >= 0; k--) {
      const t = before[k]!.text
      if (t === ')') depth++
      else if (t === '(') {
        if (depth === 0) return before[k - 1]
        depth--
      }
    }
    return undefined
  }
  const closesCall = (): boolean => {
    let depth = 0
    for (let k = before.length - 1; k >= 0; k--) {
      const t = before[k]!.text
      if (t === ')') depth++
      else if (t === '(' && --depth === 0) return before[k - 1]?.type === 'function'
    }
    return false
  }

  const columnItems = (): Suggestion[] =>
    columns.map((c) => ({ label: c.name, kind: 'column', insert: quoteName(engine, c.name), detail: c.dataType }))
  const fns = engine === 'mysql' ? MYSQL_FUNCTIONS : MSSQL_FUNCTIONS
  const functionItems = (): Suggestion[] => fns.map((f) => fromTemplate(f.template, 'function', f.name, f.detail))
  const kw = (...words: string[]): Suggestion[] => words.map((w) => ({ label: w, kind: 'keyword', insert: w }))
  const connectors = () => kw('AND', 'OR')

  const prev = upper(last)
  const prev2 = upper(before.at(-2))
  let items: Suggestion[]
  if (prev === 'IS') {
    items = kw('NULL', 'NOT NULL')
  } else if (prev === 'NOT' && prev2 === 'IS') {
    items = kw('NULL')
  } else if (prev === 'AND' && upper(before.at(-3)) === 'BETWEEN') {
    items = [...values(engine, subject(), today), ...columnItems(), ...functionItems()]
  } else if (!last || ['AND', 'OR', 'XOR', 'WHERE', ';'].includes(prev) || (prev === 'NOT' && !last2IsOperand(before))) {
    items = [...columnItems(), ...kw('NOT', 'EXISTS'), ...functionItems(), fromTemplate('(|)', 'keyword', '( … )')]
  } else if (prev === '(' || prev === ',') {
    const owner = openParen()
    if (prev === '(' && startsCondition(owner)) {
      items = [...columnItems(), ...kw('NOT', 'EXISTS'), ...functionItems()]
    } else {
      const inList = upper(owner) === 'IN'
      items = [...(inList ? values(engine, subject(), today) : []), ...columnItems(), ...functionItems(), ...(inList ? [] : values(engine, undefined, today))]
    }
  } else if (prev === 'NOT') {
    items = [fromTemplate("LIKE '%|%'", 'operator', 'LIKE'), fromTemplate('IN (|)', 'operator', 'IN'), ...kw('BETWEEN')]
  } else if (prev === 'BETWEEN' || isComparison(prev) || ['LIKE', 'REGEXP', 'RLIKE', '+', '-', '*', '/', '%'].includes(prev)) {
    items = [...values(engine, subject(), today), ...columnItems(), ...functionItems()]
  } else if (last.type === 'column' || last.type === 'ident' || (prev === ')' && closesCall())) {
    items = operators(subject() ?? columnOf(last), today)
    if (last.type === 'ident' || prev === ')') items.push(...connectors())
  } else if (last.type === 'string' || last.type === 'number' || prev === ')' || ['NULL', 'TRUE', 'FALSE'].includes(prev)) {
    // Dentro de BETWEEN x … solo cabe AND.
    const between = before.slice(-3).some((t) => upper(t) === 'BETWEEN') && !before.slice(-2).some((t) => upper(t) === 'AND')
    items = between ? kw('AND') : connectors()
  } else {
    items = [...columnItems(), ...functionItems(), ...connectors()]
  }

  return { from, to, prefix, items: rank(items, prefix) }
}

/** `col NOT …` (NOT tras un operando) frente a `NOT col …` (al empezar una condición). */
function last2IsOperand(before: Token[]): boolean {
  const t = before.at(-2)
  return !!t && (t.type === 'column' || t.type === 'ident' || t.type === 'string' || t.type === 'number' || t.text === ')')
}

const pad = (n: number) => String(n).padStart(2, '0')
/** Fecha local en formato ISO (yyyy-mm-dd). */
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const isComparison = (op: string) => ['=', '<>', '!=', '>', '<', '>=', '<=', '<=>'].includes(op)

/** Filtra por lo escrito: primero lo que empieza igual, luego lo que lo contiene; sin prefijo, todo en orden. */
function rank(items: Suggestion[], prefix: string): Suggestion[] {
  const seen = new Set<string>()
  const unique = items.filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)))
  if (!prefix) return unique
  const p = prefix.toLowerCase()
  const label = (s: Suggestion) => s.label.toLowerCase()
  const starts = unique.filter((s) => label(s).startsWith(p))
  const contains = unique.filter((s) => !label(s).startsWith(p) && s.kind === 'column' && label(s).includes(p))
  return [...starts, ...contains]
}
