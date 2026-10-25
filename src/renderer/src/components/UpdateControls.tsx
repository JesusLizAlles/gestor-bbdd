import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UpdateState } from '@shared/types'

const RELEASES_URL = 'https://github.com/JesusLizAlles/gestor-bbdd/releases'
const FLASH_MS = 6000

/**
 * Actualizaciones: botón en la barra de estado (versión instalada → buscar), aviso cuando la
 * comprobación automática encuentra una versión nueva y diálogo para descargar e instalar.
 */
export function UpdateControls() {
  const [state, setState] = useState<UpdateState | null>(null)
  const [dialog, setDialog] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    void window.api.updaterState().then(setState)
    return window.api.onUpdateState(setState)
  }, [])

  // Resultado de una búsqueda pedida por el usuario: se le cuenta siempre.
  useEffect(() => {
    if (!state?.manual) return
    if (state.status === 'available') setDialog(true)
    if (state.status === 'not-available') setFlash(`Tienes la última versión (${state.currentVersion})`)
    if (state.status === 'error') setFlash(state.error ?? 'No se pudo comprobar si hay actualizaciones')
  }, [state?.status, state?.manual])

  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flash])

  if (!state) return null
  const { status, currentVersion, version } = state
  const check = () => void window.api.checkForUpdates()

  let button
  if (flash) {
    button = <span className="update-flash">{flash}</span>
  } else if (status === 'unsupported') {
    button = <span title={state.reason}>v{currentVersion}</span>
  } else if (status === 'checking') {
    button = <span>Buscando actualizaciones…</span>
  } else if (status === 'available') {
    button = (
      <button className="update-btn highlight" onClick={() => setDialog(true)}>
        ⬆ Versión {version} disponible
      </button>
    )
  } else if (status === 'downloading') {
    button = (
      <button className="update-btn" onClick={() => setDialog(true)}>
        Descargando actualización {state.percent ?? 0} %
      </button>
    )
  } else if (status === 'downloaded') {
    button = (
      <button className="update-btn highlight" onClick={() => setDialog(true)}>
        ⟳ Reiniciar para actualizar a {version}
      </button>
    )
  } else {
    button = (
      <button className="update-btn" title="Buscar actualizaciones" onClick={check}>
        v{currentVersion}
        {status === 'error' && !state.manual ? ' ⚠' : ''}
      </button>
    )
  }

  // La comprobación automática solo avisa, sin abrir nada, y una vez por versión.
  const showToast = status === 'available' && !state.manual && !dialog && version !== dismissed

  // El aviso y el diálogo van al <body>: dentro de la barra de estado heredarían su nowrap.
  return (
    <>
      {button}
      {createPortal(
        <>
          {showToast && (
            <div className="update-toast" role="status">
              <span>
                Hay una versión nueva de Gestor BBDD: <strong>{version}</strong>
              </span>
              <button className="compact primary" onClick={() => setDialog(true)}>
                Ver
              </button>
              <button className="icon" title="Más tarde" onClick={() => setDismissed(version ?? null)}>
                ×
              </button>
            </div>
          )}
          {dialog && ['available', 'downloading', 'downloaded'].includes(status) && (
            <UpdateDialog state={state} onClose={() => setDialog(false)} />
          )}
        </>,
        document.body
      )}
    </>
  )
}

function UpdateDialog({ state, onClose }: { state: UpdateState; onClose: () => void }) {
  const { status, version, currentVersion, releaseNotes, releaseDate, percent, error } = state
  const date = releaseDate ? new Date(releaseDate).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : null
  const title = status === 'downloaded' ? 'Actualización lista' : status === 'downloading' ? 'Descargando actualización' : 'Actualización disponible'

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog update-dialog" role="dialog" aria-label={title} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>{title}</h2>
        <div className="body">
          <p>
            Versión instalada <strong>{currentVersion}</strong> → nueva <strong>{version}</strong>
            {date ? ` (${date})` : ''}
          </p>
          {releaseNotes && <div className="update-notes">{releaseNotes}</div>}
          {error && <div className="notice error">{error}</div>}
          {status === 'downloading' && (
            <div className="progress" role="progressbar" aria-valuenow={percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${percent ?? 0}%` }} />
            </div>
          )}
          {status === 'downloaded' && (
            <p className="note">
              Al reiniciar se cierra la app: guarda antes los cambios pendientes de tablas y consolas. Si eliges «Al cerrar
              la app», se instalará la próxima vez que la cierres.
            </p>
          )}
          <p className="note">
            <a href={RELEASES_URL} target="_blank" rel="noreferrer">
              Ver todas las versiones en GitHub
            </a>
          </p>
        </div>
        <div className="footer">
          <div className="spacer" />
          {status === 'available' && (
            <>
              <button onClick={onClose}>Más tarde</button>
              <button className="primary" autoFocus onClick={() => void window.api.downloadUpdate()}>
                Descargar
              </button>
            </>
          )}
          {status === 'downloading' && <button onClick={onClose}>Seguir trabajando</button>}
          {status === 'downloaded' && (
            <>
              <button onClick={onClose}>Al cerrar la app</button>
              <button className="primary" autoFocus onClick={() => void window.api.installUpdate()}>
                Reiniciar ahora
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
