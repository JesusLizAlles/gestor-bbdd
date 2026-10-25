// Utilidades SQL sin dependencias, usadas tanto en el proceso principal como en la interfaz.
import type { Engine } from './types'

export interface Statement {
  /** Texto de la sentencia sin espacios alrededor ni delimitador final. */
  text: string
  /** Desplazamientos [start, end) del texto dentro del script original. */
  start: number
  end: number
  /** Palabras en mayúsculas fuera de cadenas y comentarios, en orden. */
  words: string[]
}

// En MySQL `#` abre un comentario; en T-SQL forma parte de nombres temporales (#tmp).
const WORD_CHAR_MY = /[A-Za-z0-9_$@]/
const WORD_CHAR_MS = /[A-Za-z0-9_$@#]/
const MSSQL_NON_BLOCK_BEGIN = new Set(['TRAN', 'TRANSACTION', 'DISTRIBUTED', 'DIALOG', 'CONVERSATION'])
const MSSQL_WHOLE_BATCH_OBJECTS = new Set(['PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'VIEW'])
const GO_LINE = /^[ \t]*GO(?:[ \t]+\d+)?[ \t]*(?:--[^\n]*)?(?:\r?\n|$)/i
const DELIMITER_LINE = /^[ \t]*DELIMITER[ \t]+(\S+)[^\n]*(?:\r?\n|$)/i

/**
 * Divide un script en sentencias.
 *
 * MySQL: separa por el delimitador activo (`;` por defecto) y respeta `DELIMITER xx`.
 * SQL Server: separa por `GO` en línea propia y por `;` fuera de bloques BEGIN…END/CASE…END.
 * Un CREATE/ALTER de procedimiento, función, trigger o vista ocupa todo el lote hasta `GO`.
 */
export function splitStatements(sql: string, engine: Engine): Statement[] {
  const statements: Statement[] = []
  const isMy = engine === 'mysql'
  const wordChar = isMy ? WORD_CHAR_MY : WORD_CHAR_MS
  let delimiter = ';'

  let stmtStart = 0
  let hasCode = false
  // La sentencia empieza en su primer código: los comentarios previos no forman parte de ella.
  let codeStart = 0
  let words: string[] = []
  // Solo SQL Server
  let depth = 0
  let pendingBegin = false
  let wholeBatch = false

  const flush = (endExclusive: number, nextStart: number): void => {
    if (hasCode) {
      const text = sql.slice(codeStart, endExclusive).trimEnd()
      statements.push({ text, start: codeStart, end: codeStart + text.length, words })
    }
    stmtStart = nextStart
    hasCode = false
    words = []
    depth = 0
    pendingBegin = false
    wholeBatch = false
  }

  const markCode = (pos: number): void => {
    if (!hasCode) codeStart = pos
    hasCode = true
  }

  const atLineStart = (pos: number): boolean => {
    let j = pos - 1
    while (j >= 0 && (sql[j] === ' ' || sql[j] === '\t')) j--
    return j < 0 || sql[j] === '\n'
  }

  const onWord = (word: string): void => {
    const upper = word.toUpperCase()
    words.push(upper)
    if (isMy) return
    if (words.length === 2 || words.length === 4) {
      // CREATE PROC…, ALTER VIEW…, CREATE OR ALTER FUNCTION…
      const [w0, w1, w2, w3] = words
      if ((w0 === 'CREATE' || w0 === 'ALTER') && MSSQL_WHOLE_BATCH_OBJECTS.has(w1 ?? '')) wholeBatch = true
      if (w0 === 'CREATE' && w1 === 'OR' && w2 === 'ALTER' && MSSQL_WHOLE_BATCH_OBJECTS.has(w3 ?? '')) wholeBatch = true
    }
    if (pendingBegin) {
      pendingBegin = false
      if (!MSSQL_NON_BLOCK_BEGIN.has(upper)) depth++
    }
    if (upper === 'BEGIN') pendingBegin = true
    else if (upper === 'CASE') depth++
    else if (upper === 'END' && depth > 0) depth--
  }

  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]!
    const next = sql[i + 1]

    // Comandos de cliente que ocupan una línea entera.
    if ((ch === 'D' || ch === 'd' || ch === 'G' || ch === 'g' || ch === ' ' || ch === '\t') && atLineStart(i)) {
      const rest = sql.slice(i, Math.min(n, i + 400))
      if (isMy && !hasCode) {
        const m = DELIMITER_LINE.exec(rest)
        if (m) {
          delimiter = m[1]!
          i += m[0].length
          stmtStart = i
          continue
        }
      }
      if (!isMy) {
        const m = GO_LINE.exec(rest)
        if (m) {
          flush(i, i + m[0].length)
          i += m[0].length
          continue
        }
      }
    }

    // Delimitador de sentencia.
    if (isMy ? sql.startsWith(delimiter, i) : ch === ';' && depth === 0 && !wholeBatch) {
      const len = isMy ? delimiter.length : 1
      flush(i, i + len)
      i += len
      continue
    }

    // Comentarios de línea.
    if ((ch === '-' && next === '-' && (!isMy || /\s/.test(sql[i + 2] ?? '\n'))) || (isMy && ch === '#')) {
      while (i < n && sql[i] !== '\n') i++
      continue
    }

    // Comentarios de bloque (anidables en T-SQL). En MySQL, /*! … */ y /*+ … */ se ejecutan: son código.
    if (ch === '/' && next === '*') {
      if (isMy && (sql[i + 2] === '!' || sql[i + 2] === '+')) markCode(i)
      let nest = 1
      i += 2
      while (i < n && nest > 0) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          nest--
          i += 2
        } else if (!isMy && sql[i] === '/' && sql[i + 1] === '*') {
          nest++
          i += 2
        } else i++
      }
      continue
    }

    // Cadenas e identificadores entre comillas.
    const close = ch === "'" || ch === '"' ? ch : ch === '`' && isMy ? '`' : ch === '[' && !isMy ? ']' : null
    if (close) {
      markCode(i)
      if (pendingBegin) pendingBegin = false
      i++
      while (i < n) {
        const c = sql[i]!
        if (isMy && c === '\\' && close !== '`') {
          i += 2
          continue
        }
        if (c === close) {
          if (sql[i + 1] === close) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }

    if (wordChar.test(ch)) {
      const startWord = i
      // `$` es válido en identificadores MySQL, así que un delimitador como `$$` corta la palabra.
      while (i < n && wordChar.test(sql[i]!) && !(isMy && sql.startsWith(delimiter, i))) i++
      markCode(startWord)
      onWord(sql.slice(startWord, i))
      continue
    }

    if (!/\s/.test(ch)) markCode(i)
    i++
  }
  flush(n, n)
  return statements
}

/**
 * Sentencia en la posición del cursor: la que contiene el offset o, si el cursor
 * está entre sentencias, la inmediatamente anterior.
 */
export function statementAt(statements: Statement[], offset: number): Statement | null {
  let candidate: Statement | null = null
  for (const s of statements) {
    if (s.start <= offset) candidate = s
    else break
  }
  return candidate ?? statements[0] ?? null
}

const READ_FIRST_WORDS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'USE', 'HELP'])
const WRITE_WORDS = new Set([
  'INTO', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE',
  'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'CALL', 'RENAME', 'LOCK'
])

/**
 * Clasificación conservadora: true solo si la sentencia empieza por una palabra de
 * lectura y no contiene ninguna palabra de escritura fuera de cadenas y comentarios.
 * `SELECT … FOR UPDATE` o `SELECT … INTO` cuentan como escritura a propósito.
 */
export function isReadOnlyStatement(words: string[]): boolean {
  const first = words[0]
  if (!first || !READ_FIRST_WORDS.has(first)) return false
  return !words.some((w) => WRITE_WORDS.has(w))
}
