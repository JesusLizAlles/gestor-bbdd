import { useEffect, useRef, useState } from 'react'
import type { QueryHistoryEntry } from '@shared/types'

interface Props {
  connectionId: string
  /** Cambia tras cada ejecución para recargar la lista. */
  refreshKey: number
  onInsert: (sql: string) => void
  onClose: () => void
}

/** "ahora", "hace 5 min", "hoy 10:32" o "24/10 18:05". */
export function formatWhen(iso: string, now = new Date()): string {
  const date = new Date(iso)
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000)
  if (minutes < 1) return 'ahora'
  if (minutes < 60) return `hace ${minutes} min`
  const time = date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === now.toDateString()) return `hoy ${time}`
  return `${date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })} ${time}`
}

/** Panel lateral con el historial de la consola (Ctrl+Alt+E), como en DataGrip. */
export function QueryHistoryPanel({ connectionId, refreshKey, onInsert, onClose }: Props) {
  const [entries, setEntries] = useState<QueryHistoryEntry[]>([])
  const [search, setSearch] = useState('')
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    // Pequeña espera para no consultar en cada tecla del buscador.
    const timer = setTimeout(() => {
      window.api
        .queryHistory(connectionId, search || undefined)
        .then((value) => {
          if (cancelled) return
          setEntries(value)
          setIndex(0)
          setError(null)
        })
        .catch((err: Error) => !cancelled && setError(err.message))
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [connectionId, search, refreshKey])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(entries.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' && entries[index]) {
      e.preventDefault()
      onInsert(entries[index].sql)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const clear = async () => {
    if (!window.confirm('¿Borrar todo el historial de consultas de esta conexión?')) return
    await window.api.clearHistory(connectionId, 'queries')
    setEntries([])
  }

  return (
    <aside className="history-panel" aria-label="Historial de consultas">
      <div className="history-header">
        <strong>Historial</strong>
        <span className="note">Enter o doble clic: insertar</span>
        <span className="spacer" />
        <button className="icon" title="Cerrar (Esc)" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="history-search">
        <input
          autoFocus
          aria-label="Buscar en el historial"
          placeholder="Buscar…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="history-list" ref={list} role="listbox" aria-label="Consultas ejecutadas">
        {error && <div className="tree-error">{error}</div>}
        {!error && entries.length === 0 && (
          <div className="empty-note">{search ? 'Nada coincide con la búsqueda.' : 'Aún no se ha ejecutado nada en esta conexión.'}</div>
        )}
        {entries.map((e, i) => (
          <div
            key={e.id}
            data-index={i}
            role="option"
            aria-selected={i === index}
            className={`history-item ${i === index ? 'on' : ''} ${e.error ? 'failed' : ''}`}
            title={e.sql}
            onClick={() => setIndex(i)}
            onDoubleClick={() => onInsert(e.sql)}
          >
            <pre className="history-sql">{e.sql}</pre>
            <div className="history-meta">
              <span>{formatWhen(e.executedAt)}</span>
              {e.database && <span>{e.database}</span>}
              <span>{e.durationMs} ms</span>
              {e.error ? (
                <span className="history-error">Error</span>
              ) : (
                e.rowCount !== null && (
                  <span>
                    {e.rowCount} fila{e.rowCount === 1 ? '' : 's'}
                  </span>
                )
              )}
              <span className="spacer" />
              <button className="link" onClick={() => onInsert(e.sql)}>
                Insertar
              </button>
              <button className="link" onClick={() => void navigator.clipboard.writeText(e.sql)}>
                Copiar
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="history-footer">
        <span className="note">{entries.length ? `${entries.length} consulta${entries.length === 1 ? '' : 's'}` : ''}</span>
        <span className="spacer" />
        <button className="link" disabled={entries.length === 0 && !search} onClick={() => void clear()}>
          Borrar historial
        </button>
      </div>
    </aside>
  )
}
