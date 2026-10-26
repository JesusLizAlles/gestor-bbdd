import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionSummary, ObjectKind, SecretStorageStatus, SessionInfo, TableInfo, TableRef } from '@shared/types'
import { ExportDialog, ImportDialog } from './components/ConfigTransfer'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ConnectionDialog } from './components/ConnectionDialog'
import { ConsoleView, type OpenConsole } from './components/ConsoleView'
import { Explorer } from './components/Explorer'
import { Icon } from './components/Icon'
import { TableView, type OpenTable } from './components/TableView'
import { UpdateControls } from './components/UpdateControls'
import { keys } from './lib/platform'

interface OpenSession {
  info: SessionInfo
  connection: ConnectionSummary
}

const ENV_LABEL = { dev: 'Desarrollo', test: 'Pruebas', prod: 'PRODUCCIÓN' } as const

type Tab = OpenTable | OpenConsole

const sameRef = (a: TableRef, b: TableRef) =>
  a.database === b.database && a.table === b.table && (a.schema ?? null) === (b.schema ?? null)

const tabLabel = (ref: TableRef) => (ref.schema && ref.schema !== 'dbo' ? `${ref.schema}.${ref.table}` : ref.table)

export function App() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([])
  const [secretStatus, setSecretStatus] = useState<SecretStorageStatus | null>(null)
  const [sessions, setSessions] = useState<OpenSession[]>([])
  const [connecting, setConnecting] = useState<Record<string, string | null>>({})
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [filterRequests, setFilterRequests] = useState<Record<string, { where: string; nonce: number }>>({})
  const [sqlRequests, setSqlRequests] = useState<Record<string, { sql: string; nonce: number }>>({})
  const [editing, setEditing] = useState<ConnectionSummary | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ConnectionSummary | null>(null)
  const [transfer, setTransfer] = useState<'export' | 'import' | null>(null)
  /** Conexiones abiertas con el árbol plegado (al conectar se despliega). */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const activeSession = activeTab ? sessions.find((s) => s.info.sessionId === activeTab.sessionId) : undefined

  const reloadConnections = useCallback(async () => {
    const list = await window.api.listConnections()
    setConnections(list)
    return list
  }, [])

  /** `expand`: desplegar el árbol al conectar (al pulsarla) o dejarlo plegado (al arrancar). */
  const connect = async (connection: ConnectionSummary, expand = true) => {
    if (sessions.some((s) => s.connection.id === connection.id) || connecting[connection.id] === null) return
    setConnecting((s) => ({ ...s, [connection.id]: null }))
    try {
      const info = await window.api.openSession(connection.id)
      setSessions((list) => [...list, { info, connection }])
      setCollapsed((set) => {
        const next = new Set(set)
        if (expand) next.delete(connection.id)
        else next.add(connection.id)
        return next
      })
      setConnecting(({ [connection.id]: _done, ...rest }) => rest)
    } catch (err) {
      setConnecting((s) => ({ ...s, [connection.id]: (err as Error).message }))
    }
  }

  // Al arrancar se conecta todo, en paralelo y con los árboles plegados: así cada conexión ya
  // muestra su desplegable. Las que fallen quedan con el aviso y se reintentan con un clic.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void window.api.secretStorageStatus().then(setSecretStatus)
    void reloadConnections().then((list) => {
      for (const c of list) void connect(c, false)
    })
  })

  /** Se aplica al momento en la lista y luego se guarda; si falla, se vuelve a leer lo guardado. */
  const setVisibleDatabases = (id: string, visible: string[] | null) => {
    setConnections((list) => list.map((c) => (c.id === id ? { ...c, visibleDatabases: visible ?? undefined } : c)))
    window.api.setVisibleDatabases(id, visible).catch(() => void reloadConnections())
  }

  const toggleConnection = (id: string) =>
    setCollapsed((set) => {
      const next = new Set(set)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const closeTab = (id: string) => {
    const index = tabs.findIndex((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    setTabs(next)
    if (activeTabId === id) setActiveTabId(next[Math.min(index, next.length - 1)]?.id ?? null)
  }

  const disconnect = async (sessionId: string) => {
    const remaining = tabs.filter((t) => t.sessionId !== sessionId)
    setTabs(remaining)
    if (!remaining.some((t) => t.id === activeTabId)) setActiveTabId(remaining.at(-1)?.id ?? null)
    setSessions((list) => list.filter((s) => s.info.sessionId !== sessionId))
    await window.api.closeSession(sessionId).catch(() => {})
  }

  /** Abre (o reutiliza) la pestaña de una tabla; `where` aplica un filtro, como al navegar por FK. */
  const openTable = (sessionId: string, ref: TableRef, kind: ObjectKind = 'table', where?: string) => {
    const session = sessions.find((s) => s.info.sessionId === sessionId)
    if (!session) return
    const existing = tabs.find((t) => t.type === 'table' && t.sessionId === sessionId && sameRef(t.ref, ref))
    const id = existing?.id ?? crypto.randomUUID()
    if (!existing) setTabs((list) => [...list, { type: 'table', id, sessionId, connection: session.connection, ref, kind }])
    if (where !== undefined) setFilterRequests((r) => ({ ...r, [id]: { where, nonce: (r[id]?.nonce ?? 0) + 1 } }))
    setActiveTabId(id)
  }

  /**
   * Abre (o enfoca, si ya está abierta) la consola de una base de datos, con lo que se escribió en
   * ella la última vez. `sql` se añade al final. Sin base de datos, la de la conexión.
   */
  const openConsole = (sessionId: string, database: string | null, sql = '') => {
    const session = sessions.find((s) => s.info.sessionId === sessionId)
    if (!session) return
    const home = database ?? session.connection.database ?? session.info.server.currentDatabase ?? null
    const existing = tabs.find((t) => t.type === 'console' && t.sessionId === sessionId && t.homeDatabase === home)
    const id = existing?.id ?? crypto.randomUUID()
    if (!existing) {
      setTabs((list) => [
        ...list,
        { type: 'console', id, sessionId, connection: session.connection, title: home ?? 'Consola', homeDatabase: home }
      ])
    }
    if (sql) setSqlRequests((r) => ({ ...r, [id]: { sql, nonce: (r[id]?.nonce ?? 0) + 1 } }))
    setActiveTabId(id)
  }

  // Atajos globales de pestañas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() === 'w' && activeTabId) {
        e.preventDefault()
        closeTab(activeTabId)
      }
      if ((e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp') && tabs.length > 1) {
        e.preventDefault()
        const step = e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1
        const index = tabs.findIndex((t) => t.id === activeTabId)
        setActiveTabId(tabs[(index + step + tabs.length) % tabs.length]!.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="section-title">
          Conexiones
          <span className="section-actions">
            <button className="icon" title="Importar conexiones…" onClick={() => setTransfer('import')}>
              <Icon name="import" />
            </button>
            <button
              className="icon"
              title="Exportar conexiones…"
              disabled={connections.length === 0}
              onClick={() => setTransfer('export')}
            >
              <Icon name="export" />
            </button>
            <button className="icon" title="Nueva conexión" onClick={() => setEditing('new')}>
              ＋
            </button>
          </span>
        </div>
        <div className="connections">
          {connections.length === 0 && <div className="empty-note">Aún no hay conexiones. Pulsa ＋ para crear una.</div>}
          {connections.map((c) => {
            const session = sessions.find((s) => s.connection.id === c.id)
            const state = connecting[c.id]
            const failed = typeof state === 'string'
            const expanded = session !== undefined && !collapsed.has(c.id)
            const server = session ? `${session.info.server.product} ${session.info.server.version}` : null
            const title = server
              ? `Conectada · ${server}`
              : state === null
                ? 'Conectando…'
                : failed
                  ? `No se pudo conectar: ${state}\nClic para reintentar`
                  : 'Clic para conectar'
            return (
              <div key={c.id}>
                <div
                  className={`connection ${session ? 'open' : ''}`}
                  onClick={() => (session ? toggleConnection(c.id) : void connect(c))}
                  title={title}
                >
                  <span className="twisty">
                    {state === null ? <span className="spinner" /> : failed ? <span className="conn-warning">⚠</span> : expanded ? '▾' : '▸'}
                  </span>
                  <span className={`env-dot env-${c.environment}`} />
                  <span className="name">{c.name}</span>
                  {c.ssh.enabled && <span className="badge">SSH</span>}
                  {c.readOnly && <span className="badge ro">RO</span>}
                  <span className="badge">{c.engine === 'mysql' ? 'MySQL' : 'MSSQL'}</span>
                  <span className="actions" onClick={(e) => e.stopPropagation()}>
                    {session ? (
                      <>
                        <button className="icon" title="Consola SQL" onClick={() => openConsole(session.info.sessionId, null)}>
                          ⌨
                        </button>
                        <button className="icon" title="Desconectar" onClick={() => void disconnect(session.info.sessionId)}>
                          ⏏
                        </button>
                      </>
                    ) : (
                      <button className="icon" title="Conectar" disabled={state === null} onClick={() => void connect(c)}>
                        ▶
                      </button>
                    )}
                    <button className="icon" title="Editar" onClick={() => setEditing(c)}>
                      ✎
                    </button>
                    {!session && (
                      <button className="icon" title="Borrar" onClick={() => setDeleting(c)}>
                        🗑
                      </button>
                    )}
                  </span>
                </div>
                {/* Plegada se oculta sin desmontar: conserva lo cargado y lo desplegado. */}
                {session && (
                  <div hidden={!expanded}>
                    <Explorer
                      session={session.info}
                      engine={c.engine}
                      visibleDatabases={c.visibleDatabases}
                      onVisibleDatabasesChange={(visible) => setVisibleDatabases(c.id, visible)}
                      activeTable={
                        activeTab?.type === 'table' && activeTab.sessionId === session.info.sessionId ? activeTab.ref : null
                      }
                      onOpenTable={(database, t: TableInfo) =>
                        openTable(session.info.sessionId, { database, schema: t.schema, table: t.name }, t.kind)
                      }
                      onOpenConsole={(database) => openConsole(session.info.sessionId, database)}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </aside>

      <main className="app-main">
        {tabs.length > 0 && (
          <div className="tabs" role="tablist">
            {tabs.map((t) => (
              <div
                key={t.id}
                role="tab"
                aria-selected={t.id === activeTabId}
                className={`tab ${t.id === activeTabId ? 'active' : ''} env-tab-${t.connection.environment}`}
                title={t.type === 'table' ? `${t.connection.name} · ${t.ref.database}.${tabLabel(t.ref)}` : `${t.connection.name} · ${t.title}`}
                onClick={() => setActiveTabId(t.id)}
                onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
              >
                <span className={`env-dot env-${t.connection.environment}`} />
                {t.type === 'table' ? (
                  <>
                    <span className={`kind kind-${t.kind}`}>{t.kind === 'view' ? 'V' : 'T'}</span>
                    {tabLabel(t.ref)}
                    <span className="tab-db">{t.ref.database}</span>
                  </>
                ) : (
                  <>
                    <span className="kind kind-console">⌨</span>
                    {t.title}
                    <span className="tab-db">{t.connection.name}</span>
                  </>
                )}
                <button
                  className="icon"
                  title={keys('Cerrar (Ctrl+W)')}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(t.id)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {tabs.map((t) =>
          t.type === 'table' ? (
            <TableView
              key={t.id}
              tab={t}
              active={t.id === activeTabId}
              filterRequest={filterRequests[t.id] ?? null}
              onNavigate={(ref, where) => openTable(t.sessionId, ref, 'table', where || undefined)}
              onOpenConsole={(database, sql) => openConsole(t.sessionId, database, sql)}
            />
          ) : (
            <ConsoleView key={t.id} tab={t} active={t.id === activeTabId} sqlRequest={sqlRequests[t.id] ?? null} />
          )
        )}

        {!activeTab && (
          <div className="welcome">
            <h1>Gestor BBDD</h1>
            {sessions.length === 0 ? (
              <>
                <div>MySQL / MariaDB y SQL Server · conexión directa, TLS o túnel SSH</div>
                <div className="note">Pulsa una conexión para ver sus bases de datos.</div>
                <button className="primary" onClick={() => setEditing('new')}>
                  Nueva conexión
                </button>
              </>
            ) : (
              <>
                <div>Despliega una base de datos en el explorador y haz doble clic en una tabla para ver sus datos.</div>
                <div className="note">Para escribir consultas, pulsa ⌨ junto a la conexión o a una base de datos.</div>
              </>
            )}
          </div>
        )}
      </main>

      <footer className="statusbar">
        {activeSession ? (
          <>
            <span>{activeSession.connection.name}</span>
            <span>
              {activeSession.info.server.product} {activeSession.info.server.version}
            </span>
            <span>{ENV_LABEL[activeSession.connection.environment]}</span>
            {activeSession.connection.readOnly && <span>Solo lectura</span>}
            {activeSession.info.server.sshHostFingerprint && (
              <span title={`Huella del servidor SSH: ${activeSession.info.server.sshHostFingerprint}`}>
                SSH {activeSession.connection.ssh.host}
              </span>
            )}
            {activeSession.connection.tls.enabled && <span>TLS</span>}
          </>
        ) : (
          <span>
            {secretStatus
              ? secretStatus.persistent
                ? `Contraseñas en el llavero del sistema (${secretStatus.backend})`
                : 'Sin llavero: contraseñas solo en memoria'
              : ''}
          </span>
        )}
        <span className="spacer" />
        <span className="note">{keys('Doble clic: abrir tabla · Enter: editar celda · Alt+Enter: guardar · F5: recargar · Ctrl+W: cerrar')}</span>
        <UpdateControls />
      </footer>

      {editing && (
        <ConnectionDialog
          initial={editing === 'new' ? null : editing}
          secretStatus={secretStatus}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null)
            void reloadConnections()
            // Lo ya abierto sigue con la configuración con la que conectó hasta reconectar; solo cambia el nombre.
            const rename = <T extends { connection: ConnectionSummary }>(x: T): T =>
              x.connection.id === saved.id ? { ...x, connection: { ...x.connection, name: saved.name } } : x
            setSessions((list) => list.map(rename))
            setTabs((list) => list.map(rename))
          }}
        />
      )}

      {transfer === 'export' && <ExportDialog connections={connections} onClose={() => setTransfer(null)} />}
      {transfer === 'import' && <ImportDialog onClose={() => setTransfer(null)} onImported={() => void reloadConnections()} />}

      {deleting && (
        <ConfirmDialog
          title="Borrar conexión"
          confirmLabel="Borrar"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const connection = deleting
            setDeleting(null)
            for (const s of sessions.filter((x) => x.connection.id === connection.id)) await disconnect(s.info.sessionId)
            await window.api.deleteConnection(connection.id)
            void reloadConnections()
          }}
        >
          <p>Se borrará «{deleting.name}» y sus contraseñas guardadas. Esta acción no se puede deshacer.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}
