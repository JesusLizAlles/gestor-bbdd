import { useEffect, useRef, useState } from 'react'
import { splitStatements, statementAt } from '@shared/sql'
import type { ConnectionSummary, QueryResult } from '@shared/types'
import { DEFAULT_MAX_ROWS } from '@shared/types'
import { setCompletionSource, type CompletionSource } from '../lib/monaco'
import { ConfirmDialog } from './ConfirmDialog'
import { ResultsPanel } from './ResultsPanel'
import { SqlEditor, type EditorCommands, type SqlEditorHandle } from './SqlEditor'

export interface OpenConsole {
  type: 'console'
  id: string
  sessionId: string
  connection: ConnectionSummary
  title: string
  initialDatabase: string | null
  initialSql: string
}

interface Props {
  tab: OpenConsole
  active: boolean
}

const ROW_LIMITS = [100, 500, 1000, 5000, 20000]

function readMaxRows(): number {
  try {
    const stored = Number(localStorage.getItem('maxRows'))
    return ROW_LIMITS.includes(stored) ? stored : DEFAULT_MAX_ROWS
  } catch {
    return DEFAULT_MAX_ROWS
  }
}

// Tablas y columnas por sesión y base de datos, compartidas entre consolas de la misma conexión.
const completionCache = new Map<string, Promise<CompletionSource>>()

function loadCompletion(sessionId: string, database: string, engine: CompletionSource['engine']): Promise<CompletionSource> {
  const key = `${sessionId}|${database}`
  let load = completionCache.get(key)
  if (!load) {
    load = Promise.all([window.api.listTables(sessionId, database), window.api.completionColumns(sessionId, database)]).then(
      ([tables, columns]) => ({ engine, tables, columns })
    )
    load.catch(() => completionCache.delete(key))
    completionCache.set(key, load)
  }
  return load
}

const DDL = /^\s*(CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i

/** Consola SQL de una conexión, con la base de datos elegida en la barra de herramientas. */
export function ConsoleView({ tab, active }: Props) {
  const { sessionId, connection } = tab
  const engine = connection.engine
  const [databases, setDatabases] = useState<string[]>([])
  const [database, setDatabase] = useState<string | null>(tab.initialDatabase)
  const [results, setResults] = useState<QueryResult[]>([])
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [confirm, setConfirm] = useState<{ sql: string; statements: string[] } | null>(null)
  const [maxRows, setMaxRows] = useState(readMaxRows)
  const [editorHeight, setEditorHeight] = useState(280)
  const [schemaVersion, setSchemaVersion] = useState(0)
  const [completionState, setCompletionState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const editorRef = useRef<SqlEditorHandle>(null)

  useEffect(() => {
    window.api
      .listDatabases(sessionId)
      .then(setDatabases)
      .catch(() => setDatabases([]))
  }, [sessionId])

  // Autocompletado de la base de datos elegida, solo mientras esta consola está visible.
  useEffect(() => {
    if (!active) return
    if (!database) {
      setCompletionSource(null)
      setCompletionState('idle')
      return
    }
    let cancelled = false
    setCompletionState('loading')
    loadCompletion(sessionId, database, engine)
      .then((source) => {
        if (cancelled) return
        setCompletionSource(source)
        setCompletionState('ready')
      })
      .catch(() => !cancelled && setCompletionState('error'))
    return () => {
      cancelled = true
    }
  }, [active, sessionId, database, engine, schemaVersion])

  const execute = async (text: string, confirmedWrite = false) => {
    if (!text.trim() || running) return
    setRunning(true)
    setMessage(null)
    try {
      const out = await window.api.runQuery(sessionId, { sql: text, database, maxRows, confirmedWrite })
      if (out.blocked === 'readOnly') {
        setResults([])
        setMessage({
          kind: 'error',
          text: `Conexión de solo lectura: no se ha ejecutado nada.\nSentencias bloqueadas:\n${out.blockedStatements?.join('\n') ?? ''}`
        })
      } else if (out.blocked === 'needsConfirmation') {
        setConfirm({ sql: text, statements: out.blockedStatements ?? [] })
      } else {
        setResults(out.results)
        if (out.results.length === 0) setMessage({ kind: 'info', text: 'Nada que ejecutar' })
        // Tras un cambio de estructura, el autocompletado se vuelve a cargar.
        if (database && out.results.some((r) => DDL.test(r.statement))) {
          completionCache.delete(`${sessionId}|${database}`)
          setSchemaVersion((v) => v + 1)
        }
      }
    } catch (err) {
      setResults([])
      setMessage({ kind: 'error', text: (err as Error).message })
    } finally {
      setRunning(false)
    }
  }

  const commands: EditorCommands = {
    runCurrent: (text, selection, offset) => {
      if (selection) return void execute(text)
      const stmt = statementAt(splitStatements(text, engine), offset)
      if (stmt) void execute(stmt.text)
    },
    runAll: (text) => void execute(text)
  }

  const startResize = (e: React.MouseEvent) => {
    const startY = e.clientY
    const startHeight = editorHeight
    const move = (ev: MouseEvent) => setEditorHeight(Math.max(80, Math.min(window.innerHeight - 220, startHeight + ev.clientY - startY)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="console-view" style={{ display: active ? 'flex' : 'none' }}>
      <div className="table-toolbar">
        <select
          className="compact db-select"
          aria-label="Base de datos"
          value={database ?? ''}
          onChange={(e) => setDatabase(e.target.value || null)}
        >
          <option value="">(sin base de datos)</option>
          {databases.map((db) => (
            <option key={db} value={db}>
              {db}
            </option>
          ))}
        </select>
        <button
          className="compact primary"
          disabled={running}
          title="Ejecutar la sentencia bajo el cursor (Ctrl+Enter)"
          onClick={() => editorRef.current?.runCurrent()}
        >
          ▶ Ejecutar
        </button>
        <button className="compact" disabled={running} title="Ejecutar todo el script (Ctrl+Shift+Enter)" onClick={() => editorRef.current?.runAll()}>
          ▶▶ Todo
        </button>
        <button className="compact" disabled={!running} onClick={() => void window.api.cancelQuery(sessionId)}>
          ■ Cancelar
        </button>
        <select
          className="compact"
          value={maxRows}
          title="Máximo de filas por resultado"
          onChange={(e) => {
            const value = Number(e.target.value)
            setMaxRows(value)
            try {
              localStorage.setItem('maxRows', String(value))
            } catch {
              /* sin almacenamiento local: solo dura esta sesión */
            }
          }}
        >
          {ROW_LIMITS.map((n) => (
            <option key={n} value={n}>
              {n} filas
            </option>
          ))}
        </select>
        <div className="spacer" />
        <span className="hint">
          {completionState === 'loading' && 'Cargando tablas para el autocompletado… · '}
          {completionState === 'error' && 'No se pudo cargar el autocompletado · '}
          {!database && 'Elige una base de datos para autocompletar · '}
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> sentencia actual
        </span>
      </div>
      <div className="workspace">
        <div className="editor-host" style={{ height: editorHeight }}>
          <SqlEditor ref={editorRef} engine={engine} initialValue={tab.initialSql} commands={commands} />
        </div>
        <div className="splitter" onMouseDown={startResize} />
        <ResultsPanel engine={engine} results={results} running={running} message={message} maxRows={maxRows} />
      </div>

      {confirm && (
        <ConfirmDialog
          title="Escritura en producción"
          confirmLabel="Ejecutar igualmente"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { sql: text } = confirm
            setConfirm(null)
            void execute(text, true)
          }}
        >
          <p>Estas sentencias modifican datos o estructura en una conexión de producción:</p>
          <div className="stmt-list">{confirm.statements.join(';\n\n')}</div>
        </ConfirmDialog>
      )}
    </div>
  )
}
