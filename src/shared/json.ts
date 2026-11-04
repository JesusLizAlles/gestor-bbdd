// Detección y análisis de JSON guardado en columnas de texto (LONGTEXT, NVARCHAR(MAX)…). Sin dependencias.
//
// Parser propio en lugar de JSON.parse para enseñar el documento tal cual está guardado:
// - los números conservan su texto (IDs de más de 2^53 no se redondean, 1.50 sigue siendo 1.50);
// - las claves mantienen su orden (JSON.parse pone primero las que parecen enteros) y no se pierden las repetidas.

export type JsonNode =
  | { kind: 'object'; entries: [string, JsonNode][] }
  | { kind: 'array'; items: JsonNode[] }
  | { kind: 'string'; value: string }
  | { kind: 'number'; raw: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }

/** Por encima de esto no se intenta: el visor se quedaría colgado pintando el árbol. */
export const MAX_JSON_LENGTH = 2_000_000

// Filtro rápido antes de analizar: solo objetos o arrays, que empiecen y terminen con su delimitador.
// Un texto suelto, un número o "true" no se tratan como JSON aunque técnicamente lo sean.
const LOOKS_LIKE_JSON = /^\s*(?:\{[\s\S]*\}|\[[\s\S]*\])\s*$/

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y
const WHITESPACE = /[ \t\n\r]*/y

class JsonSyntaxError extends Error {}

function parse(text: string): JsonNode {
  let pos = 0

  const skip = () => {
    WHITESPACE.lastIndex = pos
    WHITESPACE.exec(text)
    pos = WHITESPACE.lastIndex
  }
  const fail = (): never => {
    throw new JsonSyntaxError(`JSON no válido en la posición ${pos}`)
  }
  const match = (re: RegExp): string => {
    re.lastIndex = pos
    const m = re.exec(text)
    if (!m) fail()
    pos = re.lastIndex
    return m![0]
  }
  const literal = (word: string, node: JsonNode): JsonNode => {
    if (!text.startsWith(word, pos)) fail()
    pos += word.length
    return node
  }

  const value = (depth: number): JsonNode => {
    // Anidamiento absurdo: mejor texto plano que reventar la pila.
    if (depth > 500) fail()
    skip()
    const ch = text[pos]
    if (ch === '{') {
      pos++
      const entries: [string, JsonNode][] = []
      skip()
      if (text[pos] === '}') {
        pos++
        return { kind: 'object', entries }
      }
      for (;;) {
        skip()
        const key = JSON.parse(match(STRING)) as string
        skip()
        if (text[pos++] !== ':') fail()
        entries.push([key, value(depth + 1)])
        skip()
        const sep = text[pos++]
        if (sep === '}') return { kind: 'object', entries }
        if (sep !== ',') fail()
      }
    }
    if (ch === '[') {
      pos++
      const items: JsonNode[] = []
      skip()
      if (text[pos] === ']') {
        pos++
        return { kind: 'array', items }
      }
      for (;;) {
        items.push(value(depth + 1))
        skip()
        const sep = text[pos++]
        if (sep === ']') return { kind: 'array', items }
        if (sep !== ',') fail()
      }
    }
    if (ch === '"') return { kind: 'string', value: JSON.parse(match(STRING)) as string }
    if (ch === 't') return literal('true', { kind: 'boolean', value: true })
    if (ch === 'f') return literal('false', { kind: 'boolean', value: false })
    if (ch === 'n') return literal('null', { kind: 'null' })
    return { kind: 'number', raw: match(NUMBER) }
  }

  const root = value(0)
  skip()
  if (pos !== text.length) fail()
  return root
}

/**
 * Si el valor de la celda es un objeto o array JSON válido, su árbol; si no, null.
 * La expresión regular descarta enseguida lo que no puede ser JSON; el parser confirma que lo es de verdad.
 */
export function parseJsonCell(value: unknown): JsonNode | null {
  if (typeof value !== 'string' || value.length < 2 || value.length > MAX_JSON_LENGTH) return null
  if (!LOOKS_LIKE_JSON.test(value)) return null
  try {
    return parse(value)
  } catch (e) {
    if (e instanceof JsonSyntaxError || e instanceof SyntaxError) return null
    throw e
  }
}

/** Texto con sangría de 2 espacios, respetando números y orden de claves originales. */
export function formatJson(node: JsonNode, indent = ''): string {
  const inner = indent + '  '
  switch (node.kind) {
    case 'object':
      if (node.entries.length === 0) return '{}'
      return `{\n${node.entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJson(v, inner)}`).join(',\n')}\n${indent}}`
    case 'array':
      if (node.items.length === 0) return '[]'
      return `[\n${node.items.map((v) => inner + formatJson(v, inner)).join(',\n')}\n${indent}]`
    case 'string':
      return JSON.stringify(node.value)
    case 'number':
      return node.raw
    case 'boolean':
      return String(node.value)
    case 'null':
      return 'null'
  }
}
