// Monaco cargado desde el propio paquete (sin CDN) con solo lo necesario para SQL.
import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/features/register.all.js'
import 'monaco-editor/languages/definitions/mysql/register.js'
import 'monaco-editor/languages/definitions/sql/register.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { tableAliases } from '@shared/completion'
import type { CompletionColumn, Engine } from '@shared/types'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

monaco.editor.defineTheme('gestor-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#1e1f22', 'editor.lineHighlightBackground': '#26282e' }
})

export const languageFor = (engine: Engine): string => (engine === 'mysql' ? 'mysql' : 'sql')

/** Datos que usa el autocompletado; los actualiza la consola activa. */
export interface CompletionSource {
  engine: Engine
  tables: { name: string; schema: string | null }[]
  columns: CompletionColumn[]
  /** Añade a `columns` las de estas tablas si aún no están (la carga inicial puede venir recortada). */
  ensureColumns(tables: string[]): Promise<void>
}

let completionSource: CompletionSource | null = null

export function setCompletionSource(source: CompletionSource | null): void {
  completionSource = source
}

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT',
  'DISTINCT', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'UNION', 'UNION ALL', 'INSERT INTO',
  'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'DESC', 'ASC', 'TOP'
]

let registered = false

/** Registra (una sola vez) el proveedor de autocompletado de tablas y columnas. */
export function registerCompletion(): void {
  if (registered) return
  registered = true
  for (const language of ['mysql', 'sql']) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.'],
      async provideCompletionItems(model, position) {
        const source = completionSource
        if (!source) return { suggestions: [] }
        const word = model.getWordUntilPosition(position)
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
        const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1)
        const aliases = tableAliases(model.getValue())
        const qualifier = /([\w$#]+)\s*\.\s*$/.exec(before)?.[1]?.toLowerCase()
        await source.ensureColumns(qualifier ? [aliases.get(qualifier) ?? qualifier] : [...aliases.values()])
        const K = monaco.languages.CompletionItemKind
        const tableSuggestion = (t: CompletionSource['tables'][number], sort: string) => ({
          label: t.name,
          kind: K.Struct,
          detail: t.schema && t.schema !== 'dbo' ? `tabla · ${t.schema}` : 'tabla',
          insertText: t.name,
          range,
          sortText: `${sort}${t.name}`
        })

        // Tras "alias." o "tabla." → columnas de esa tabla; tras "esquema." → sus tablas.
        if (qualifier) {
          const table = (aliases.get(qualifier) ?? qualifier).toLowerCase()
          const cols = source.columns.filter((c) => c.table.toLowerCase() === table)
          if (cols.length) {
            return {
              suggestions: cols.map((c, i) => ({
                label: c.column,
                kind: K.Field,
                detail: c.dataType,
                insertText: c.column,
                range,
                sortText: String(i).padStart(4, '0')
              }))
            }
          }
          const inSchema = source.tables.filter((t) => t.schema?.toLowerCase() === qualifier)
          return { suggestions: inSchema.map((t) => tableSuggestion(t, '0')) }
        }

        // Columnas de las tablas que ya aparecen en la consulta, primero.
        const used = new Set([...aliases.values()].map((t) => t.toLowerCase()))
        const suggestions: monaco.languages.CompletionItem[] = []
        const seen = new Set<string>()
        const isUsed = (c: CompletionColumn) => used.has(c.table.toLowerCase())
        // Cada nombre de columna una sola vez; si existe en una tabla de la consulta, gana esa.
        for (const c of [...source.columns].sort((a, b) => Number(isUsed(b)) - Number(isUsed(a)))) {
          const inQuery = isUsed(c)
          if (seen.has(c.column)) continue
          seen.add(c.column)
          suggestions.push({
            label: c.column,
            kind: K.Field,
            detail: `${c.table} · ${c.dataType}`,
            insertText: c.column,
            range,
            sortText: `${inQuery ? '0' : '3'}${c.column}`
          })
        }
        for (const t of source.tables) suggestions.push(tableSuggestion(t, used.has(t.name.toLowerCase()) ? '1' : '2'))
        for (const k of KEYWORDS) suggestions.push({ label: k, kind: K.Keyword, insertText: k, range, sortText: `4${k}` })
        return { suggestions }
      }
    })
  }
}

export { monaco }
