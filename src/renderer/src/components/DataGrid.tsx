import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { CellValue, ForeignKeyInfo, ResultColumn, SortSpec } from '@shared/types'

const ROW_HEIGHT = 24
const CHAR_WIDTH = 7.4
const MIN_WIDTH = 50
const display = (v: CellValue): string => (v === null ? 'NULL' : String(v))

/** Ancho inicial por columna a partir de la cabecera y una muestra de filas. */
function initialWidths(columns: ResultColumn[], rows: CellValue[][]): number[] {
  const sample = rows.slice(0, 200)
  return columns.map((c, i) => {
    let chars = Math.max(c.name.length + 3, c.type.length * 0.8)
    for (const row of sample) chars = Math.max(chars, Math.min(display(row[i] ?? null).length, 60))
    return Math.round(Math.min(420, Math.max(70, chars * CHAR_WIDTH + 20)))
  })
}

/** Cambios sin guardar: fila → (columna → valor nuevo). */
export type PendingEdits = Map<number, Map<number, CellValue>>

interface Props {
  columns: ResultColumn[]
  rows: CellValue[][]
  /** Número de la primera fila (para paginación). */
  rowOffset?: number
  sort?: SortSpec[]
  onSort?: (column: string) => void
  primaryKey?: Set<string>
  /** Columna → clave foránea que la contiene. */
  foreignKeys?: Map<string, ForeignKeyInfo>
  onNavigate?: (fk: ForeignKeyInfo, row: CellValue[]) => void
  /** Edición en línea: sin `onEdit` la rejilla es de solo lectura. */
  pending?: PendingEdits
  onEdit?: (row: number, col: number, value: CellValue) => void
  /** Alt+Enter: guardar los cambios pendientes. */
  onSubmit?: () => void
}

interface Editing {
  row: number
  col: number
  text: string
}

export function DataGrid(props: Props) {
  const { columns, rows, rowOffset = 0, sort = [], onSort, primaryKey, foreignKeys, onNavigate, pending, onEdit, onSubmit } = props
  const scroller = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null)
  const [editing, setEditingState] = useState<Editing | null>(null)
  // Copia síncrona: el blur que provocan Enter/Esc llega antes de que React actualice el estado.
  const editingRef = useRef<Editing | null>(null)
  const setEditing = (value: Editing | null) => {
    editingRef.current = value
    setEditingState(value)
  }
  const [widths, setWidths] = useState(() => initialWidths(columns, rows))
  const numWidth = Math.max(44, String(rowOffset + rows.length).length * 8 + 20)
  const editable = Boolean(onEdit)

  // Mismas columnas (otra página u otro orden): se conservan los anchos que el usuario ajustó.
  const columnsKey = columns.map((c) => c.name).join('\u0000')
  useEffect(() => setWidths(initialWidths(columns, rows)), [columnsKey])
  useEffect(() => {
    setSelected(null)
    setEditing(null)
  }, [rows])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20
  })

  const isPending = (row: number, col: number) => pending?.get(row)?.has(col) ?? false
  const valueAt = (row: number, col: number): CellValue =>
    isPending(row, col) ? (pending!.get(row)!.get(col) ?? null) : (rows[row]?.[col] ?? null)

  const selectedValue = selected ? valueAt(selected.row, selected.col) : undefined
  const sortOf = (name: string) => sort.find((s) => s.column === name)?.direction

  const fkIndexes = useMemo(() => {
    const map = new Map<number, ForeignKeyInfo>()
    columns.forEach((c, i) => {
      const fk = foreignKeys?.get(c.name)
      if (fk) map.set(i, fk)
    })
    return map
  }, [columns, foreignKeys])

  const focusGrid = () => scroller.current?.focus({ preventScroll: true })

  const navigate = (rowIndex: number, col: number) => {
    const fk = fkIndexes.get(col)
    const row = rows[rowIndex]
    if (fk && row && onNavigate && row[col] !== null) onNavigate(fk, row)
  }

  const moveTo = (row: number, col: number) => {
    const r = Math.max(0, Math.min(rows.length - 1, row))
    const c = Math.max(0, Math.min(columns.length - 1, col))
    setSelected({ row: r, col: c })
    virtualizer.scrollToIndex(r, { align: 'auto' })
    // El scroll horizontal se ajusta cuando la celda ya está pintada.
    requestAnimationFrame(() =>
      scroller.current?.querySelector(`[data-cell="${r}:${c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    )
  }

  const startEdit = (row: number, col: number, initial?: string) => {
    if (!editable) return
    const current = valueAt(row, col)
    setSelected({ row, col })
    setEditing({ row, col, text: initial ?? (current === null ? '' : String(current)) })
  }

  /** Pasa lo escrito a cambios pendientes. Devuelve false si no había edición en curso. */
  const commitEdit = (): boolean => {
    const current = editingRef.current
    if (!current || !onEdit) return false
    setEditing(null)
    onEdit(current.row, current.col, current.text)
    return true
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || rows.length === 0 || columns.length === 0) return
    const cur = selected ?? { row: 0, col: 0 }
    const pageRows = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 400) / ROW_HEIGHT) - 2)
    if (e.altKey && e.key === 'Enter') {
      e.preventDefault()
      onSubmit?.()
      return
    }
    const keys: Record<string, () => void> = {
      ArrowDown: () => moveTo(cur.row + 1, cur.col),
      ArrowUp: () => moveTo(cur.row - 1, cur.col),
      ArrowRight: () => moveTo(cur.row, cur.col + 1),
      ArrowLeft: () => moveTo(cur.row, cur.col - 1),
      PageDown: () => moveTo(cur.row + pageRows, cur.col),
      PageUp: () => moveTo(cur.row - pageRows, cur.col),
      Home: () => (e.ctrlKey ? moveTo(0, 0) : moveTo(cur.row, 0)),
      End: () => (e.ctrlKey ? moveTo(rows.length - 1, columns.length - 1) : moveTo(cur.row, columns.length - 1)),
      Tab: () => moveTo(cur.row, cur.col + (e.shiftKey ? -1 : 1))
    }
    if (editable && selected && (e.key === 'Enter' || e.key === 'F2') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      startEdit(selected.row, selected.col)
      return
    }
    const action = keys[e.key]
    if (action) {
      e.preventDefault()
      action()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selectedValue !== undefined) {
      e.preventDefault()
      void navigator.clipboard.writeText(selectedValue === null ? '' : String(selectedValue))
      return
    }
    // Ctrl+B, como en DataGrip: ir a la fila referenciada.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && selected) {
      e.preventDefault()
      navigate(selected.row, selected.col)
      return
    }
    // Empezar a escribir sobre una celda la edita reemplazando su valor.
    if (editable && selected && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      startEdit(selected.row, selected.col, e.key)
    }
  }

  const onEditorKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!editing) return
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault()
      commitEdit()
      onSubmit?.()
      focusGrid()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      commitEdit()
      focusGrid()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      commitEdit()
      moveTo(editing.row, editing.col + (e.shiftKey ? -1 : 1))
      focusGrid()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditing(null)
      focusGrid()
    }
    e.stopPropagation()
  }

  const startResize = (e: MouseEvent, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = widths[index] ?? 100
    const move = (ev: globalThis.MouseEvent) =>
      setWidths((w) => w.map((v, i) => (i === index ? Math.max(MIN_WIDTH, startWidth + ev.clientX - startX) : v)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <>
      <div className="grid" ref={scroller} tabIndex={0} onKeyDown={onKeyDown} role="grid" aria-rowcount={rows.length}>
        <div className="grid-header" role="row">
          <div className="grid-cell rownum" style={{ width: numWidth }}>
            #
          </div>
          {columns.map((c, i) => {
            const dir = sortOf(c.name)
            const fk = fkIndexes.get(i)
            return (
              <div
                key={i}
                role="columnheader"
                aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                className={`grid-cell ${onSort ? 'sortable' : ''}`}
                style={{ width: widths[i] }}
                title={`${c.name} · ${c.type}${fk ? `\nReferencia a ${fk.refTable} (${fk.refColumns.join(', ')})` : ''}${onSort ? '\nClic: ordenar' : ''}`}
                onClick={() => onSort?.(c.name)}
              >
                <span className="col-name">
                  {primaryKey?.has(c.name) && <span className="pk-mark">🔑</span>}
                  {c.name}
                  {fk && <span className="fk-mark">↗</span>}
                  {dir && <span className="sort-mark">{dir === 'asc' ? '▲' : '▼'}</span>}
                </span>
                <span className="type">{c.type.toLowerCase()}</span>
                <span className="resize-handle" onMouseDown={(e) => startResize(e, i)} onClick={(e) => e.stopPropagation()} />
              </div>
            )
          })}
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const rowEdited = (pending?.get(item.index)?.size ?? 0) > 0
            return (
              <div
                key={item.key}
                role="row"
                className={`grid-row ${selected?.row === item.index ? 'current' : ''}`}
                style={{ position: 'absolute', top: 0, left: 0, transform: `translateY(${item.start}px)` }}
              >
                <div className={`grid-cell rownum ${rowEdited ? 'row-modified' : ''}`} style={{ width: numWidth }}>
                  {rowOffset + item.index + 1}
                </div>
                {columns.map((_, col) => {
                  const value = valueAt(item.index, col)
                  const modified = isPending(item.index, col)
                  const isSelected = selected?.row === item.index && selected.col === col
                  const isEditing = editing?.row === item.index && editing.col === col
                  const linkable = !modified && value !== null && fkIndexes.has(col)
                  const cls = value === null ? 'null' : typeof value === 'number' ? 'num' : ''
                  return (
                    <div
                      key={col}
                      role="gridcell"
                      data-cell={`${item.index}:${col}`}
                      className={`grid-cell ${cls} ${isSelected ? 'selected' : ''} ${linkable ? 'linkable' : ''} ${modified ? 'modified' : ''} ${isEditing ? 'editing' : ''}`}
                      style={{ width: widths[col] }}
                      onClick={(e) => {
                        if (editing && !isEditing) commitEdit()
                        setSelected({ row: item.index, col })
                        if (linkable && (e.ctrlKey || e.metaKey)) navigate(item.index, col)
                      }}
                      onDoubleClick={() => startEdit(item.index, col)}
                    >
                      {isEditing ? (
                        <textarea
                          className="cell-editor"
                          aria-label={`Editar ${columns[col]?.name}`}
                          autoFocus
                          rows={1}
                          value={editing.text}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                          onKeyDown={onEditorKeyDown}
                          onBlur={() => commitEdit()}
                        />
                      ) : (
                        <span className="cell-text">{display(value)}</span>
                      )}
                      {linkable && !isEditing && (
                        <button
                          className="cell-link"
                          title="Ir a la fila referenciada (Ctrl+clic o Ctrl+B)"
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate(item.index, col)
                          }}
                        >
                          ↗
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
        {rows.length === 0 && <div className="grid-empty">Sin filas</div>}
      </div>
      {selected && selectedValue !== undefined && (
        <div className="value-viewer">
          <span className="value-text">
            <strong>{columns[selected.col]?.name}</strong> (fila {rowOffset + selected.row + 1}): {display(selectedValue)}
          </span>
          {editable && (
            <span className="value-actions">
              <button className="compact" title="Editar (Enter, F2 o doble clic)" onClick={() => startEdit(selected.row, selected.col)}>
                Editar
              </button>
              <button
                className="compact"
                title="Poner la celda a NULL"
                onClick={() => {
                  onEdit?.(selected.row, selected.col, null)
                  focusGrid()
                }}
              >
                NULL
              </button>
            </span>
          )}
        </div>
      )}
    </>
  )
}
