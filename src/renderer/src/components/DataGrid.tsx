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

/** Cambios sin guardar: fila → (columna → valor nuevo). Incluye las filas nuevas. */
export type PendingEdits = Map<number, Map<number, CellValue>>

/** Petición del padre para situar el cursor (y opcionalmente editar); `nonce` distingue peticiones. */
export interface FocusRequest {
  row: number
  col: number
  edit: boolean
  nonce: number
}

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
  /** Filas nuevas sin guardar, pintadas a continuación de `rows`. */
  newRows?: number
  /** Filas marcadas para borrar. */
  deleted?: Set<number>
  /** Texto de las celdas aún sin valor en filas nuevas, por columna: (auto), NULL… */
  placeholders?: string[]
  /** Alt+Insert. */
  onAddRow?: () => void
  /** Ctrl+Supr sobre las filas seleccionadas. */
  onDeleteRows?: (rows: number[]) => void
  onSelectionChange?: (rows: number[]) => void
  focusRequest?: FocusRequest | null
}

interface Editing {
  row: number
  col: number
  text: string
}

export function DataGrid(props: Props) {
  const { columns, rows, rowOffset = 0, sort = [], onSort, primaryKey, foreignKeys, onNavigate, pending, onEdit, onSubmit } = props
  const { newRows = 0, deleted, placeholders, onAddRow, onDeleteRows, onSelectionChange, focusRequest } = props
  const scroller = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null)
  // Ancla de la selección de varias filas (Mayús+clic / Mayús+flechas).
  const [anchor, setAnchor] = useState<number | null>(null)
  const [editing, setEditingState] = useState<Editing | null>(null)
  // Copia síncrona: el blur que provocan Enter/Esc llega antes de que React actualice el estado.
  const editingRef = useRef<Editing | null>(null)
  const setEditing = (value: Editing | null) => {
    editingRef.current = value
    setEditingState(value)
  }
  const [widths, setWidths] = useState(() => initialWidths(columns, rows))
  const total = rows.length + newRows
  const numWidth = Math.max(44, String(rowOffset + total).length * 8 + 20)
  const editable = Boolean(onEdit)

  // Mismas columnas (otra página u otro orden): se conservan los anchos que el usuario ajustó.
  const columnsKey = columns.map((c) => c.name).join('\u0000')
  useEffect(() => setWidths(initialWidths(columns, rows)), [columnsKey])
  useEffect(() => {
    setSelected(null)
    setAnchor(null)
    setEditing(null)
  }, [rows])

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20
  })

  const isNew = (row: number) => row >= rows.length
  const isDeleted = (row: number) => deleted?.has(row) ?? false
  const isPending = (row: number, col: number) => pending?.get(row)?.has(col) ?? false
  /** `undefined` = celda de una fila nueva a la que aún no se ha dado valor. */
  const valueAt = (row: number, col: number): CellValue | undefined =>
    isPending(row, col) ? (pending!.get(row)!.get(col) ?? null) : isNew(row) ? undefined : (rows[row]?.[col] ?? null)

  const selectedRows = useMemo(() => {
    if (!selected) return []
    const from = Math.min(anchor ?? selected.row, selected.row)
    const to = Math.max(anchor ?? selected.row, selected.row)
    return Array.from({ length: to - from + 1 }, (_, i) => from + i)
  }, [selected, anchor])
  const inRange = (row: number) => selectedRows.length > 1 && row >= selectedRows[0]! && row <= selectedRows.at(-1)!

  useEffect(() => onSelectionChange?.(selectedRows), [selectedRows])

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

  const moveTo = (row: number, col: number, extend = false) => {
    const r = Math.max(0, Math.min(total - 1, row))
    const c = Math.max(0, Math.min(columns.length - 1, col))
    if (extend) setAnchor((a) => a ?? selected?.row ?? r)
    else setAnchor(null)
    setSelected({ row: r, col: c })
    virtualizer.scrollToIndex(r, { align: 'auto' })
    // El scroll horizontal se ajusta cuando la celda ya está pintada.
    requestAnimationFrame(() =>
      scroller.current?.querySelector(`[data-cell="${r}:${c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    )
  }

  const startEdit = (row: number, col: number, initial?: string) => {
    if (!editable || isDeleted(row)) return
    const current = valueAt(row, col)
    setSelected({ row, col })
    setAnchor(null)
    setEditing({ row, col, text: initial ?? (current === null || current === undefined ? '' : String(current)) })
  }

  // El padre pide situarse en una celda (p. ej. la primera de una fila recién añadida).
  useEffect(() => {
    if (!focusRequest) return
    moveTo(focusRequest.row, focusRequest.col)
    if (focusRequest.edit) requestAnimationFrame(() => startEdit(focusRequest.row, focusRequest.col))
    else focusGrid()
  }, [focusRequest?.nonce])

  /** Pasa lo escrito a cambios pendientes. Devuelve false si no había edición en curso. */
  const commitEdit = (): boolean => {
    const current = editingRef.current
    if (!current || !onEdit) return false
    setEditing(null)
    onEdit(current.row, current.col, current.text)
    return true
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || columns.length === 0) return
    if (e.altKey && e.key === 'Insert' && onAddRow) {
      e.preventDefault()
      onAddRow()
      return
    }
    if (total === 0) return
    const cur = selected ?? { row: 0, col: 0 }
    const pageRows = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 400) / ROW_HEIGHT) - 2)
    if (e.altKey && e.key === 'Enter') {
      e.preventDefault()
      onSubmit?.()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Delete' && onDeleteRows && selected) {
      e.preventDefault()
      onDeleteRows(selectedRows)
      return
    }
    const keys: Record<string, () => void> = {
      ArrowDown: () => moveTo(cur.row + 1, cur.col, e.shiftKey),
      ArrowUp: () => moveTo(cur.row - 1, cur.col, e.shiftKey),
      ArrowRight: () => moveTo(cur.row, cur.col + 1),
      ArrowLeft: () => moveTo(cur.row, cur.col - 1),
      PageDown: () => moveTo(cur.row + pageRows, cur.col, e.shiftKey),
      PageUp: () => moveTo(cur.row - pageRows, cur.col, e.shiftKey),
      Home: () => (e.ctrlKey ? moveTo(0, 0) : moveTo(cur.row, 0)),
      End: () => (e.ctrlKey ? moveTo(total - 1, columns.length - 1) : moveTo(cur.row, columns.length - 1)),
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

  const viewerText = (col: number, value: CellValue | undefined) =>
    value === undefined ? `sin valor: ${placeholders?.[col] ?? 'por defecto'}` : display(value)

  return (
    <>
      <div className="grid" ref={scroller} tabIndex={0} onKeyDown={onKeyDown} role="grid" aria-rowcount={total}>
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
            const rowIsNew = isNew(item.index)
            const rowIsDeleted = isDeleted(item.index)
            const rowEdited = !rowIsNew && (pending?.get(item.index)?.size ?? 0) > 0
            const rowState = rowIsDeleted ? 'row-deleted' : rowIsNew ? 'row-new' : rowEdited ? 'row-modified' : ''
            return (
              <div
                key={item.key}
                role="row"
                aria-label={rowIsDeleted ? 'Fila marcada para borrar' : rowIsNew ? 'Fila nueva' : undefined}
                className={`grid-row ${selected?.row === item.index ? 'current' : ''} ${inRange(item.index) ? 'in-range' : ''} ${rowIsDeleted ? 'deleted' : ''}`}
                style={{ position: 'absolute', top: 0, left: 0, transform: `translateY(${item.start}px)` }}
              >
                <div className={`grid-cell rownum ${rowState}`} style={{ width: numWidth }}>
                  {rowIsNew ? '+' : rowOffset + item.index + 1}
                </div>
                {columns.map((_, col) => {
                  const value = valueAt(item.index, col)
                  const modified = isPending(item.index, col)
                  const isSelected = selected?.row === item.index && selected.col === col
                  const isEditing = editing?.row === item.index && editing.col === col
                  const linkable = !modified && !rowIsNew && !rowIsDeleted && value !== null && fkIndexes.has(col)
                  const cls =
                    value === undefined ? 'placeholder' : value === null ? 'null' : typeof value === 'number' ? 'num' : ''
                  return (
                    <div
                      key={col}
                      role="gridcell"
                      data-cell={`${item.index}:${col}`}
                      className={`grid-cell ${cls} ${isSelected ? 'selected' : ''} ${linkable ? 'linkable' : ''} ${modified ? 'modified' : ''} ${isEditing ? 'editing' : ''}`}
                      style={{ width: widths[col] }}
                      onClick={(e) => {
                        if (editing && !isEditing) commitEdit()
                        if (e.shiftKey && selected) setAnchor((a) => a ?? selected.row)
                        else setAnchor(null)
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
                        <span className="cell-text">{value === undefined ? (placeholders?.[col] ?? '') : display(value)}</span>
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
        {total === 0 && <div className="grid-empty">Sin filas</div>}
      </div>
      {selected && (
        <div className="value-viewer">
          <span className="value-text">
            <strong>{columns[selected.col]?.name}</strong> ({isNew(selected.row) ? 'fila nueva' : `fila ${rowOffset + selected.row + 1}`}
            {selectedRows.length > 1 ? ` · ${selectedRows.length} filas seleccionadas` : ''}):{' '}
            {viewerText(selected.col, selectedValue)}
          </span>
          {editable && !isDeleted(selected.row) && (
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
