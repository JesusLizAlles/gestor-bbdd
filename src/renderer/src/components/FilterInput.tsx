import { useEffect, useRef, useState } from 'react'
import type { Engine, TableRef } from '@shared/types'

interface Props {
  engine: Engine
  connectionId: string
  tableRef: TableRef
  /** Texto escrito (aún sin aplicar). */
  value: string
  /** Filtro aplicado: Esc vuelve a él. */
  applied: string
  onChange: (value: string) => void
  onApply: (value: string) => void
}

/** Campo WHERE del visor con historial de filtros de la tabla (▾ o flecha abajo). */
export function FilterInput({ engine, connectionId, tableRef, value, applied, onChange, onApply }: Props) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<string[]>([])
  const [index, setIndex] = useState(-1)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  // Se abre al momento con la última lista conocida y se refresca en segundo plano, para que
  // las flechas pulsadas justo después ya naveguen por ella.
  const openMenu = () => {
    setIndex(-1)
    setOpen(true)
    window.api
      .filterHistory(connectionId, tableRef)
      .then(setItems)
      .catch(() => setItems([]))
  }

  // Un clic fuera del campo cierra el desplegable.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = (where: string) => {
    setOpen(false)
    onChange(where)
    onApply(where)
    input.current?.focus()
  }

  const clear = async () => {
    await window.api.clearHistory(connectionId, 'filters', tableRef)
    setItems([])
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setIndex((i) => Math.min(items.length - 1, i + 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIndex((i) => Math.max(-1, i - 1))
        return
      }
      if (e.key === 'Enter' && index >= 0 && items[index] !== undefined) {
        e.preventDefault()
        choose(items[index])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        return
      }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      openMenu()
    } else if (e.key === 'Enter') {
      setOpen(false)
      onApply(value)
    } else if (e.key === 'Escape') {
      onChange(applied)
    }
  }

  return (
    <div className="filter" ref={box}>
      <span className="filter-label">WHERE</span>
      <input
        ref={input}
        aria-label="Filtro"
        aria-expanded={open}
        aria-autocomplete="list"
        placeholder={engine === 'mysql' ? "p. ej. estado = 'confirmada' AND importe > 100" : "p. ej. Codigo LIKE 'A%'"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {(applied || value) && (
        <button
          className="icon"
          title="Quitar filtro"
          onClick={() => {
            onChange('')
            onApply('')
          }}
        >
          ✕
        </button>
      )}
      <button
        className="icon"
        title="Filtros recientes (↓)"
        aria-label="Filtros recientes"
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        ▾
      </button>
      {open && (
        <div className="filter-menu" role="listbox" aria-label="Filtros recientes">
          {items.length === 0 && <div className="empty-note">Aún no has filtrado esta tabla.</div>}
          {items.map((w, i) => (
            <div
              key={w}
              role="option"
              aria-selected={i === index}
              className={`filter-option ${i === index ? 'on' : ''} ${w === applied ? 'current' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(w)
              }}
            >
              {w}
            </div>
          ))}
          {items.length > 0 && (
            <button className="link filter-clear" onMouseDown={(e) => e.preventDefault()} onClick={() => void clear()}>
              Borrar historial de filtros de esta tabla
            </button>
          )}
        </div>
      )}
    </div>
  )
}
