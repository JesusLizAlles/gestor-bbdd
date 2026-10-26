import { useEffect, useState, type ReactNode } from 'react'
import type { ConnectionSummary, Engine, Environment, ImportPreview, ImportResult } from '@shared/types'

const MIN_PASSPHRASE = 8

interface Item {
  id: string
  name: string
  engine: Engine
  host: string
  environment: Environment
  /** Etiqueta a la derecha (p. ej. «Sustituye»). */
  tag?: string
}

/** Lista de conexiones con casillas y «Todas». */
function ConnectionChecklist({ items, selected, onChange }: { items: Item[]; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const all = items.length > 0 && items.every((i) => selected.has(i.id))
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (!next.delete(id)) next.add(id)
    onChange(next)
  }
  return (
    <div className="transfer-list">
      <label className="check transfer-all">
        <input type="checkbox" checked={all} onChange={() => onChange(all ? new Set() : new Set(items.map((i) => i.id)))} />
        Todas ({items.length})
      </label>
      {items.map((i) => (
        <label key={i.id} className="check">
          <input type="checkbox" checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
          <span className={`env-dot env-${i.environment}`} />
          <span className="transfer-name">{i.name}</span>
          <span className="transfer-host">{i.host}</span>
          {i.tag && <span className="badge">{i.tag}</span>}
          <span className="badge">{i.engine === 'mysql' ? 'MySQL' : 'MSSQL'}</span>
        </label>
      ))}
    </div>
  )
}

function Dialog({ title, children, footer, onClose }: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={title} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>{title}</h2>
        <div className="body">{children}</div>
        <div className="footer">{footer}</div>
      </div>
    </div>
  )
}

/** Exporta las conexiones elegidas a un fichero, con sus contraseñas cifradas si se pide. */
export function ExportDialog({ connections, onClose }: { connections: ConnectionSummary[]; onClose: () => void }) {
  const [selected, setSelected] = useState(() => new Set(connections.map((c) => c.id)))
  const [withPasswords, setWithPasswords] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedTo, setSavedTo] = useState<string | null>(null)

  const passError = !withPasswords
    ? null
    : passphrase.length < MIN_PASSPHRASE
      ? `La clave debe tener al menos ${MIN_PASSPHRASE} caracteres`
      : passphrase !== repeat
        ? 'Las dos claves no coinciden'
        : null

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const path = await window.api.exportConfig({ connectionIds: [...selected], passphrase: withPasswords ? passphrase : null })
      if (path) setSavedTo(path)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (savedTo) {
    return (
      <Dialog title="Conexiones exportadas" onClose={onClose} footer={<><div className="spacer" /><button className="primary" autoFocus onClick={onClose}>Cerrar</button></>}>
        <div className="notice ok">
          {selected.size === 1 ? 'Se ha exportado 1 conexión' : `Se han exportado ${selected.size} conexiones`}
          {withPasswords ? ', con sus contraseñas cifradas,' : ''} en:
          <br />
          <code>{savedTo}</code>
        </div>
        <p className="note">
          Cópialo al otro equipo y usa «Importar conexiones».
          {withPasswords && ' Allí te pedirá la clave: compártela por otro canal, no junto al fichero.'}
        </p>
      </Dialog>
    )
  }

  return (
    <Dialog
      title="Exportar conexiones"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={busy || selected.size === 0 || passError !== null} onClick={() => void run()}>
            {busy ? 'Exportando…' : 'Exportar…'}
          </button>
        </>
      }
    >
      {error && <div className="notice error">{error}</div>}
      <ConnectionChecklist items={connections} selected={selected} onChange={setSelected} />
      <label className="check transfer-option">
        <input type="checkbox" checked={withPasswords} onChange={(e) => setWithPasswords(e.target.checked)} />
        Incluir las contraseñas
      </label>
      {withPasswords ? (
        <div className="form-grid">
          <label htmlFor="export-pass">Clave</label>
          <input id="export-pass" type="password" autoFocus autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          <label htmlFor="export-repeat">Repite la clave</label>
          <input id="export-repeat" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          <p className="note full">
            Las contraseñas se cifran con esta clave y se pedirá al importar. No se guarda en ningún sitio: si se olvida, el
            fichero sirve igual, pero sin contraseñas.
            {passError && passphrase && <span className="transfer-pass-error"> {passError}.</span>}
          </p>
        </div>
      ) : (
        <p className="note">
          Sin contraseñas: al importarlas habrá que escribirlas en el otro equipo. Las rutas de claves SSH y certificados se
          exportan tal cual; si en el otro equipo están en otra carpeta, habrá que cambiarlas.
        </p>
      )}
    </Dialog>
  )
}

/** Pide un fichero exportado, enseña lo que trae e importa lo elegido. */
export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  const pick = async () => {
    setError(null)
    try {
      const p = await window.api.previewImport()
      if (!p) {
        if (!preview) onClose()
        return
      }
      setPreview(p)
      setSelected(new Set(p.connections.map((c) => c.id)))
      setPassphrase('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // Al abrir, directamente el selector de fichero.
  useEffect(() => {
    void pick()
  }, [])

  const run = async () => {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.importConfig({
        token: preview.token,
        connectionIds: [...selected],
        passphrase: preview.encrypted && passphrase ? passphrase : null
      })
      setResult(r)
      onImported()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    const parts = [
      result.added && (result.added === 1 ? '1 conexión nueva' : `${result.added} conexiones nuevas`),
      result.updated && (result.updated === 1 ? '1 actualizada' : `${result.updated} actualizadas`)
    ].filter(Boolean)
    return (
      <Dialog title="Conexiones importadas" onClose={onClose} footer={<><div className="spacer" /><button className="primary" autoFocus onClick={onClose}>Cerrar</button></>}>
        <div className="notice ok">
          Importado: {parts.join(' y ')}
          {result.withPasswords ? ', con sus contraseñas.' : '.'}
        </div>
        {!result.withPasswords && <p className="note">Sin contraseñas: escríbelas al conectar o desde «Editar».</p>}
      </Dialog>
    )
  }

  if (!preview) {
    // Mientras está abierto el selector de fichero (o si falló al leerlo).
    return error ? (
      <Dialog title="Importar conexiones" onClose={onClose} footer={<><div className="spacer" /><button onClick={onClose}>Cerrar</button><button className="primary" onClick={() => void pick()}>Elegir otro fichero…</button></>}>
        <div className="notice error">{error}</div>
      </Dialog>
    ) : null
  }

  const replaced = preview.connections.filter((c) => c.exists && selected.has(c.id)).length
  const date = new Date(preview.exportedAt).toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' })

  return (
    <Dialog
      title="Importar conexiones"
      onClose={onClose}
      footer={
        <>
          <button onClick={() => void pick()}>Elegir otro fichero…</button>
          <div className="spacer" />
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={busy || selected.size === 0} onClick={() => void run()}>
            {busy ? 'Importando…' : `Importar ${selected.size}`}
          </button>
        </>
      }
    >
      {error && <div className="notice error">{error}</div>}
      <p className="note">
        <strong>{preview.fileName}</strong> · exportado el {date}
      </p>
      <ConnectionChecklist
        items={preview.connections.map((c) => ({ ...c, tag: c.exists ? 'Sustituye' : undefined }))}
        selected={selected}
        onChange={setSelected}
      />
      {replaced > 0 && (
        <p className="note">
          {replaced === 1 ? 'Una ya existe' : `${replaced} ya existen`} en este equipo: se sustituye su configuración. Si el fichero no
          trae contraseñas, se conservan las que tengas guardadas.
        </p>
      )}
      {preview.encrypted ? (
        <div className="form-grid transfer-option">
          <label htmlFor="import-pass">Clave</label>
          <input id="import-pass" type="password" autoFocus autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          <p className="note full">El fichero trae contraseñas cifradas. Sin la clave, se importa todo menos las contraseñas.</p>
        </div>
      ) : (
        <p className="note">El fichero no trae contraseñas.</p>
      )}
    </Dialog>
  )
}
