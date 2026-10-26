import type { UpdateState } from '@shared/types'

/** Lo que usamos de electron-updater; así se puede probar con un sustituto. */
export interface UpdaterBackend {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  // Misma firma que EventEmitter.on: cada evento entrega sus propios argumentos.
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

interface UpdateInfoLike {
  version: string
  releaseDate?: string
  releaseNotes?: string | { note?: string | null }[] | null
}

export interface UpdaterOptions {
  /** null = esta instalación no se puede actualizar sola. */
  backend: UpdaterBackend | null
  currentVersion: string
  unsupportedReason?: string
  /**
   * Sin instalación automática (macOS sin firmar: Squirrel.Mac rechaza la versión nueva). Se sigue
   * buscando versiones, pero «Descargar» llama aquí y el usuario instala la nueva a mano.
   */
  manualDownload?: (version: string) => void
  /** Avisa a la interfaz de cada cambio de estado. */
  send: (state: UpdateState) => void
  log?: (message: string) => void
}

/** Notas de GitHub (HTML) a texto plano: la interfaz nunca pinta HTML que llega de fuera. */
export function htmlToText(html: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<\/\s*(p|div|li|h[1-6]|ul|ol|pre|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (entities[code]) return entities[code]
      if (code.startsWith('#x')) return String.fromCodePoint(parseInt(code.slice(2), 16))
      if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)))
      return match
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function notesOf(info: UpdateInfoLike): string | undefined {
  const notes = info.releaseNotes
  if (!notes) return undefined
  const html = typeof notes === 'string' ? notes : notes.map((n) => n.note ?? '').join('\n\n')
  return htmlToText(html) || undefined
}

/** Mensajes claros para los fallos habituales al buscar o descargar actualizaciones. */
export function describeUpdateError(err: Error & { code?: string }): string {
  const message = err.message ?? String(err)
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(message)) {
    return 'No hay conexión con GitHub. Vuelve a intentarlo cuando tengas internet.'
  }
  if (/404|latest.*\.yml|Cannot find/i.test(message)) {
    return 'La última versión publicada no incluye los datos de actualización.'
  }
  if (/sha512 checksum mismatch/i.test(message)) {
    return 'La descarga no coincide con la publicada (la suma no cuadra). No se ha instalado nada.'
  }
  if (/not signed by the application owner/i.test(message)) {
    return 'La versión descargada no está firmada por el mismo editor. No se ha instalado nada.'
  }
  return `No se pudo actualizar: ${message}`
}

/**
 * Comprueba, descarga e instala versiones nuevas. No descarga nada sin que el usuario lo pida
 * y no reinicia por su cuenta: si la descarga está lista, se instala al cerrar la app.
 */
export class Updater {
  private state: UpdateState
  private manual = false
  private timers: NodeJS.Timeout[] = []

  constructor(private readonly opts: UpdaterOptions) {
    this.state = opts.backend
      ? { status: 'idle', currentVersion: opts.currentVersion, ...this.installMode() }
      : { status: 'unsupported', currentVersion: opts.currentVersion, reason: opts.unsupportedReason }
    const backend = opts.backend
    if (!backend) return
    backend.autoDownload = false
    backend.autoInstallOnAppQuit = !opts.manualDownload
    backend.on('checking-for-update', () => this.set({ status: 'checking' }))
    backend.on('update-available', (info: UpdateInfoLike) =>
      this.set({ status: 'available', version: info.version, releaseDate: info.releaseDate, releaseNotes: notesOf(info) })
    )
    backend.on('update-not-available', () => this.set({ status: 'not-available' }))
    backend.on('download-progress', (p: { percent: number }) =>
      this.set({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p.percent))) })
    )
    backend.on('update-downloaded', (info: UpdateInfoLike) =>
      this.set({ status: 'downloaded', version: info.version, releaseNotes: notesOf(info) ?? this.state.releaseNotes, percent: 100 })
    )
    backend.on('error', (err: Error) => {
      opts.log?.(`Error del actualizador: ${err.stack ?? err.message}`)
      // Un fallo durante la descarga deja la versión disponible para reintentarlo.
      const retry = this.state.status === 'downloading' && this.state.version
      this.set({ status: retry ? 'available' : 'error', error: describeUpdateError(err) })
    })
  }

  get(): UpdateState {
    return this.state
  }

  /** `manual` = la ha pedido el usuario; las automáticas no molestan si no hay nada nuevo. */
  async check(manual: boolean): Promise<UpdateState> {
    const { backend } = this.opts
    if (!backend) return this.state
    // Mientras se descarga, o con una descarga lista, no tiene sentido volver a buscar.
    if (['checking', 'downloading', 'downloaded'].includes(this.state.status)) return this.state
    this.manual = manual
    this.set({ status: 'checking', error: undefined })
    try {
      await backend.checkForUpdates()
    } catch (err) {
      // electron-updater ya emite 'error'; esto cubre los fallos que no lo hacen.
      if (this.get().status === 'checking') this.set({ status: 'error', error: describeUpdateError(err as Error) })
    }
    return this.state
  }

  async download(): Promise<UpdateState> {
    const { backend } = this.opts
    if (!backend || this.state.status !== 'available') return this.state
    if (this.opts.manualDownload) {
      this.opts.log?.(`Descarga manual de la versión ${this.state.version}`)
      this.opts.manualDownload(this.state.version!)
      return this.state
    }
    this.set({ status: 'downloading', percent: 0, error: undefined })
    try {
      await backend.downloadUpdate()
    } catch (err) {
      // this.get(): el estado puede haber cambiado por los eventos durante la espera.
      if (this.get().status === 'downloading') this.set({ status: 'available', error: describeUpdateError(err as Error) })
    }
    return this.state
  }

  /** Cierra la app e instala. En Windows el instalador va en silencio y vuelve a abrir la app. */
  install(): void {
    if (!this.opts.backend || this.state.status !== 'downloaded') return
    this.opts.log?.(`Instalando la versión ${this.state.version}`)
    this.opts.backend.quitAndInstall(true, true)
  }

  /** Primera comprobación al poco de arrancar y luego cada `intervalMs`. */
  startAutoCheck(delayMs = 10_000, intervalMs = 6 * 60 * 60 * 1000): void {
    if (!this.opts.backend) return
    this.timers.push(setTimeout(() => void this.check(false), delayMs))
    this.timers.push(setInterval(() => void this.check(false), intervalMs))
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  private set(patch: Partial<UpdateState>): void {
    const { currentVersion } = this.opts
    const status = patch.status ?? this.state.status
    // Mientras haya una versión en juego se conservan sus datos; si no, se parte de cero.
    const base = ['available', 'downloading', 'downloaded'].includes(status) ? this.state : { status, currentVersion }
    this.state = { ...base, ...patch, status, currentVersion, manual: this.manual, ...this.installMode() }
    this.opts.send(this.state)
  }

  private installMode(): Pick<UpdateState, 'manualInstall'> {
    return this.opts.manualDownload ? { manualInstall: true } : {}
  }
}
