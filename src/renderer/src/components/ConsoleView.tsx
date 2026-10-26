import { useEffect, useRef, useState } from 'react'
import { splitStatements, statementAt } from '@shared/sql'
import type { ConnectionSummary, ConsoleState, QueryResult } from '@shared/types'
import { DEFAULT_MAX_ROWS } from '@shared/types'
import { setCompletionSource, type CompletionSource } from '../lib/monaco'
import { isMac, keys } from '../lib/platform'
import { ConfirmDialog } from './ConfirmDialog'
import { QueryHistoryPanel } from './QueryHistoryPanel'
import { ResultsPanel } from './ResultsPanel'
import { SqlEditor, type EditorCommands, type EditorState, type SqlEditorHandle } from './SqlEditor'

/** Consola de una conexión y base de datos: hay una por pareja y lo escrito se guarda. */
export interface OpenConsole {
  type: 'console'
  id: string
  sessionId: string
  connection: ConnectionSummary
  title: string
  /** Base de datos para la que se abrió: identifica la consola guardada. */
  homeDatabase: string | null
}

interface Props {
  tab: OpenConsole
  active: boolean
  /** Sentencia que añadir al final (p. ej. desde el visor de tablas); `nonce` la distingue de la anterior. */
  sqlRequest: { sql: string; nonce: number } | null
}

/** Se guarda tras esta pausa al escribir, y en el momento al cerrar la pestaña o la app. */
const SAVE_DELAY_MS = 500

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
export function ConsoleView({ tab, active, sqlRequest }: Props) {
  const { sessionId, connection, homeDatabase } = tab
  const engine = connection.engine
  const [databases, setDatabases] = useState<string[]>([])
  const [database, setDatabase] = useState<string | null>(homeDatabase)
  /** Consola guardada: undefined mientras se lee; null si no había. */
  const [saved, setSaved] = useState<ConsoleState | null | undefined>(undefined)
  const [results, setResults] = useState<QueryResult[]>([])
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [confirm, setConfirm] = useState<{ sql: string; statements: string[] } | null>(null)
  const [maxRows, setMaxRows] = useState(readMaxRows)
  const [editorHeight, setEditorHeight] = useState(280)
  const [schemaVersion, setSchemaVersion] = useState(0)
  const [completionState, setCompletionState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const editorRef = useRef<SqlEditorHandle>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  // Sube tras cada ejecución para que el panel de historial se recargue.
  const [historyVersion, setHistoryVersion] = useState(0)

  // Ctrl+Alt+E (Cmd+Opción+E en macOS) abre o cierra el historial, como en DataGrip.
  // Por e.code: con Opción, la E del Mac es una tecla muerta y e.key no vale «e».
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.altKey && e.code === 'KeyE') {
        e.preventDefault()
        setHistoryOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  useEffect(() => {
    let cancelled = false
    window.api
      .loadConsole(connection.id, homeDatabase)
      .catch(() => null)
      .then((state) => {
        if (cancelled) return
        setSaved(state)
        if (state) setDatabase(state.database)
      })
    return () => {
      cancelled = true
    }
  }, [connection.id, homeDatabase])

  // Guardado: el último estado del editor y un temporizador; flush() escribe si hay algo pendiente.
  const editorState = useRef<EditorState | null>(null)
  const databaseRef = useRef(database)
  databaseRef.current = database
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flush = useRef(() => {})
  flush.current = () => {
    if (saveTimer.current === undefined) return
    clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    const state = editorState.current
    if (state) void window.api.saveConsole(connection.id, homeDatabase, { ...state, database: databaseRef.current }).catch(() => {})
  }
  const scheduleSave = () => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => flush.current(), SAVE_DELAY_MS)
  }
  const onEditorState = (state: EditorState) => {
    editorState.current = state
    scheduleSave()
  }

  // Cambiar de base de datos también se guarda (solo depende de database: scheduleSave usa refs).
  useEffect(() => {
    if (saved !== undefined) scheduleSave()
  }, [database])

  // Al cerrar la pestaña (desmontar) o la app, lo pendiente se guarda ya.
  useEffect(() => {
    const onUnload = () => flush.current()
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      flush.current()
    }
  }, [])

  // SQL que llega de fuera: se añade al final, también si la consola ya estaba abierta.
  const handledRequest = useRef(0)
  useEffect(() => {
    if (saved === undefined || !sqlRequest || sqlRequest.nonce === handledRequest.current) return
    handledRequest.current = sqlRequest.nonce
    editorRef.current?.appendStatement(sqlRequest.sql)
  }, [saved, sqlRequest])

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
      setHistoryVersion((v) => v + 1)
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
          title={keys('Ejecutar la sentencia bajo el cursor (Ctrl+Enter)')}
          onClick={() => editorRef.current?.runCurrent()}
        >
          ▶ Ejecutar
        </button>
        <button className="compact" disabled={running} title={keys('Ejecutar todo el script (Ctrl+Shift+Enter)')} onClick={() => editorRef.current?.runAll()}>
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
        <button
          className={`compact ${historyOpen ? 'on' : ''}`}
          aria-pressed={historyOpen}
          title={keys('Historial de consultas (Ctrl+Alt+E)')}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          Historial
        </button>
        <div className="spacer" />
        <span className="hint">
          {completionState === 'loading' && 'Cargando tablas para el autocompletado… · '}
          {completionState === 'error' && 'No se pudo cargar el autocompletado · '}
          {!database && 'Elige una base de datos para autocompletar · '}
          <kbd>{keys('Ctrl')}</kbd>+<kbd>Enter</kbd> sentencia actual
        </span>
      </div>
      <div className="console-body">
        <div className="workspace">
          <div className="editor-host" style={{ height: editorHeight }}>
            {saved !== undefined && (
              <SqlEditor
                ref={editorRef}
                engine={engine}
                initialValue={saved?.text ?? ''}
                initialView={saved ?? undefined}
                onStateChange={onEditorState}
                commands={commands}
              />
            )}
          </div>
          <div className="splitter" onMouseDown={startResize} />
          <ResultsPanel engine={engine} results={results} running={running} message={message} maxRows={maxRows} />
        </div>
        {historyOpen && (
          <QueryHistoryPanel
            connectionId={connection.id}
            refreshKey={historyVersion}
            onInsert={(text) => editorRef.current?.insertAtCursor(text)}
            onClose={() => setHistoryOpen(false)}
          />
        )}
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
