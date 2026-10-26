import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { parseTsv, toTsv } from '@shared/format'
import type { CellValue, ForeignKeyInfo, ResultColumn, SortSpec } from '@shared/types'
import { isAddRowKey, isDeleteKey, keys } from '../lib/platform'

const ROW_HEIGHT = 24
const HEADER_HEIGHT = 40
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
  /** Ctrl+V: bloque de valores a partir de una celda; las filas que sobran pasan a ser filas nuevas. */
  onPaste?: (row: number, col: number, cells: CellValue[][]) => void
  focusRequest?: FocusRequest | null
  /** Elementos flotantes sobre la rejilla (p. ej. la paginación), por encima del visor de valores. */
  children?: ReactNode
}

interface Cell {
  row: number
  col: number
}

/** Qué se ha seleccionado: un rectángulo de celdas, filas enteras (por el número) o columnas enteras (por la cabecera). */
type SelectionMode = 'cells' | 'rows' | 'columns'

interface Drag {
  mode: SelectionMode
  /** Columna donde empezó un arrastre por las cabeceras: hasta que no se mueve es un clic (ordenar). */
  startCol?: number
  moved: boolean
}

interface Editing {
  row: number
  col: number
  text: string
}

export function DataGrid(props: Props) {
  const { columns, rows, rowOffset = 0, sort = [], onSort, primaryKey, foreignKeys, onNavigate, pending, onEdit, onSubmit } = props
  const { newRows = 0, deleted, placeholders, onAddRow, onDeleteRows, onSelectionChange, onPaste, focusRequest } = props
  const scroller = useRef<HTMLDivElement>(null)
  // Celda activa (cursor) y esquina opuesta del rectángulo seleccionado (arrastre, Mayús+clic, Mayús+flechas).
  const [selected, setSelected] = useState<Cell | null>(null)
  const [anchor, setAnchor] = useState<Cell | null>(null)
  const [mode, setMode] = useState<SelectionMode>('cells')
  const drag = useRef<Drag | null>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  // El clic que cierra un arrastre por las cabeceras no debe ordenar.
  const suppressHeaderClick = useRef(false)
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
    setMode('cells')
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

  /** Rectángulo seleccionado [r1..r2] × [c1..c2]. */
  const rect = useMemo(() => {
    if (!selected) return null
    const a = anchor ?? selected
    const lastCol = Math.max(0, columns.length - 1)
    return {
      r1: mode === 'columns' ? 0 : Math.min(a.row, selected.row),
      r2: mode === 'columns' ? Math.max(0, total - 1) : Math.max(a.row, selected.row),
      c1: mode === 'rows' ? 0 : Math.min(a.col, selected.col),
      c2: mode === 'rows' ? lastCol : Math.max(a.col, selected.col)
    }
  }, [selected, anchor, mode, columns.length, total])
  const multi = rect !== null && (rect.r1 !== rect.r2 || rect.c1 !== rect.c2)
  const inRect = (row: number, col: number) => multi && row >= rect.r1 && row <= rect.r2 && col >= rect.c1 && col <= rect.c2
  const rowInRect = (row: number) => multi && mode !== 'columns' && row >= rect.r1 && row <= rect.r2
  const colInRect = (col: number) => multi && col >= rect.c1 && col <= rect.c2

  // Filas afectadas por "borrar filas". Seleccionar columnas enteras no cuenta: no es elegir filas.
  const selectedRows = useMemo(
    () => (rect && mode !== 'columns' ? Array.from({ length: rect.r2 - rect.r1 + 1 }, (_, i) => rect.r1 + i) : []),
    [rect, mode]
  )

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
    if (extend) setAnchor((a) => a ?? selected ?? { row: r, col: c })
    else {
      setAnchor(null)
      setMode('cells')
    }
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
    setMode('cells')
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
    if (isAddRowKey(e) && onAddRow) {
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
    // Ctrl+Supr siempre; Supr solo si se han seleccionado filas enteras por su número.
    if (isDeleteKey(e) && (e.ctrlKey || e.metaKey || mode === 'rows') && onDeleteRows && selectedRows.length) {
      e.preventDefault()
      onDeleteRows(selectedRows)
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setMode('cells')
      setAnchor({ row: 0, col: 0 })
      setSelected({ row: total - 1, col: columns.length - 1 })
      return
    }
    if (e.key === 'Escape' && multi) {
      e.preventDefault()
      setAnchor(null)
      setMode('cells')
      return
    }
    const keys: Record<string, () => void> = {
      ArrowDown: () => moveTo(cur.row + 1, cur.col, e.shiftKey),
      ArrowUp: () => moveTo(cur.row - 1, cur.col, e.shiftKey),
      ArrowRight: () => moveTo(cur.row, cur.col + 1, e.shiftKey),
      ArrowLeft: () => moveTo(cur.row, cur.col - 1, e.shiftKey),
      PageDown: () => moveTo(cur.row + pageRows, cur.col, e.shiftKey),
      PageUp: () => moveTo(cur.row - pageRows, cur.col, e.shiftKey),
      Home: () => (e.ctrlKey || e.metaKey ? moveTo(0, 0) : moveTo(cur.row, 0)),
      End: () => (e.ctrlKey || e.metaKey ? moveTo(total - 1, columns.length - 1) : moveTo(cur.row, columns.length - 1)),
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && rect) {
      e.preventDefault()
      copySelection(e.shiftKey)
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && onPaste && rect) {
      e.preventDefault()
      void pasteClipboard()
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

  /**
   * Ctrl+C: una celda se copia tal cual; un bloque, como TSV (se pega en Excel o en otra rejilla).
   * Ctrl+Mayús+C añade la fila de cabeceras.
   */
  const copySelection = (withHeader: boolean) => {
    if (!rect) return
    if (!multi && !withHeader) {
      if (selectedValue !== undefined) void navigator.clipboard.writeText(selectedValue === null ? '' : String(selectedValue))
      return
    }
    const cells: (CellValue | undefined)[][] = []
    for (let r = rect.r1; r <= rect.r2; r++) {
      const line: (CellValue | undefined)[] = []
      for (let c = rect.c1; c <= rect.c2; c++) line.push(valueAt(r, c))
      cells.push(line)
    }
    const header = withHeader ? columns.slice(rect.c1, rect.c2 + 1).map((c) => c.name) : undefined
    void navigator.clipboard.writeText(toTsv(cells, header))
  }

  /** Ctrl+V: un solo valor rellena todo el bloque seleccionado; varios se pegan desde su esquina superior izquierda. */
  const pasteClipboard = async () => {
    if (!rect || !onPaste) return
    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch {
      return
    }
    if (!text) return
    let cells = parseTsv(text).map((line) => line.slice(0, columns.length - rect.c1))
    const single = cells.length === 1 && cells[0]!.length === 1
    if (single && multi) {
      const value = cells[0]![0]!
      cells = Array.from({ length: rect.r2 - rect.r1 + 1 }, () => Array.from({ length: rect.c2 - rect.c1 + 1 }, () => value))
    }
    onPaste(rect.r1, rect.c1, cells)
    // Queda seleccionado lo pegado.
    const width = Math.max(...cells.map((l) => l.length))
    setMode('cells')
    setAnchor({ row: rect.r1, col: rect.c1 })
    setSelected({ row: rect.r1 + cells.length - 1, col: rect.c1 + width - 1 })
  }

  // Arrastre: mientras el botón sigue pulsado, la celda bajo el puntero amplía la selección y, cerca
  // de los bordes, la rejilla se desplaza sola.
  const dragFrame = useRef(0)
  const dragTick = () => {
    const d = drag.current
    const el = scroller.current
    const p = pointer.current
    if (!d || !el || !p) return
    const box = el.getBoundingClientRect()
    const top = box.top + HEADER_HEIGHT
    const left = box.left + numWidth
    const speed = (overflow: number) => Math.max(-40, Math.min(40, overflow / 2))
    if (d.mode !== 'columns') {
      if (p.y < top) el.scrollTop += speed(p.y - top)
      else if (p.y > box.bottom) el.scrollTop += speed(p.y - box.bottom)
    }
    if (d.mode !== 'rows') {
      if (p.x < left) el.scrollLeft += speed(p.x - left)
      else if (p.x > box.right) el.scrollLeft += speed(p.x - box.right)
    }
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
    const x = d.mode === 'rows' ? box.left + 2 : clamp(p.x, left + 1, box.right - 16)
    const y = d.mode === 'columns' ? box.top + HEADER_HEIGHT / 2 : clamp(p.y, top + 1, box.bottom - 16)
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-cell], [data-row], [data-col]')
    if (target?.dataset.cell) {
      const [row, col] = target.dataset.cell.split(':').map(Number) as [number, number]
      setSelected((s) => (s?.row === row && s.col === col ? s : { row, col: d.mode === 'rows' ? (s?.col ?? col) : col }))
    } else if (target?.dataset.row) {
      const row = Number(target.dataset.row)
      setSelected((s) => (s?.row === row ? s : { row, col: s?.col ?? 0 }))
    } else if (target?.dataset.col && d.mode === 'columns') {
      const col = Number(target.dataset.col)
      if (col !== d.startCol || d.moved) {
        if (!d.moved) {
          d.moved = true
          setMode('columns')
          setAnchor({ row: 0, col: d.startCol ?? col })
        }
        setSelected((s) => (s?.col === col ? s : { row: s?.row ?? 0, col }))
      }
    }
    dragFrame.current = requestAnimationFrame(dragTick)
  }

  const startDrag = (e: MouseEvent, d: Drag) => {
    drag.current = d
    pointer.current = { x: e.clientX, y: e.clientY }
    cancelAnimationFrame(dragFrame.current)
    dragFrame.current = requestAnimationFrame(dragTick)
  }

  useEffect(() => {
    const move = (e: globalThis.MouseEvent) => {
      if (drag.current) pointer.current = { x: e.clientX, y: e.clientY }
    }
    const up = () => {
      if (!drag.current) return
      suppressHeaderClick.current = drag.current.mode === 'columns' && drag.current.moved
      drag.current = null
      cancelAnimationFrame(dragFrame.current)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      cancelAnimationFrame(dragFrame.current)
    }
  }, [])

  const onCellMouseDown = (e: MouseEvent, row: number, col: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, textarea')) return
    if (editing && (editing.row !== row || editing.col !== col)) commitEdit()
    e.preventDefault()
    focusGrid()
    if (e.shiftKey && selected) {
      setAnchor((a) => a ?? selected)
      setSelected({ row, col: mode === 'rows' ? selected.col : col })
      startDrag(e, { mode: mode === 'rows' ? 'rows' : 'cells', moved: false })
    } else {
      setMode('cells')
      setAnchor({ row, col })
      setSelected({ row, col })
      startDrag(e, { mode: 'cells', moved: false })
    }
  }

  const onRowNumberMouseDown = (e: MouseEvent, row: number) => {
    if (e.button !== 0) return
    if (editing) commitEdit()
    e.preventDefault()
    focusGrid()
    const col = selected?.col ?? 0
    if (!(e.shiftKey && selected)) setAnchor({ row, col: 0 })
    else setAnchor((a) => a ?? selected)
    setMode('rows')
    setSelected({ row, col })
    startDrag(e, { mode: 'rows', moved: false })
  }

  const selectColumns = (col: number, extend: boolean) => {
    if (!(extend && selected && mode === 'columns')) setAnchor({ row: 0, col })
    setMode('columns')
    setSelected((s) => ({ row: s?.row ?? 0, col }))
    focusGrid()
  }

  /** Clic en la cabecera: ordenar. Ctrl/Mayús+clic o arrastrar: seleccionar columnas. */
  const onHeaderClick = (e: MouseEvent, col: number) => {
    if (suppressHeaderClick.current) {
      suppressHeaderClick.current = false
      return
    }
    if (e.ctrlKey || e.metaKey || e.shiftKey || !onSort) selectColumns(col, e.shiftKey)
    else onSort(columns[col]!.name)
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
      <div className="grid-wrap">
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
                  data-col={i}
                  aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                  className={`grid-cell ${onSort ? 'sortable' : ''} ${mode === 'columns' && colInRect(i) ? 'in-range' : ''}`}
                  style={{ width: widths[i] }}
                  title={`${c.name} · ${c.type}${fk ? `\nReferencia a ${fk.refTable} (${fk.refColumns.join(', ')})` : ''}${onSort ? '\nClic: ordenar' : ''}${keys('\nCtrl+clic o arrastrar: seleccionar columnas')}`}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return
                    e.preventDefault()
                    startDrag(e, { mode: 'columns', startCol: i, moved: false })
                  }}
                  onClick={(e) => onHeaderClick(e, i)}
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
                  className={`grid-row ${selected?.row === item.index ? 'current' : ''} ${rowIsDeleted ? 'deleted' : ''}`}
                  style={{ position: 'absolute', top: 0, left: 0, transform: `translateY(${item.start}px)` }}
                >
                  <div
                    className={`grid-cell rownum ${rowState} ${rowInRect(item.index) ? 'in-range' : ''}`}
                    data-row={item.index}
                    style={{ width: numWidth }}
                    title="Clic o arrastrar: seleccionar filas"
                    onMouseDown={(e) => onRowNumberMouseDown(e, item.index)}
                  >
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
                        className={`grid-cell ${cls} ${isSelected ? 'selected' : ''} ${inRect(item.index, col) ? 'in-range' : ''} ${linkable ? 'linkable' : ''} ${modified ? 'modified' : ''} ${isEditing ? 'editing' : ''}`}
                        style={{ width: widths[col] }}
                        onMouseDown={(e) => onCellMouseDown(e, item.index, col)}
                        onClick={(e) => {
                          if (linkable && (e.ctrlKey || e.metaKey) && !e.shiftKey) navigate(item.index, col)
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
                            title={keys('Ir a la fila referenciada (Ctrl+clic o Ctrl+B)')}
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
        {props.children}
      </div>
      {selected && (
        <div className="value-viewer">
          <span className="value-text">
            <strong>{columns[selected.col]?.name}</strong> ({isNew(selected.row) ? 'fila nueva' : `fila ${rowOffset + selected.row + 1}`}
            {multi && rect ? selectionSummary(rect, mode) : ''}):{' '}
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

/** Resumen para el visor: "· 3 filas seleccionadas", "· 2 columnas seleccionadas" o "· 3 × 2 celdas seleccionadas". */
function selectionSummary(rect: { r1: number; r2: number; c1: number; c2: number }, mode: SelectionMode): string {
  const rows = rect.r2 - rect.r1 + 1
  const cols = rect.c2 - rect.c1 + 1
  const colText = `${cols} columna${cols === 1 ? '' : 's'}`
  if (mode === 'columns') return ` · ${colText} seleccionada${cols === 1 ? '' : 's'}`
  const rowText = ` · ${rows} fila${rows === 1 ? '' : 's'} seleccionada${rows === 1 ? '' : 's'}`
  return mode === 'rows' || cols === 1 ? rowText : ` · ${rows} × ${cols} celdas seleccionadas`
}
