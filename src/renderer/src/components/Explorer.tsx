import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ColumnInfo, SessionInfo, TableInfo } from '@shared/types'

interface Props {
  session: SessionInfo
  connectionName: string
  /** Tabla de la pestaña activa, para resaltarla en el árbol. */
  activeTable: { database: string; schema: string | null; table: string } | null
  onOpenTable: (database: string, table: TableInfo) => void
  /** Nueva consola SQL; con base de datos si se abre desde una. */
  onOpenConsole: (database: string | null) => void
  onClose: () => void
}

type Loadable<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string }

const tableKey = (db: string, t: TableInfo) => `${db}\u0000${t.schema ?? ''}\u0000${t.name}`
const groupKey = (db: string, kind: TableInfo['kind']) => `group:${kind}:${db}`
const tableLabel =(t: TableInfo) => (t.schema && t.schema !== 'dbo' ? `${t.schema}.${t.name}` : t.name)

function Row(props: {
  depth: number
  expanded?: boolean
  kind: 'db' | 'table' | 'view' | 'col' | 'pk' | 'folder'
  label: string
  meta?: string
  active?: boolean
  title?: string
  onClick?: () => void
  onDoubleClick?: () => void
  /** Botones que aparecen al pasar el ratón. */
  actions?: ReactNode
}) {
  const icon = { db: 'D', table: 'T', view: 'V', col: '•', pk: '🔑', folder: '' }[props.kind]
  return (
    <div
      className={`tree-row ${props.active ? 'active' : ''}`}
      style={{ paddingLeft: 6 + props.depth * 14 }}
      title={props.title}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
    >
      <span className="twisty">{props.expanded === undefined ? '' : props.expanded ? '▾' : '▸'}</span>
      {props.kind !== 'folder' && <span className={`kind kind-${props.kind}`}>{icon}</span>}
      <span className="label">{props.label}</span>
      {props.meta && <span className="meta">{props.meta}</span>}
      {props.actions && <span className="row-actions">{props.actions}</span>}
    </div>
  )
}

/** Árbol de una sesión: bases de datos → tablas/vistas → columnas, cargado bajo demanda. */
export function Explorer({ session, connectionName, activeTable, onOpenTable, onOpenConsole, onClose }: Props) {
  const [databases, setDatabases] = useState<Loadable<string[]>>({ state: 'loading' })
  const [tables, setTables] = useState<Record<string, Loadable<TableInfo[]>>>({})
  const [columns, setColumns] = useState<Record<string, Loadable<ColumnInfo[]>>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['root']))
  const [filter, setFilter] = useState('')

  const loadDatabases = useCallback(async () => {
    setDatabases({ state: 'loading' })
    try {
      setDatabases({ state: 'ready', value: await window.api.listDatabases(session.sessionId) })
    } catch (err) {
      setDatabases({ state: 'error', message: (err as Error).message })
    }
  }, [session.sessionId])

  useEffect(() => {
    void loadDatabases()
  }, [loadDatabases])

  const loadTables = async (db: string) => {
    setTables((t) => ({ ...t, [db]: { state: 'loading' } }))
    try {
      const value = await window.api.listTables(session.sessionId, db)
      setTables((t) => ({ ...t, [db]: { state: 'ready', value } }))
      // Si hay vistas, la carpeta de tablas aparece ya desplegada.
      if (value.some((t) => t.kind === 'view')) setExpanded((prev) => new Set(prev).add(groupKey(db, 'table')))
    } catch (err) {
      setTables((t) => ({ ...t, [db]: { state: 'error', message: (err as Error).message } }))
    }
  }

  const loadColumns = async (db: string, table: TableInfo) => {
    const key = tableKey(db, table)
    setColumns((c) => ({ ...c, [key]: { state: 'loading' } }))
    try {
      const value = await window.api.listColumns(session.sessionId, db, table.name, table.schema)
      setColumns((c) => ({ ...c, [key]: { state: 'ready', value } }))
    } catch (err) {
      setColumns((c) => ({ ...c, [key]: { state: 'error', message: (err as Error).message } }))
    }
  }

  const toggle = (key: string, onOpen?: () => void) => {
    const opening = !expanded.has(key)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (opening) next.add(key)
      else next.delete(key)
      return next
    })
    if (opening) onOpen?.()
  }

  const refresh = () => {
    setTables({})
    setColumns({})
    setExpanded(new Set(['root']))
    void loadDatabases()
  }

  const needle = filter.trim().toLowerCase()
  const rootOpen = expanded.has('root')

  const renderObject = (db: string, t: TableInfo, depth: number) => {
    const key = tableKey(db, t)
    const open = expanded.has(key)
    const cols = columns[key]
    return (
      <div key={key}>
        <Row
          depth={depth}
          kind={t.kind}
          label={tableLabel(t)}
          expanded={open}
          title={t.kind === 'view' ? 'Doble clic: abrir la vista' : 'Doble clic: abrir la tabla'}
          active={activeTable?.database === db && activeTable.table === t.name && (activeTable.schema ?? null) === (t.schema ?? null)}
          onClick={() => toggle(key, () => cols?.state !== 'ready' && void loadColumns(db, t))}
          onDoubleClick={() => onOpenTable(db, t)}
        />
        {open && cols?.state === 'loading' && <Row depth={depth + 1} kind="folder" label="Cargando…" />}
        {open && cols?.state === 'error' && <div className="tree-error">{cols.message}</div>}
        {open &&
          cols?.state === 'ready' &&
          cols.value.map((c) => (
            <Row
              key={c.name}
              depth={depth + 1}
              kind={c.isPrimaryKey ? 'pk' : 'col'}
              label={c.name}
              meta={`${c.dataType}${c.nullable ? '' : ' not null'}`}
              title={c.defaultValue !== null ? `Por defecto: ${c.defaultValue}` : undefined}
            />
          ))}
      </div>
    )
  }

  const renderTables = (db: string) => {
    const loaded = tables[db]
    if (!loaded || loaded.state === 'loading') return <Row depth={2} kind="folder" label="Cargando…" />
    if (loaded.state === 'error') return <div className="tree-error">{loaded.message}</div>
    const visible = needle ? loaded.value.filter((t) => tableLabel(t).toLowerCase().includes(needle)) : loaded.value
    if (visible.length === 0) return <Row depth={2} kind="folder" label={needle ? 'Sin coincidencias' : 'Sin tablas'} />
    // Sin vistas, lista plana; con vistas, una carpeta para tablas y otra para vistas.
    if (!loaded.value.some((t) => t.kind === 'view')) return visible.map((t) => renderObject(db, t, 2))
    const groups = [
      { kind: 'table' as const, label: 'Tablas' },
      { kind: 'view' as const, label: 'Vistas' }
    ]
    return groups.map(({ kind, label }) => {
      const items = visible.filter((t) => t.kind === kind)
      // Al filtrar se ocultan las carpetas sin coincidencias.
      if (needle && items.length === 0) return null
      const key = groupKey(db, kind)
      const open = expanded.has(key)
      return (
        <div key={key}>
          <Row depth={2} kind="folder" label={label} meta={String(items.length)} expanded={open} onClick={() => toggle(key)} />
          {open && (items.length > 0 ? items.map((t) => renderObject(db, t, 3)) : <Row depth={3} kind="folder" label={`Sin ${label.toLowerCase()}`} />)}
        </div>
      )
    })
  }

  return (
    <div>
      <Row
        depth={0}
        kind="folder"
        expanded={rootOpen}
        label={connectionName}
        meta={`${session.server.product} ${session.server.version}`}
        onClick={() => toggle('root')}
        actions={
          <button
            className="icon"
            title="Nueva consola SQL"
            onClick={(e) => {
              e.stopPropagation()
              onOpenConsole(null)
            }}
          >
            ⌨
          </button>
        }
      />
      {rootOpen && (
        <>
          <div className="explorer-filter" style={{ paddingLeft: 20, display: 'flex', gap: 4 }}>
            <input placeholder="Filtrar tablas…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button className="icon" title="Recargar" onClick={refresh}>
              ↻
            </button>
            <button className="icon" title="Desconectar" onClick={onClose}>
              ⏏
            </button>
          </div>
          {databases.state === 'loading' && <Row depth={1} kind="folder" label="Cargando…" />}
          {databases.state === 'error' && <div className="tree-error">{databases.message}</div>}
          {databases.state === 'ready' &&
            databases.value.map((db) => {
              const key = `db:${db}`
              const open = expanded.has(key)
              const count = tables[db]?.state === 'ready' ? String((tables[db] as { value: TableInfo[] }).value.length) : undefined
              return (
                <div key={db}>
                  <Row
                    depth={1}
                    kind="db"
                    label={db}
                    meta={count}
                    expanded={open}
                    onClick={() => toggle(key, () => tables[db]?.state !== 'ready' && void loadTables(db))}
                    actions={
                      <button
                        className="icon"
                        title={`Nueva consola SQL en ${db}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenConsole(db)
                        }}
                      >
                        ⌨
                      </button>
                    }
                  />
                  {open && renderTables(db)}
                </div>
              )
            })}
        </>
      )}
    </div>
  )
}
