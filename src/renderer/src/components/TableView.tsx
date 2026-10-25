import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { qualifiedName, toCsv, toJson, toSqlInserts } from '@shared/format'
import { equalsCondition } from '@shared/table-query'
import type {
  CellValue,
  ConnectionSummary,
  ForeignKeyInfo,
  ObjectKind,
  QueryResult,
  RowUpdate,
  SortSpec,
  TablePage,
  TableRef,
  TableStructure
} from '@shared/types'
import { PAGE_SIZES } from '@shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { DataGrid, type PendingEdits } from './DataGrid'

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

type Loadable<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string }

function readPageSize(): number {
  try {
    const stored = Number(localStorage.getItem('pageSize'))
    return PAGE_SIZES.includes(stored) ? stored : 500
  } catch {
    return 500
  }
}

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
  const [pending, setPendingState] = useState<PendingEdits>(new Map())
  const pendingRef = useRef<PendingEdits>(pending)
  const setPending = (next: PendingEdits) => {
    pendingRef.current = next
    setPendingState(next)
  }
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmPreview, setConfirmPreview] = useState<string[] | null>(null)

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
        setPending(new Map())
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
    if (pendingRef.current.size === 0) return true
    if (!window.confirm('Hay cambios sin guardar en esta tabla. ¿Descartarlos?')) return false
    setPending(new Map())
    return true
  }

  const refresh = useCallback(() => {
    if (!discardPending()) return
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
  const editable =
    !readOnlyReason && ready !== null && page !== null && pkColumns.every((pk) => page.columns.some((c) => c.name === pk))

  const editCell = (row: number, col: number, value: CellValue) => {
    const original = page?.rows[row]?.[col] ?? null
    const same = value === original || (value !== null && original !== null && String(value) === String(original))
    const next: PendingEdits = new Map([...pendingRef.current].map(([r, cols]) => [r, new Map(cols)]))
    const cols = next.get(row) ?? new Map<number, CellValue>()
    if (same) cols.delete(col)
    else cols.set(col, value)
    if (cols.size) next.set(row, cols)
    else next.delete(row)
    setPending(next)
    setSaveError(null)
    setNotice(null)
  }

  const save = async (confirmedWrite = false) => {
    const current = pendingRef.current
    if (!page || current.size === 0 || saving) return
    const colIndex = (name: string) => page.columns.findIndex((c) => c.name === name)
    const updates: RowUpdate[] = [...current].map(([row, cols]) => ({
      key: pkColumns.map((pk) => ({ column: pk, value: page.rows[row]?.[colIndex(pk)] ?? null })),
      set: [...cols].map(([col, value]) => ({ column: page.columns[col]!.name, value }))
    }))
    setSaving(true)
    setSaveError(null)
    try {
      const out = await window.api.updateRows(sessionId, { ...ref, updates, confirmedWrite })
      if (out.needsConfirmation) {
        setConfirmPreview(out.preview ?? [])
        return
      }
      setNotice(`${out.applied} fila${out.applied === 1 ? '' : 's'} guardada${out.applied === 1 ? '' : 's'}`)
      setPending(new Map())
      setReload((n) => n + 1)
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const pendingRows = pending.size
  const pendingCells = [...pending.values()].reduce((n, cols) => n + cols.size, 0)

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
          <button role="tab" aria-selected={view === 'data'} className={view === 'data' ? 'on' : ''} onClick={() => setView('data')}>
            Datos
          </button>
          <button
            role="tab"
            aria-selected={view === 'structure'}
            className={view === 'structure' ? 'on' : ''}
            onClick={() => setView('structure')}
          >
            Estructura
          </button>
        </div>

        {view === 'data' && (
          <>
            <div className="pager">
              <button className="icon" title="Primera página" disabled={offset === 0 || loading} onClick={() => goTo(0)}>
                ⏮
              </button>
              <button
                className="icon"
                title="Página anterior"
                disabled={offset === 0 || loading}
                onClick={() => goTo(Math.max(0, offset - pageSize))}
              >
                ◀
              </button>
              <span className="range" aria-live="polite">
                {range} de{' '}
                {total !== null ? (
                  total.toLocaleString('es-ES')
                ) : (
                  <button className="link" title="Contar filas" disabled={counting} onClick={() => void count()}>
                    {counting ? '…' : '?'}
                  </button>
                )}
              </span>
              <button
                className="icon"
                title="Página siguiente"
                disabled={!page?.hasMore || loading}
                onClick={() => goTo(offset + pageSize)}
              >
                ▶
              </button>
              <button className="icon" title="Última página" disabled={!page?.hasMore || loading || counting} onClick={() => void goLast()}>
                ⏭
              </button>
            </div>
            <select
              className="compact"
              value={pageSize}
              title="Filas por página"
              onChange={(e) => {
                if (!discardPending()) return
                const value = Number(e.target.value)
                setPageSize(value)
                setOffset(0)
                try {
                  localStorage.setItem('pageSize', String(value))
                } catch {
                  /* sin almacenamiento local: solo dura esta sesión */
                }
              }}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} filas
                </option>
              ))}
            </select>
            <button className="icon" title="Recargar (F5)" disabled={loading} onClick={refresh}>
              ⟳
            </button>
            {loading && (
              <button className="compact" onClick={() => void window.api.cancelQuery(sessionId)}>
                Cancelar
              </button>
            )}
            <div className="filter">
              <span className="filter-label">WHERE</span>
              <input
                aria-label="Filtro"
                placeholder={engine === 'mysql' ? "p. ej. estado = 'confirmada' AND importe > 100" : "p. ej. Codigo LIKE 'A%'"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyFilter(draft)
                  if (e.key === 'Escape') setDraft(where)
                }}
              />
              {(where || draft) && (
                <button
                  className="icon"
                  title="Quitar filtro"
                  onClick={() => {
                    setDraft('')
                    applyFilter('')
                  }}
                >
                  ✕
                </button>
              )}
            </div>
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
          <button className="icon" title="Recargar (F5)" onClick={refresh}>
            ⟳
          </button>
        )}
        <button
          className="compact"
          title="Abrir una consola SQL sobre esta tabla"
          onClick={() => onOpenConsole(ref.database, `SELECT * FROM ${qualifiedName(engine, ref.database, { schema: ref.schema, name: ref.table })}`)}
        >
          Consola
        </button>
      </div>

      {view === 'data' && (pendingRows > 0 || saveError) && (
        <div className={`edit-bar ${saveError ? 'error' : ''}`} role="status">
          {saveError ? (
            <span>{saveError}</span>
          ) : (
            <span>
              ✎ {pendingCells} cambio{pendingCells === 1 ? '' : 's'} en {pendingRows} fila{pendingRows === 1 ? '' : 's'} sin guardar ·{' '}
              <kbd>Alt</kbd>+<kbd>Enter</kbd> para guardar
            </span>
          )}
          <span className="spacer" />
          {pendingRows > 0 && (
            <>
              <button className="compact primary" disabled={saving} onClick={() => void save()}>
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
              <button
                className="compact"
                disabled={saving}
                onClick={() => {
                  setPending(new Map())
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
              pending={pending}
              onEdit={editable ? editCell : undefined}
              onSubmit={() => void save()}
            />
          )}
          {!error && !page && <div className="grid-empty">Cargando…</div>}
          {loading && page && <div className="loading-bar" />}
        </div>
      )}

      {view === 'structure' && <StructureView structure={structure} engine={engine} onOpen={(r) => onNavigate(r, '')} />}

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
        {view === 'data' && editable && <span>Enter o doble clic para editar</span>}
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

function StructureView({
  structure,
  engine,
  onOpen
}: {
  structure: Loadable<TableStructure>
  engine: 'mysql' | 'mssql'
  onOpen: (ref: TableRef) => void
}) {
  const [copied, setCopied] = useState(false)
  if (structure.state === 'loading') return <div className="grid-empty">Cargando estructura…</div>
  if (structure.state === 'error') return <div className="result-message error">{structure.message}</div>
  const { columns, indexes, foreignKeys, ddl } = structure.value
  return (
    <div className="structure">
      <h3>Columnas ({columns.length})</h3>
      <table className="info-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Nombre</th>
            <th>Tipo</th>
            <th>Nulo</th>
            <th>Por defecto</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c, i) => (
            <tr key={c.name}>
              <td className="dim">{i + 1}</td>
              <td>
                {c.isPrimaryKey && <span className="pk-mark">🔑</span>}
                {c.name}
              </td>
              <td className="mono">{c.dataType}</td>
              <td>{c.nullable ? 'sí' : 'no'}</td>
              <td className="mono">{c.defaultValue ?? <span className="dim">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Índices ({indexes.length})</h3>
      {indexes.length === 0 ? (
        <p className="dim">Sin índices.</p>
      ) : (
        <table className="info-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Columnas</th>
              <th>Tipo</th>
            </tr>
          </thead>
          <tbody>
            {indexes.map((ix) => (
              <tr key={ix.name}>
                <td>{ix.name}</td>
                <td className="mono">{ix.columns.join(', ')}</td>
                <td>{ix.primary ? 'Clave primaria' : ix.unique ? 'Único' : 'Índice'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Claves foráneas ({foreignKeys.length})</h3>
      {foreignKeys.length === 0 ? (
        <p className="dim">Sin claves foráneas.</p>
      ) : (
        <table className="info-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Columnas</th>
              <th>Referencia</th>
            </tr>
          </thead>
          <tbody>
            {foreignKeys.map((fk) => (
              <tr key={fk.name}>
                <td>{fk.name}</td>
                <td className="mono">{fk.columns.join(', ')}</td>
                <td>
                  <button
                    className="link"
                    title="Abrir la tabla referenciada"
                    onClick={() => onOpen({ database: fk.refDatabase, schema: fk.refSchema, table: fk.refTable })}
                  >
                    {engine === 'mysql' ? `${fk.refDatabase}.${fk.refTable}` : `${fk.refSchema}.${fk.refTable}`}
                  </button>{' '}
                  <span className="mono dim">({fk.refColumns.join(', ')})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {ddl && (
        <>
          <h3>
            DDL{' '}
            <button
              className="link"
              onClick={() => {
                void navigator.clipboard.writeText(ddl)
                setCopied(true)
              }}
            >
              {copied ? 'copiado' : 'copiar'}
            </button>
          </h3>
          <pre className="ddl">{ddl}</pre>
        </>
      )}
    </div>
  )
}
