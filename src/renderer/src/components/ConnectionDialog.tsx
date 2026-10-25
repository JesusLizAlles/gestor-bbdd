import { useState } from 'react'
import type {
  ConnectionConfig,
  ConnectionSummary,
  Engine,
  SaveConnectionInput,
  SecretKey,
  SecretsPatch,
  SecretStorageStatus
} from '@shared/types'
import { DEFAULT_PORTS } from '@shared/types'

type Draft = Omit<ConnectionConfig, 'id'> & { id?: string }
type Tab = 'general' | 'ssh' | 'tls' | 'security'

function emptyDraft(engine: Engine = 'mysql'): Draft {
  return {
    name: '',
    engine,
    host: '',
    port: DEFAULT_PORTS[engine],
    username: '',
    database: '',
    instanceName: '',
    environment: 'dev',
    readOnly: false,
    // SQL Server moderno cifra por defecto; con certificados autofirmados hay que confiar en él.
    tls: { enabled: engine === 'mssql', verifyServerCert: false, caPath: '' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password', privateKeyPath: '' }
  }
}

interface Props {
  initial: ConnectionSummary | null
  secretStatus: SecretStorageStatus | null
  onClose: () => void
  onSaved: (saved: ConnectionSummary) => void
}

/** Campo de secreto: vacío = conservar el guardado; "Olvidar" lo borra. */
function SecretField(props: {
  label: string
  name: SecretKey
  stored: boolean
  values: SecretsPatch
  onChange: (patch: SecretsPatch) => void
}) {
  const value = props.values[props.name]
  const forgotten = value === null
  return (
    <>
      <label htmlFor={`secret-${props.name}`}>{props.label}</label>
      <div className="row">
        <input
          id={`secret-${props.name}`}
          type="password"
          autoComplete="off"
          placeholder={props.stored && !forgotten ? '•••••••• (guardada, déjalo vacío para conservarla)' : ''}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => props.onChange({ ...props.values, [props.name]: e.target.value || undefined })}
        />
        {props.stored && !forgotten && (
          <button type="button" className="link" onClick={() => props.onChange({ ...props.values, [props.name]: null })}>
            Olvidar
          </button>
        )}
      </div>
    </>
  )
}

export function ConnectionDialog({ initial, secretStatus, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<Draft>(() => {
    if (!initial) return emptyDraft()
    const { storedSecrets: _stored, ...config } = initial
    return config
  })
  const [secrets, setSecrets] = useState<SecretsPatch>({})
  const [tab, setTab] = useState<Tab>('general')
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const stored = new Set(initial?.storedSecrets ?? [])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const setSsh = (patch: Partial<Draft['ssh']>) => setDraft((d) => ({ ...d, ssh: { ...d.ssh, ...patch } }))
  const setTls = (patch: Partial<Draft['tls']>) => setDraft((d) => ({ ...d, tls: { ...d.tls, ...patch } }))

  const changeEngine = (engine: Engine) =>
    setDraft((d) => ({
      ...d,
      engine,
      port: d.port === DEFAULT_PORTS[d.engine] ? DEFAULT_PORTS[engine] : d.port,
      tls: initial ? d.tls : { ...d.tls, enabled: engine === 'mssql' }
    }))

  const input = (): SaveConnectionInput => ({
    config: { ...draft, name: draft.name.trim() || `${draft.host}:${draft.port}` },
    secrets
  })

  const pick = async (title: string, apply: (path: string) => void) => {
    const path = await window.api.pickFile(title)
    if (path) apply(path)
  }

  const test = async () => {
    setBusy('test')
    setNotice(null)
    try {
      const info = await window.api.testConnection(input())
      const ssh = info.sshHostFingerprint ? `\nHuella del servidor SSH: ${info.sshHostFingerprint}` : ''
      setNotice({ kind: 'ok', text: `Conexión correcta: ${info.product} ${info.version}${ssh}` })
    } catch (err) {
      setNotice({ kind: 'error', text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setBusy('save')
    setNotice(null)
    try {
      onSaved(await window.api.saveConnection(input()))
    } catch (err) {
      setNotice({ kind: 'error', text: (err as Error).message })
      setBusy(null)
    }
  }

  const tabs: [Tab, string][] = [
    ['general', 'General'],
    ['ssh', draft.ssh.enabled ? 'SSH ✓' : 'SSH'],
    ['tls', draft.tls.enabled ? 'TLS ✓' : 'TLS'],
    ['security', 'Seguridad']
  ]

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <h2>{initial ? 'Editar conexión' : 'Nueva conexión'}</h2>
        <div className="dialog-tabs">
          {tabs.map(([id, label]) => (
            <div key={id} className={`dialog-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </div>
          ))}
        </div>
        <div className="body">
          {notice && <div className={`notice ${notice.kind}`} style={{ whiteSpace: 'pre-wrap' }}>{notice.text}</div>}
          {secretStatus && !secretStatus.persistent && (
            <div className="notice warn">
              No hay llavero del sistema disponible ({secretStatus.backend}): las contraseñas se recordarán solo hasta cerrar la app.
            </div>
          )}

          {tab === 'general' && (
            <div className="form-grid">
              <label htmlFor="conn-name">Nombre</label>
              <input id="conn-name" autoFocus value={draft.name} placeholder="p. ej. Intranet PROD" onChange={(e) => set('name', e.target.value)} />
              <label htmlFor="conn-engine">Motor</label>
              <select id="conn-engine" value={draft.engine} onChange={(e) => changeEngine(e.target.value as Engine)}>
                <option value="mysql">MySQL / MariaDB</option>
                <option value="mssql">SQL Server</option>
              </select>
              <label htmlFor="conn-host">Servidor</label>
              <div className="row">
                <input id="conn-host" value={draft.host} placeholder="IP o nombre" onChange={(e) => set('host', e.target.value)} />
                <input
                  aria-label="Puerto"
                  style={{ width: 90 }}
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.port}
                  onChange={(e) => set('port', Number(e.target.value))}
                />
              </div>
              {draft.engine === 'mssql' && (
                <>
                  <label htmlFor="conn-instance">Instancia</label>
                  <input
                    id="conn-instance"
                    value={draft.instanceName ?? ''}
                    placeholder="opcional (SQLEXPRESS…); se ignora con SSH"
                    onChange={(e) => set('instanceName', e.target.value)}
                  />
                </>
              )}
              <label htmlFor="conn-user">Usuario</label>
              <input id="conn-user" value={draft.username} autoComplete="off" onChange={(e) => set('username', e.target.value)} />
              <SecretField label="Contraseña" name="password" stored={stored.has('password')} values={secrets} onChange={setSecrets} />
              <label htmlFor="conn-db">Base de datos</label>
              <input id="conn-db" value={draft.database ?? ''} placeholder="opcional" onChange={(e) => set('database', e.target.value)} />
            </div>
          )}

          {tab === 'ssh' && (
            <div className="form-grid">
              <label className="check full">
                <input type="checkbox" checked={draft.ssh.enabled} onChange={(e) => setSsh({ enabled: e.target.checked })} />
                Conectar a través de un túnel SSH
              </label>
              {draft.ssh.enabled && (
                <>
                  <label htmlFor="ssh-host">Servidor SSH</label>
                  <div className="row">
                    <input id="ssh-host" value={draft.ssh.host} placeholder="bastión" onChange={(e) => setSsh({ host: e.target.value })} />
                    <input
                      aria-label="Puerto SSH"
                      style={{ width: 90 }}
                      type="number"
                      value={draft.ssh.port}
                      onChange={(e) => setSsh({ port: Number(e.target.value) })}
                    />
                  </div>
                  <label htmlFor="ssh-user">Usuario SSH</label>
                  <input id="ssh-user" value={draft.ssh.username} onChange={(e) => setSsh({ username: e.target.value })} />
                  <label htmlFor="ssh-auth">Autenticación</label>
                  <select
                    id="ssh-auth"
                    value={draft.ssh.authMethod}
                    onChange={(e) => setSsh({ authMethod: e.target.value as Draft['ssh']['authMethod'] })}
                  >
                    <option value="password">Contraseña</option>
                    <option value="privateKey">Clave privada</option>
                    <option value="agent">Agente SSH</option>
                  </select>
                  {draft.ssh.authMethod === 'password' && (
                    <SecretField label="Contraseña SSH" name="sshPassword" stored={stored.has('sshPassword')} values={secrets} onChange={setSecrets} />
                  )}
                  {draft.ssh.authMethod === 'privateKey' && (
                    <>
                      <label htmlFor="ssh-key">Clave privada</label>
                      <div className="row">
                        <input
                          id="ssh-key"
                          value={draft.ssh.privateKeyPath ?? ''}
                          placeholder="~/.ssh/id_ed25519"
                          onChange={(e) => setSsh({ privateKeyPath: e.target.value })}
                        />
                        <button type="button" onClick={() => pick('Clave privada SSH', (p) => setSsh({ privateKeyPath: p }))}>
                          …
                        </button>
                      </div>
                      <SecretField label="Frase de paso" name="sshPassphrase" stored={stored.has('sshPassphrase')} values={secrets} onChange={setSecrets} />
                    </>
                  )}
                  <div className="note full">
                    El servidor y puerto de la pestaña General se resuelven desde el servidor SSH: si la base de datos está
                    en la misma máquina, usa 127.0.0.1. La primera vez se guarda la huella del servidor SSH y, si cambia, la
                    conexión se rechaza.
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'tls' && (
            <div className="form-grid">
              <label className="check full">
                <input type="checkbox" checked={draft.tls.enabled} onChange={(e) => setTls({ enabled: e.target.checked })} />
                Cifrar la conexión con TLS
              </label>
              {draft.tls.enabled && (
                <>
                  <label className="check full">
                    <input
                      type="checkbox"
                      checked={draft.tls.verifyServerCert}
                      onChange={(e) => setTls({ verifyServerCert: e.target.checked })}
                    />
                    Verificar el certificado del servidor
                  </label>
                  <label htmlFor="tls-ca">CA (PEM)</label>
                  <div className="row">
                    <input id="tls-ca" value={draft.tls.caPath ?? ''} placeholder="opcional" onChange={(e) => setTls({ caPath: e.target.value })} />
                    <button type="button" onClick={() => pick('Certificado de la CA', (p) => setTls({ caPath: p }))}>
                      …
                    </button>
                  </div>
                  {!draft.tls.verifyServerCert && (
                    <div className="note full">Sin verificar, el tráfico va cifrado pero no se comprueba la identidad del servidor.</div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'security' && (
            <div className="form-grid">
              <label htmlFor="conn-env">Entorno</label>
              <select id="conn-env" value={draft.environment} onChange={(e) => set('environment', e.target.value as Draft['environment'])}>
                <option value="dev">Desarrollo</option>
                <option value="test">Pruebas</option>
                <option value="prod">Producción (pide confirmación antes de escribir)</option>
              </select>
              <label className="check full">
                <input type="checkbox" checked={draft.readOnly} onChange={(e) => set('readOnly', e.target.checked)} />
                Solo lectura (bloquea INSERT, UPDATE, DELETE, DDL…)
              </label>
              <div className="note full">
                En MySQL/MariaDB el modo solo lectura también se aplica en el servidor (SET SESSION TRANSACTION READ ONLY).
                En SQL Server se filtra en la app: para una garantía total usa un usuario con permisos solo de lectura.
              </div>
            </div>
          )}
        </div>
        <div className="footer">
          <button type="button" onClick={test} disabled={busy !== null || !draft.host}>
            {busy === 'test' ? 'Probando…' : 'Probar conexión'}
          </button>
          <div className="spacer" />
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={busy !== null || !draft.host}>
            Guardar
          </button>
        </div>
      </form>
    </div>
  )
}
