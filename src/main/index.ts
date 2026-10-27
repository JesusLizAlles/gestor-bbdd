import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendFile, mkdir, stat, truncate } from 'node:fs/promises'
import { app, BrowserWindow, Menu, safeStorage, screen, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { UPDATE_STATE_EVENT } from '@shared/ipc'
import { createDriver } from './drivers'
import { registerIpc } from './ipc'
import { SessionManager } from './sessions'
import { KnownHosts } from './ssh/known-hosts'
import { ConnectionStore } from './store/connections'
import { ConsoleStore } from './store/consoles'
import { HistoryStore } from './store/history'
import { SecretVault, type SecretCipher } from './store/secrets'
import { placeWindow, WindowStateStore } from './store/window-state'
import { Updater, type UpdaterBackend } from './updater'
import icon from '../../resources/icon.png?asset'

const here = import.meta.dirname

/** safeStorage usa el llavero del SO (libsecret/KWallet, Keychain, DPAPI). */
const electronCipher: SecretCipher = {
  async status() {
    const available = await safeStorage.isAsyncEncryptionAvailable()
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend()
      // basic_text cifra con una clave fija: no lo consideramos seguro para guardar contraseñas.
      return { persistent: available && backend !== 'basic_text' && backend !== 'unknown', backend }
    }
    return { persistent: available, backend: process.platform === 'darwin' ? 'keychain' : 'dpapi' }
  },
  encrypt: (plain) => safeStorage.encryptStringAsync(plain),
  decrypt: async (data) => {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(data)
    return { value: result, reencrypt: shouldReEncrypt }
  }
}

let mainWindow: BrowserWindow | null = null

/** Registro del actualizador en logs/updater.log (se vacía al pasar de 1 MB). */
function updaterLog(line: string): void {
  const dir = app.getPath('logs')
  const file = join(dir, 'updater.log')
  void (async () => {
    await mkdir(dir, { recursive: true })
    const size = await stat(file).then((s) => s.size, () => 0)
    if (size > 1_000_000) await truncate(file, 0)
    await appendFile(file, `${new Date().toISOString()} ${line}\n`)
  })().catch(() => {})
}

const RELEASES_URL = 'https://github.com/JesusLizAlles/gestor-bbdd/releases'

/**
 * En macOS la app no va firmada con Developer ID y Squirrel.Mac no instalaría la versión nueva:
 * se abre en el navegador el .dmg de la arquitectura de este equipo (nombre de electron-builder.yml).
 */
function openMacDownload(version: string): void {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  void shell.openExternal(`${RELEASES_URL}/download/v${version}/gestor-bbdd-${version}-mac-${arch}.dmg`)
}

/** electron-updater solo sirve en la app instalada y, en Linux, si se ejecuta como AppImage. */
function updaterBackend(): { backend: UpdaterBackend | null; reason?: string; manualDownload?: (version: string) => void } {
  if (!app.isPackaged) return { backend: null, reason: 'Las actualizaciones automáticas solo funcionan en la app instalada.' }
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    return { backend: null, reason: 'Esta instalación no es un AppImage: descarga las versiones nuevas desde GitHub.' }
  }
  const { autoUpdater } = electronUpdater
  autoUpdater.logger = {
    info: (m: unknown) => updaterLog(`INFO ${String(m)}`),
    warn: (m: unknown) => updaterLog(`WARN ${String(m)}`),
    error: (m: unknown) => updaterLog(`ERROR ${String(m)}`),
    debug: (m: unknown) => updaterLog(`DEBUG ${String(m)}`)
  }
  return {
    backend: autoUpdater as unknown as UpdaterBackend,
    manualDownload: process.platform === 'darwin' ? openMacDownload : undefined
  }
}

/**
 * Sin menú en Windows y Linux. En macOS hace falta uno: los atajos de edición (Cmd+C/V/X/Z/A en
 * los campos de texto) y Cmd+Q funcionan a través de sus elementos.
 */
function applicationMenu(): Menu | null {
  if (process.platform !== 'darwin') return null
  return Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
}

function createWindow(windowState: WindowStateStore): BrowserWindow {
  const primary = screen.getPrimaryDisplay()
  const workAreas = [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea)
  const minWidth = 900
  const minHeight = 600
  const { maximized, fullScreen, ...bounds } = placeWindow(windowState.load(), workAreas, {
    width: 1400,
    height: 900,
    minWidth,
    minHeight
  })
  const win = new BrowserWindow({
    ...bounds,
    minWidth,
    minHeight,
    show: false,
    title: 'Gestor BBDD',
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    // En Windows y macOS el icono sale del ejecutable; en Linux hay que dárselo a la ventana.
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => {
    if (fullScreen) win.setFullScreen(true)
    else if (maximized) win.maximize()
    win.show()
  })
  // Al cerrar se recuerda el tamaño sin maximizar (getNormalBounds) y el estado aparte.
  win.on('close', () => {
    try {
      windowState.save({ bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() })
    } catch {
      // No poder guardarlo no debe impedir cerrar.
    }
  })

  // La interfaz nunca navega fuera de la app; los enlaces externos se abren en el navegador.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(here, '../renderer/index.html'))

  // Ayuda de desarrollo: GESTOR_SCREENSHOT=/ruta.png captura la ventana y cierra la app.
  const screenshotPath = process.env.GESTOR_SCREENSHOT
  if (screenshotPath && !app.isPackaged) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await win.webContents.capturePage()
        await writeFile(screenshotPath, image.toPNG())
        app.quit()
      }, Number(process.env.GESTOR_SCREENSHOT_DELAY ?? 2500))
    })
  }
  return win
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(applicationMenu())
  const dataDir = app.getPath('userData')
  const vault = new SecretVault(dataDir, electronCipher)
  const store = new ConnectionStore(dataDir, vault)
  const history = new HistoryStore(dataDir)
  const consoles = new ConsoleStore(dataDir)
  const windowState = new WindowStateStore(dataDir)
  const sessions = new SessionManager({ createDriver, knownHosts: new KnownHosts(dataDir), history })
  const { backend, reason, manualDownload } = updaterBackend()
  const updater = new Updater({
    backend,
    currentVersion: app.getVersion(),
    unsupportedReason: reason,
    manualDownload,
    send: (state) => mainWindow?.webContents.send(UPDATE_STATE_EVENT, state),
    log: updaterLog
  })

  registerIpc({ store, vault, sessions, history, consoles, updater, window: () => mainWindow })
  const openWindow = () => {
    mainWindow = createWindow(windowState)
    mainWindow.on('closed', () => {
      mainWindow = null
      void sessions.closeAll()
    })
  }
  openWindow()
  updater.startAutoCheck()

  // macOS: la app sigue viva sin ventanas; el clic en el Dock abre una nueva.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
  app.on('before-quit', () => {
    void sessions.closeAll()
  })
  // Lo último escrito en las consolas puede seguir en vuelo: se termina de guardar antes de salir.
  app.on('will-quit', () => consoles.flushSync())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
