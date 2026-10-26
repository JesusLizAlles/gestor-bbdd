import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Engine } from '@shared/types'

/** Bases de datos del propio servidor: se marcan y se pueden ocultar de una vez. */
const SYSTEM_DATABASES: Record<Engine, string[]> = {
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  mssql: ['master', 'model', 'msdb', 'tempdb']
}

interface Props {
  engine: Engine
  /** Bases de datos del servidor. */
  databases: string[]
  /** undefined = todas. */
  visible: string[] | undefined
  onChange: (visible: string[] | null) => void
  /** Botón que lo abre: se coloca debajo y pulsarlo no cuenta como clic fuera. */
  anchor: HTMLElement
  onClose: () => void
}

/** Desplegable para elegir qué bases de datos de una conexión aparecen en el explorador. */
export function DatabasePicker({ engine, databases, visible, onChange, anchor, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const system = new Set(SYSTEM_DATABASES[engine])
  const rect = anchor.getBoundingClientRect()

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])

  const base = visible ?? databases
  const toggle = (db: string) => onChange(base.includes(db) ? base.filter((d) => d !== db) : [...base, db])
  // Seleccionadas que ya no existen en el servidor: se enseñan para poder quitarlas.
  const missing = (visible ?? []).filter((d) => !databases.includes(d))
  const needle = search.trim().toLowerCase()
  const rows = [...databases, ...missing].filter((d) => d.toLowerCase().includes(needle))

  return createPortal(
    <div
      ref={ref}
      className="db-picker"
      role="dialog"
      aria-label="Bases de datos visibles"
      style={{ top: rect.bottom + 4, left: rect.left, maxHeight: window.innerHeight - rect.bottom - 16 }}
    >
      <div className="db-picker-head">
        <label>
          <input type="checkbox" checked={!visible} onChange={() => onChange(visible ? null : [])} />
          Todas
        </label>
        <button className="link" onClick={() => onChange(base.filter((d) => !system.has(d)))}>
          Ocultar las del sistema
        </button>
      </div>
      {databases.length > 12 && (
        <input className="db-picker-search" autoFocus placeholder="Buscar…" value={search} onChange={(e) => setSearch(e.target.value)} />
      )}
      <div className="db-picker-list">
        {rows.map((db) => {
          const gone = missing.includes(db)
          return (
            <label key={db} className={gone ? 'missing' : ''} title={gone ? 'Ya no existe en el servidor' : undefined}>
              <input type="checkbox" checked={!visible || visible.includes(db)} onChange={() => toggle(db)} />
              <span className="db-picker-name">{db}</span>
              {system.has(db) && (
                <span className="db-picker-system" title="Base de datos del sistema">
                  ⚡
                </span>
              )}
            </label>
          )
        })}
        {rows.length === 0 && <div className="db-picker-empty">Sin coincidencias</div>}
      </div>
    </div>,
    document.body
  )
}
