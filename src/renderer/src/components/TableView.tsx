import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { qualifiedName, toCsv, toJson, toSqlInserts } from '@shared/format'
import { equalsCondition } from '@shared/table-query'
import type {
  CellValue,
  ConnectionSummary,
  ForeignKeyInfo,
  ObjectKind,
  CellChange,
  QueryResult,
  RowUpdate,
  SortSpec,
  TablePage,
  TableRef,
  TableStructure
} from '@shared/types'
import { PAGE_SIZES } from '@shared/types'
import { isAddRowKey, keys } from '../lib/platform'
import { notifySchemaChanged } from '../lib/schema-events'
import { ConfirmDialog } from './ConfirmDialog'
import { DataGrid, type FocusRequest, type PendingEdits } from './DataGrid'
import { FilterInput } from './FilterInput'
import { Icon } from './Icon'
import { Pager } from './Pager'
import { StructureView, type Loadable } from './StructureView'

export interface OpenTable {
  type: 'table'
  id: string
  sessionId: string
  connection: ConnectionSummary
  ref: TableRef
  kind: ObjectKind
}

interface Props {
  tab: OpenTable
  active: boolean
  /** Filtro impuesto desde fuera (navegación por clave foránea); `nonce` distingue peticiones iguales. */
  filterRequest: { where: string; nonce: number } | null
  onNavigate: (ref: TableRef, where: string) => void
  /** Abre una consola sobre esta base de datos con una consulta de partida. */
  onOpenConsole: (database: string, sql: string) => void
}

function readPageSize(): number {
  try {
    const stored = Number(localStorage.getItem('pageSize'))
    return PAGE_SIZES.includes(stored) ? stored : 500
  } catch {
    return 500
  }
}

/** Cambios sin guardar de la rejilla. Las filas nuevas van detrás de las de la página. */
interface Changes {
  edits: PendingEdits
  newRows: number
  deleted: Set<number>
}

const NO_CHANGES: Changes = { edits: new Map(), newRows: 0, deleted: new Set() }
const hasChanges = (c: Changes): boolean => c.edits.size > 0 || c.newRows > 0 || c.deleted.size > 0

const tableLabel = (ref: TableRef) => (ref.schema && ref.schema !== 'dbo' ? `${ref.schema}.${ref.table}` : ref.table)

/** Visor de una tabla al estilo DataGrip: los datos son la pantalla; la SQL se genera por detrás. */
export function TableView({ tab, active, filterRequest, onNavigate, onOpenConsole }: Props) {
  const { sessionId, ref, connection } = tab
  const engine = connection.engine
  const [view, setView] = useState<'data' | 'structure'>('data')
  const [pageSize, setPageSize] = useState(readPageSize)
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<SortSpec[]>([])
  const [where, setWhere] = useState(filterRequest?.where ?? '')
  const [draft, setDraft] = useState(filterRequest?.where ?? '')
  const [reload, setReload] = useState(0)
  const [page, setPage] = useState<TablePage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [counting, setCounting] = useState(false)
  const [structure, setStructure] = useState<Loadable<TableStructure>>({ state: 'loading' })
  const [notice, setNotice] = useState<string | null>(null)
  const requestId = useRef(0)
  // Edición: cambios sin guardar. La referencia permite guardar justo después de confirmar una celda.
  const [changes, setChangesState] = useState<Changes>(NO_CHANGES)
  const changesRef = useRef<Changes>(changes)
  const setChanges = (next: Changes) => {
    changesRef.current = next
    setChangesState(next)
  }
  const [selectedRows, setSelectedRows] = useState<number[]>([])
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmPreview, setConfirmPreview] = useState<string[] | null>(null)
  const structureDirty = useRef(false)

  // Datos de la página actual. Solo cuenta la respuesta de la última petición.
  useEffect(() => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    window.api
      .fetchTableData(sessionId, { ...ref, offset, limit: pageSize, sort, where: where || undefined })
      .then((result) => {
        if (id !== requestId.current) return
        setPage(result)
        setChanges(NO_CHANGES)
        setSaveError(null)
      })
      .catch((err: Error) => {
        if (id === requestId.current) setError(err.message)
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false)
      })
  }, [sessionId, ref, offset, pageSize, sort, where, reload])

  const loadStructure = useCallback(() => {
    setStructure({ state: 'loading' })
    window.api
      .tableStructure(sessionId, ref)
      .then((value) => setStructure({ state: 'ready', value }))
      .catch((err: Error) => setStructure({ state: 'error', message: err.message }))
  }, [sessionId, ref])

  useEffect(loadStructure, [loadStructure])

  // Navegación por FK hacia una tabla ya abierta: se aplica el filtro nuevo.
  useEffect(() => {
    if (!filterRequest) return
    setDraft(filterRequest.where)
    setWhere(filterRequest.where)
    setOffset(0)
    setTotal(null)
    setView('data')
  }, [filterRequest?.nonce])

  /** Antes de cambiar de página, orden o filtro: los cambios sin guardar se perderían. */
  const discardPending = (): boolean => {
    if (!hasChanges(changesRef.current)) return true
    if (!window.confirm('Hay cambios sin guardar en esta tabla. ¿Descartarlos?')) return false
    setChanges(NO_CHANGES)
    return true
  }

  const refresh = useCallback(() => {
    if (!discardPending()) return
    if (structureDirty.current && !window.confirm('Hay cambios de estructura sin aplicar. ¿Descartarlos?')) return
    setTotal(null)
    setReload((n) => n + 1)
    loadStructure()
  }, [loadStructure])

  // F5 recarga la pestaña visible.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault()
        refresh()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, refresh])

  const ready = structure.state === 'ready' ? structure.value : null
  const primaryKey = useMemo(() => new Set(ready?.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)), [ready])
  const foreignKeys = useMemo(() => {
    const map = new Map<string, ForeignKeyInfo>()
    for (const fk of ready?.foreignKeys ?? []) for (const c of fk.columns) map.set(c, fk)
    return map
  }, [ready])

  // Columnas para el autocompletado del filtro; mientras carga la estructura, las de la página.
  const filterColumns = useMemo(
    () => ready?.columns.map((c) => ({ name: c.name, dataType: c.dataType })) ?? page?.columns.map((c) => ({ name: c.name, dataType: c.type })) ?? [],
    [ready, page?.columns]
  )

  const applyFilter = (value: string) => {
    if (!discardPending()) return
    setWhere(value.trim())
    setOffset(0)
    setTotal(null)
  }

  // Clic en la cabecera: ascendente → descendente → sin orden.
  const toggleSort = (column: string) => {
    if (!discardPending()) return
    const current = sort.find((s) => s.column === column)?.direction
    setSort(current === 'asc' ? [{ column, direction: 'desc' }] : current === 'desc' ? [] : [{ column, direction: 'asc' }])
    setOffset(0)
  }

  const count = async (): Promise<number | null> => {
    setCounting(true)
    try {
      const n = await window.api.countTableRows(sessionId, { ...ref, where: where || undefined })
      setTotal(n)
      return n
    } catch (err) {
      setError((err as Error).message)
      return null
    } finally {
      setCounting(false)
    }
  }

  const changePageSize = (value: number) => {
    if (!discardPending()) return
    setPageSize(value)
    setOffset(0)
    try {
      localStorage.setItem('pageSize', String(value))
    } catch {
      /* sin almacenamiento local: solo dura esta sesión */
    }
  }

  const goTo = (next: number) => {
    if (discardPending()) setOffset(next)
  }

  const goLast = async () => {
    if (!discardPending()) return
    const n = total ?? (await count())
    if (n !== null) setOffset(Math.max(0, Math.floor((n - 1) / pageSize) * pageSize))
  }

  // Editable solo con clave primaria completa en el resultado y fuera de modo solo lectura.
  const pkColumns = ready?.columns.filter((c) => c.isPrimaryKey).map((c) => c.name) ?? []
  const readOnlyReason =
    tab.kind === 'view'
      ? 'Vista: solo lectura'
      : connection.readOnly
        ? 'Conexión de solo lectura'
        : ready && pkColumns.length === 0
          ? 'Sin clave primaria: solo lectura'
          : null
  const structureReadOnly =
    tab.kind === 'view' ? 'Vista: la estructura no se edita' : connection.readOnly ? 'Conexión de solo lectura' : null
  const editable =
    !readOnlyReason && ready !== null && page !== null && pkColumns.every((pk) => page.columns.some((c) => c.name === pk))

  const base = page?.rows.length ?? 0

  // Texto de las celdas aún vacías de una fila nueva: qué recibirán si no se rellenan.
  const placeholders = useMemo(
    () =>
      (page?.columns ?? []).map((c) => {
        const info = ready?.columns.find((x) => x.name === c.name)
        if (!info) return ''
        if (info.autoIncrement) return '(auto)'
        if (info.defaultValue !== null && info.defaultValue.toUpperCase() !== 'NULL') return `(${info.defaultValue})`
        return info.nullable ? 'NULL' : '(obligatorio)'
      }),
    [page, ready]
  )

  const copyEdits = (edits: PendingEdits): PendingEdits => new Map([...edits].map(([r, cols]) => [r, new Map(cols)]))

  /** Apunta un valor en `edits`. En filas existentes, volver al valor original quita el cambio; en filas nuevas todo cuenta. */
  const setEdit = (edits: PendingEdits, row: number, col: number, value: CellValue) => {
    const cols = edits.get(row) ?? new Map<number, CellValue>()
    const original = page?.rows[row]?.[col] ?? null
    const same = row < base && (value === original || (value !== null && original !== null && String(value) === String(original)))
    if (same) cols.delete(col)
    else cols.set(col, value)
    if (cols.size) edits.set(row, cols)
    else edits.delete(row)
  }

  const editCell = (row: number, col: number, value: CellValue) => {
    const current = changesRef.current
    const edits = copyEdits(current.edits)
    setEdit(edits, row, col, value)
    setChanges({ ...current, edits })
    setSaveError(null)
    setNotice(null)
  }

  /**
   * Pega un bloque desde (row, col). Lo que pasa del final crea filas nuevas, así se duplican filas
   * copiadas; en ellas se omiten las columnas autoincrementales para que el servidor ponga el valor.
   */
  const pasteCells = (row: number, col: number, cells: CellValue[][]) => {
    if (!editable || !page) return
    const current = changesRef.current
    const edits = copyEdits(current.edits)
    const added = Math.max(0, row + cells.length - (base + current.newRows))
    let count = 0
    cells.forEach((values, i) => {
      const r = row + i
      if (current.deleted.has(r)) return
      values.forEach((value, j) => {
        const c = col + j
        const info = ready?.columns.find((x) => x.name === page.columns[c]?.name)
        if (c >= page.columns.length || (r >= base && info?.autoIncrement)) return
        setEdit(edits, r, c, value)
        count++
      })
    })
    setChanges({ ...current, edits, newRows: current.newRows + added })
    setSaveError(null)
    setNotice(`Pegado: ${count} celda${count === 1 ? '' : 's'}${added ? ` · ${added} fila${added === 1 ? '' : 's'} nueva${added === 1 ? '' : 's'}` : ''}`)
  }

  const addRow = () => {
    if (!editable || !page) return
    const current = changesRef.current
    const row = base + current.newRows
    setChanges({ ...current, newRows: current.newRows + 1 })
    // Se empieza a editar la primera columna que no rellena el servidor.
    const firstCol = Math.max(0, placeholders.findIndex((p) => p !== '(auto)'))
    setFocusRequest({ row, col: firstCol, edit: true, nonce: Date.now() })
    setSaveError(null)
    setNotice(null)
  }

  /** Marca (o desmarca) filas existentes para borrar; las nuevas simplemente se quitan. */
  const deleteRows = (rows: number[]) => {
    if (!editable || rows.length === 0) return
    const current = changesRef.current
    const existing = rows.filter((r) => r < base)
    const deleted = new Set(current.deleted)
    const restore = existing.length > 0 && existing.every((r) => deleted.has(r))
    for (const r of existing) {
      if (restore) deleted.delete(r)
      else deleted.add(r)
    }
    // Quitar filas nuevas desplaza las ediciones de las nuevas que van detrás.
    const removed = new Set(rows.filter((r) => r >= base))
    let edits = current.edits
    if (removed.size) {
      edits = new Map()
      for (const [r, cols] of current.edits) {
        if (removed.has(r)) continue
        const shift = r >= base ? [...removed].filter((x) => x < r).length : 0
        edits.set(r - shift, cols)
      }
    }
    setChanges({ edits, newRows: current.newRows - removed.size, deleted })
    setSaveError(null)
    setNotice(null)
  }

  const save = async (confirmedWrite = false) => {
    const { edits, newRows, deleted } = changesRef.current
    if (!page || !hasChanges(changesRef.current) || saving) return
    const colIndex = (name: string) => page.columns.findIndex((c) => c.name === name)
    const keyOf = (row: number): CellChange[] =>
      pkColumns.map((pk) => ({ column: pk, value: page.rows[row]?.[colIndex(pk)] ?? null }))
    const toChanges = (cols: Map<number, CellValue>): CellChange[] =>
      [...cols].map(([col, value]) => ({ column: page.columns[col]!.name, value }))
    const updates: RowUpdate[] = [...edits]
      .filter(([row]) => row < base && !deleted.has(row))
      .map(([row, cols]) => ({ key: keyOf(row), set: toChanges(cols) }))
    const inserts = Array.from({ length: newRows }, (_, i) => toChanges(edits.get(base + i) ?? new Map()))
    const deletes = [...deleted].sort((a, b) => a - b).map(keyOf)
    setSaving(true)
    setSaveError(null)
    try {
      const out = await window.api.saveRowChanges(sessionId, { ...ref, updates, inserts, deletes, confirmedWrite })
      if (out.needsConfirmation) {
        setConfirmPreview(out.preview ?? [])
        return
      }
      const parts = [
        out.updated && `${out.updated} modificada${out.updated === 1 ? '' : 's'}`,
        out.inserted && `${out.inserted} añadida${out.inserted === 1 ? '' : 's'}`,
        out.deleted && `${out.deleted} borrada${out.deleted === 1 ? '' : 's'}`
      ].filter(Boolean)
      setNotice(`Guardado: ${parts.join(', ')}`)
      setChanges(NO_CHANGES)
      setReload((n) => n + 1)
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // Alt+Insert (Cmd+N en macOS) también funciona con el foco fuera de la rejilla (p. ej. tras pulsar un botón).
  useEffect(() => {
    if (!active || view !== 'data') return
    const onKey = (e: KeyboardEvent) => {
      if (isAddRowKey(e) && !(e.target as HTMLElement).closest('.grid')) {
        e.preventDefault()
        addRow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const modifiedRows = [...changes.edits.keys()].filter((r) => r < base && !changes.deleted.has(r)).length
  const summary = [
    modifiedRows && `${modifiedRows} fila${modifiedRows === 1 ? '' : 's'} modificada${modifiedRows === 1 ? '' : 's'}`,
    changes.newRows && `${changes.newRows} nueva${changes.newRows === 1 ? '' : 's'}`,
    changes.deleted.size && `${changes.deleted.size} para borrar`
  ].filter(Boolean)
  const pendingAny = hasChanges(changes)

  const navigateFk = (fk: ForeignKeyInfo, row: CellValue[]) => {
    if (!page) return
    const values = fk.columns.map((c) => row[page.columns.findIndex((col) => col.name === c)] ?? null)
    onNavigate({ database: fk.refDatabase, schema: fk.refSchema, table: fk.refTable }, equalsCondition(engine, fk.refColumns, values))
  }

  const exportPage = async (format: 'csv' | 'excel' | 'json' | 'sql') => {
    if (!page) return
    const result: QueryResult = { statement: '', columns: page.columns, rows: page.rows, affectedRows: null, truncated: false, durationMs: 0 }
    const content =
      format === 'csv'
        ? toCsv(result)
        : format === 'excel'
          ? toCsv(result, { excel: true })
          : format === 'json'
            ? toJson(result)
            : toSqlInserts(result, engine, qualifiedName(engine, ref.database, { schema: ref.schema, name: ref.table }))
    try {
      const path = await window.api.exportFile({
        defaultName: `${ref.table}-${offset + 1}-${offset + page.rows.length}`,
        format: format === 'excel' ? 'csv' : format,
        content
      })
      if (path) setNotice(`Exportado a ${path}`)
    } catch (err) {
      setNotice(`No se pudo exportar: ${(err as Error).message}`)
    }
  }

  const rows = page?.rows.length ?? 0
  const range = page ? (rows ? `${offset + 1}–${offset + rows}` : '0') : '…'

  return (
    <div className="table-view" style={{ display: active ? 'flex' : 'none' }}>
      <div className="table-toolbar">
        <div className="segmented" role="tablist">
          <button
            role="tab"
            aria-label="Datos"
            title="Datos"
            aria-selected={view === 'data'}
            className={view === 'data' ? 'on' : ''}
            onClick={() => setView('data')}
          >
            <Icon name="data" />
          </button>
          <button
            role="tab"
            aria-label="Estructura"
            title="Estructura"
            aria-selected={view === 'structure'}
            className={view === 'structure' ? 'on' : ''}
            onClick={() => setView('structure')}
          >
            <Icon name="structure" />
          </button>
        </div>

        {view === 'data' && (
          <>
            <button className="icon" title="Recargar (F5)" disabled={loading} onClick={refresh}>
              ⟳
            </button>
            {loading && (
              <button className="compact" onClick={() => void window.api.cancelQuery(sessionId)}>
                Cancelar
              </button>
            )}
            <span className="spacer" />
            <button
              className="icon"
              disabled={!editable || loading}
              title={keys('Añadir fila (Alt+Insert)')}
              aria-label="Añadir fila"
              onClick={addRow}
            >
              <Icon name="plus" />
            </button>
            <button
              className="icon"
              disabled={!editable || selectedRows.length === 0}
              title={keys('Borrar o restaurar las filas seleccionadas (Ctrl+Supr)')}
              aria-label="Borrar filas"
              onClick={() => deleteRows(selectedRows)}
            >
              <Icon name="minus" />
            </button>
            <select
              className="compact"
              value=""
              disabled={!page || rows === 0}
              title="Exportar la página actual"
              onChange={(e) => {
                void exportPage(e.target.value as 'csv' | 'excel' | 'json' | 'sql')
                e.target.value = ''
              }}
            >
              <option value="" disabled>
                Exportar…
              </option>
              <option value="csv">CSV</option>
              <option value="excel">CSV para Excel (;)</option>
              <option value="json">JSON</option>
              <option value="sql">SQL INSERT</option>
            </select>
          </>
        )}
        {view === 'structure' && (
          <>
            <button className="icon" title="Recargar (F5)" onClick={refresh}>
              ⟳
            </button>
            <span className="spacer" />
          </>
        )}
        <button
          className="compact"
          title="Abrir una consola SQL sobre esta tabla"
          onClick={() => onOpenConsole(ref.database, `SELECT * FROM ${qualifiedName(engine, ref.database, { schema: ref.schema, name: ref.table })}`)}
        >
          Consola
        </button>
      </div>

      {view === 'data' && (
        <div className="query-bar">
          <FilterInput
            engine={engine}
            connectionId={connection.id}
            tableRef={ref}
            columns={filterColumns}
            value={draft}
            applied={where}
            onChange={setDraft}
            onApply={applyFilter}
          />
        </div>
      )}

      {view === 'data' && (pendingAny || saveError) && (
        <div className={`edit-bar ${saveError ? 'error' : ''}`} role="status">
          {saveError ? (
            <span>{saveError}</span>
          ) : (
            <span>
              ✎ Sin guardar: {summary.join(' · ')} ·{' '}
              <kbd>Alt</kbd>+<kbd>Enter</kbd> para guardar
            </span>
          )}
          <span className="spacer" />
          {pendingAny && (
            <>
              <button className="compact primary" disabled={saving} onClick={() => void save()}>
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
              <button
                className="compact"
                disabled={saving}
                onClick={() => {
                  setChanges(NO_CHANGES)
                  setSaveError(null)
                }}
              >
                Descartar
              </button>
            </>
          )}
        </div>
      )}

      {view === 'data' && (
        <div className="table-body">
          {error && (
            <div className="result-message error">
              {error}
              {where && <div className="stmt">Filtro aplicado: {where}</div>}
            </div>
          )}
          {!error && page && (
            <DataGrid
              columns={page.columns}
              rows={page.rows}
              rowOffset={page.offset}
              sort={sort}
              onSort={toggleSort}
              primaryKey={primaryKey}
              foreignKeys={foreignKeys}
              onNavigate={navigateFk}
              pending={changes.edits}
              newRows={changes.newRows}
              deleted={changes.deleted}
              placeholders={placeholders}
              onEdit={editable ? editCell : undefined}
              onSubmit={() => void save()}
              onAddRow={editable ? addRow : undefined}
              onDeleteRows={editable ? deleteRows : undefined}
              onPaste={editable ? pasteCells : undefined}
              onSelectionChange={setSelectedRows}
              focusRequest={focusRequest}
            >
              <Pager
                range={range}
                total={total}
                counting={counting}
                pageSize={pageSize}
                canPrev={offset > 0 && !loading}
                canNext={!!page?.hasMore && !loading}
                onCount={() => void count()}
                onFirst={() => goTo(0)}
                onPrev={() => goTo(Math.max(0, offset - pageSize))}
                onNext={() => goTo(offset + pageSize)}
                onLast={() => void goLast()}
                onPageSize={changePageSize}
              />
            </DataGrid>
          )}
          {!error && !page && <div className="grid-empty">Cargando…</div>}
          {loading && page && <div className="loading-bar" />}
        </div>
      )}

      <StructureView
        structure={structure}
        engine={engine}
        tableRef={ref}
        hidden={view !== 'structure'}
        readOnlyReason={structureReadOnly}
        prod={connection.environment === 'prod'}
        onOpen={(r) => onNavigate(r, '')}
        onApply={(design, base, expected) =>
          window.api.alterTable(sessionId, { ...ref, design, base, expected, confirmedWrite: connection.environment === 'prod' })
        }
        onApplied={(message) => {
          notifySchemaChanged({ sessionId, database: ref.database })
          setNotice(message)
          setChanges(NO_CHANGES)
          setTotal(null)
          setReload((n) => n + 1)
          loadStructure()
        }}
        onOpenConsole={(sql) => onOpenConsole(ref.database, sql)}
        onDirtyChange={(dirty) => {
          structureDirty.current = dirty
        }}
      />

      {confirmPreview && (
        <ConfirmDialog
          title="Guardar en producción"
          confirmLabel="Guardar igualmente"
          danger
          onCancel={() => setConfirmPreview(null)}
          onConfirm={() => {
            setConfirmPreview(null)
            void save(true)
          }}
        >
          <p>Se van a modificar datos en una conexión de producción:</p>
          <div className="stmt-list">{confirmPreview.join(';\n')}</div>
        </ConfirmDialog>
      )}

      <div className="table-footer">
        <span>
          {connection.name} · {ref.database}.{tableLabel(ref)}
        </span>
        {view === 'data' && page && !error && (
          <span>
            {rows} fila{rows === 1 ? '' : 's'} · {page.durationMs} ms
          </span>
        )}
        {where && view === 'data' && <span className="filter-chip">Filtrado</span>}
        {view === 'data' && readOnlyReason && <span>{readOnlyReason}</span>}
        {view === 'structure' && <span>{structureReadOnly ?? keys('Edita las celdas y revisa el SQL antes de aplicarlo · Alt+Enter: revisar')}</span>}
        {view === 'data' && editable && <span>{keys('Enter: editar · Arrastrar: seleccionar · Ctrl+C/V: copiar y pegar · Alt+Insert: fila nueva · Ctrl+Supr: borrar')}</span>}
        {sort[0] && view === 'data' && (
          <span>
            Orden: {sort[0].column} {sort[0].direction === 'asc' ? '▲' : '▼'}
          </span>
        )}
        <span className="spacer" />
        {notice && <span>{notice}</span>}
      </div>
    </div>
  )
}
