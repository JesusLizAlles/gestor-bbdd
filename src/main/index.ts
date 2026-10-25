import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, safeStorage, shell } from 'electron'
import { createDriver } from './drivers'
import { registerIpc } from './ipc'
import { SessionManager } from './sessions'
import { KnownHosts } from './ssh/known-hosts'
import { ConnectionStore } from './store/connections'
import { SecretVault, type SecretCipher } from './store/secrets'

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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Gestor BBDD',
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

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
  Menu.setApplicationMenu(null)
  const dataDir = app.getPath('userData')
  const vault = new SecretVault(dataDir, electronCipher)
  const store = new ConnectionStore(dataDir, vault)
  const sessions = new SessionManager({ createDriver, knownHosts: new KnownHosts(dataDir) })

  registerIpc({ store, vault, sessions, window: () => mainWindow })
  mainWindow = createWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
    void sessions.closeAll()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
  app.on('before-quit', () => {
    void sessions.closeAll()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
