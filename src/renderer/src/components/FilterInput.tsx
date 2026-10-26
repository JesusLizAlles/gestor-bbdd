import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { suggest, tokenize, type FilterColumn, type Suggestion } from '@shared/filter'
import type { Engine, TableRef } from '@shared/types'

interface Props {
  engine: Engine
  connectionId: string
  tableRef: TableRef
  /** Columnas de la tabla, para colorearlas y sugerirlas. */
  columns: FilterColumn[]
  /** Texto escrito (aún sin aplicar). */
  value: string
  /** Filtro aplicado: Esc vuelve a él. */
  applied: string
  onChange: (value: string) => void
  onApply: (value: string) => void
}

type Menu = { kind: 'history' } | { kind: 'suggest'; items: Suggestion[]; from: number; to: number } | null

const KIND_MARK: Record<Suggestion['kind'], string> = { column: 'c', keyword: 'k', operator: 'op', function: 'f', value: 'v' }

/** Filtro coloreado como código: cada trozo en su `<span>` con la clase del tipo. */
export function Highlighted({ text, engine, columns }: { text: string; engine: Engine; columns: Iterable<string> }) {
  return (
    <>
      {tokenize(text, engine, columns).map((t) => (
        <span key={t.start} className={`tok-${t.type}`}>
          {t.text}
        </span>
      ))}
    </>
  )
}

/**
 * Campo WHERE del visor: coloreado, con sugerencias de columnas y sintaxis SQL mientras se escribe
 * (o con Ctrl+Espacio) y con historial de filtros de la tabla (▾ o flecha abajo).
 */
export function FilterInput({ engine, connectionId, tableRef, columns, value, applied, onChange, onApply }: Props) {
  const [menu, setMenu] = useState<Menu>(null)
  const [items, setItems] = useState<string[]>([])
  const [index, setIndex] = useState(-1)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // Cursor que hay que colocar tras el próximo render (al aceptar una sugerencia).
  const pendingCaret = useRef<number | null>(null)
  const names = useMemo(() => columns.map((c) => c.name), [columns])

  // La capa coloreada sigue al desplazamiento horizontal del campo.
  const syncScroll = () => {
    if (layer.current && input.current) layer.current.style.transform = `translateX(${-input.current.scrollLeft}px)`
  }

  useLayoutEffect(() => {
    const caret = pendingCaret.current
    if (caret !== null && input.current) {
      pendingCaret.current = null
      input.current.setSelectionRange(caret, caret)
    }
    syncScroll()
  }, [value])

  // Se abre al momento con la última lista conocida y se refresca en segundo plano, para que
  // las flechas pulsadas justo después ya naveguen por ella.
  const openHistory = () => {
    setIndex(-1)
    setMenu({ kind: 'history' })
    window.api
      .filterHistory(connectionId, tableRef)
      .then(setItems)
      .catch(() => setItems([]))
  }

  /**
   * Abre (o cierra) las sugerencias para el texto y cursor dados. Sin nada escrito de la palabra
   * no hay ninguna preseleccionada, para que Enter siga aplicando el filtro.
   */
  const openSuggestions = (text: string, cursor: number, forced = false) => {
    const result = suggest(text, cursor, engine, columns)
    const exact = result.items.length === 1 && result.items[0]!.label.toLowerCase() === result.prefix.toLowerCase()
    if (result.items.length === 0 || (exact && !forced)) {
      setMenu((m) => (m?.kind === 'suggest' ? null : m))
      return
    }
    const typed = result.prefix !== '' && !result.items.some((s) => s.label.toLowerCase() === result.prefix.toLowerCase())
    setIndex(typed || forced ? 0 : -1)
    setMenu({ kind: 'suggest', items: result.items, from: result.from, to: result.to })
  }

  // Un clic fuera del campo cierra el desplegable.
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])

  // La opción marcada con el teclado siempre a la vista.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, menu])

  const choose = (where: string) => {
    setMenu(null)
    onChange(where)
    onApply(where)
    input.current?.focus()
  }

  const accept = (s: Suggestion) => {
    if (menu?.kind !== 'suggest') return
    const after = value.slice(menu.to)
    // Sin cursor propio, se deja un espacio detrás y se encadenan las sugerencias siguientes
    // (columna → comparadores → valores → AND/OR).
    const insert = s.caret === undefined && !/^\s/.test(after) ? `${s.insert} ` : s.insert
    const next = value.slice(0, menu.from) + insert + after
    const caret = menu.from + (s.caret ?? insert.length)
    pendingCaret.current = caret
    onChange(next)
    input.current?.focus()
    if (s.caret === undefined) openSuggestions(next, caret)
    else setMenu(null)
  }

  const clear = async () => {
    await window.api.clearHistory(connectionId, 'filters', tableRef)
    setItems([])
    setMenu(null)
  }

  const optionCount = menu?.kind === 'suggest' ? menu.items.length : items.length

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault()
      const el = e.currentTarget
      openSuggestions(value, el.selectionStart ?? value.length, true)
      return
    }
    if (menu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setIndex((i) => Math.min(optionCount - 1, i + 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIndex((i) => Math.max(-1, i - 1))
        return
      }
      if (menu.kind === 'suggest' && (e.key === 'Tab' || e.key === 'Enter')) {
        const s = menu.items[index] ?? (e.key === 'Tab' ? menu.items[0] : undefined)
        if (s) {
          e.preventDefault()
          accept(s)
          return
        }
      }
      if (menu.kind === 'history' && e.key === 'Enter' && index >= 0 && items[index] !== undefined) {
        e.preventDefault()
        choose(items[index])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenu(null)
        return
      }
      if (menu.kind === 'suggest' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) setMenu(null)
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      openHistory()
    } else if (e.key === 'Enter') {
      setMenu(null)
      onApply(value)
    } else if (e.key === 'Escape') {
      onChange(applied)
    }
  }

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value
    const cursor = e.target.selectionStart ?? next.length
    onChange(next)
    // Se sugiere al escribir una palabra o un espacio, no al borrar ni al pegar.
    const typed = next.length === value.length + 1 ? next[cursor - 1] : undefined
    if (typed !== undefined && /[\w@$#\s(,=<>À-￿]/.test(typed)) openSuggestions(next, cursor)
    else if (menu?.kind === 'suggest') openSuggestions(next, cursor)
  }

  return (
    <div className="filter" ref={box}>
      <span className="filter-label">WHERE</span>
      <div className="filter-field">
        <div className="filter-layer" aria-hidden="true">
          <div ref={layer}>
            <Highlighted text={value} engine={engine} columns={names} />
          </div>
        </div>
        <input
          ref={input}
          aria-label="Filtro"
          aria-expanded={menu !== null}
          aria-autocomplete="list"
          spellCheck={false}
          placeholder={engine === 'mysql' ? "p. ej. estado = 'confirmada' AND importe > 100" : "p. ej. Codigo LIKE 'A%'"}
          value={value}
          onChange={onInput}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          onSelect={syncScroll}
          onMouseDown={() => menu?.kind === 'suggest' && setMenu(null)}
        />
      </div>
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
        onClick={() => (menu?.kind === 'history' ? setMenu(null) : openHistory())}
      >
        ▾
      </button>
      {menu?.kind === 'history' && (
        <div className="filter-menu" role="listbox" aria-label="Filtros recientes" ref={list}>
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
              <Highlighted text={w} engine={engine} columns={names} />
            </div>
          ))}
          {items.length > 0 && (
            <button className="link filter-clear" onMouseDown={(e) => e.preventDefault()} onClick={() => void clear()}>
              Borrar historial de filtros de esta tabla
            </button>
          )}
        </div>
      )}
      {menu?.kind === 'suggest' && (
        <div className="filter-menu suggest" role="listbox" aria-label="Sugerencias" ref={list}>
          {menu.items.map((s, i) => (
            <div
              key={`${s.kind}:${s.label}`}
              role="option"
              aria-selected={i === index}
              className={`filter-option suggestion ${i === index ? 'on' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                accept(s)
              }}
            >
              <span className={`kind-mark kind-${s.kind}`}>{KIND_MARK[s.kind]}</span>
              <span className="suggestion-label">
                {s.kind === 'column' ? <span className="tok-column">{s.label}</span> : <Highlighted text={s.label} engine={engine} columns={[]} />}
              </span>
              {s.detail && <span className="suggestion-detail">{s.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
