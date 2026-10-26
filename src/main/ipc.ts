import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { channelName, type ApiChannel, type IpcEnvelope } from '@shared/ipc'
import type { ConnectionConfig, DbApi, SaveConnectionInput, SecretKey } from '@shared/types'
import { ZodError } from 'zod'
import type { SessionManager } from './sessions'
import type { ConsoleStore } from './store/consoles'
import type { HistoryStore } from './store/history'
import type { Updater } from './updater'
import type { ConnectionStore } from './store/connections'
import type { SecretVault } from './store/secrets'
import {
  consoleStateSchema,
  countSchema,
  exportSchema,
  historyKindSchema,
  historySearchSchema,
  identifierSchema,
  idSchema,
  runQuerySchema,
  saveConnectionSchema,
  tableDataSchema,
  tableRefSchema,
  rowChangesSchema,
  visibleDatabasesSchema
} from './validation'

export interface IpcDeps {
  store: ConnectionStore
  vault: SecretVault
  sessions: SessionManager
  history: HistoryStore
  consoles: ConsoleStore
  updater: Updater
  window: () => BrowserWindow | null
}

type Handlers = { [K in ApiChannel]: (...args: unknown[]) => ReturnType<DbApi[K]> }

function errorMessage(err: unknown): string {
  if (err instanceof ZodError) {
    return `Datos no válidos: ${err.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ')}`
  }
  return err instanceof Error ? err.message : String(err)
}

/** Secretos para probar una conexión: los guardados (si existe) con los cambios del formulario encima. */
async function mergeSecrets(vault: SecretVault, input: SaveConnectionInput): Promise<Partial<Record<SecretKey, string>>> {
  const stored = input.config.id ? await vault.get(input.config.id) : {}
  for (const [key, value] of Object.entries(input.secrets ?? {}) as [SecretKey, string | null | undefined][]) {
    if (value === null) delete stored[key]
    else if (typeof value === 'string') stored[key] = value
  }
  return stored
}

export function registerIpc({ store, vault, sessions, history, consoles, updater, window }: IpcDeps): void {
  const handlers: Handlers = {
    secretStorageStatus: async () => vault.status(),
    listConnections: () => store.list(),
    saveConnection: (input) => store.save(saveConnectionSchema.parse(input)),
    deleteConnection: async (id) => {
      const connectionId = idSchema.parse(id)
      await store.delete(connectionId)
      await history.deleteConnection(connectionId)
      await consoles.deleteConnection(connectionId)
    },
    setVisibleDatabases: (id, databases) =>
      store.setVisibleDatabases(idSchema.parse(id), visibleDatabasesSchema.parse(databases)),
    testConnection: async (raw) => {
      const input = saveConnectionSchema.parse(raw)
      const config: ConnectionConfig = { ...input.config, id: input.config.id ?? 'prueba' }
      return sessions.test(config, await mergeSecrets(vault, input))
    },
    openSession: async (id) => {
      const connectionId = idSchema.parse(id)
      return sessions.open(await store.get(connectionId), await vault.get(connectionId))
    },
    closeSession: (id) => sessions.close(idSchema.parse(id)),
    listDatabases: (id) => sessions.listDatabases(idSchema.parse(id)),
    listTables: (id, db) => sessions.listTables(idSchema.parse(id), identifierSchema.parse(db)),
    listColumns: (id, db, table, schema) =>
      sessions.listColumns(
        idSchema.parse(id),
        identifierSchema.parse(db),
        identifierSchema.parse(table),
        identifierSchema.nullable().parse(schema)
      ),
    completionColumns: (id, db) => sessions.completionColumns(idSchema.parse(id), identifierSchema.parse(db)),
    fetchTableData: (id, input) => sessions.fetchTableData(idSchema.parse(id), tableDataSchema.parse(input)),
    countTableRows: (id, input) => sessions.countTableRows(idSchema.parse(id), countSchema.parse(input)),
    tableStructure: (id, ref) => sessions.tableStructure(idSchema.parse(id), tableRefSchema.parse(ref)),
    saveRowChanges: (id, input) => sessions.saveRowChanges(idSchema.parse(id), rowChangesSchema.parse(input)),
    runQuery: (id, input) => sessions.run(idSchema.parse(id), runQuerySchema.parse(input)),
    queryHistory: (id, search) => history.listQueries(idSchema.parse(id), historySearchSchema.parse(search)),
    filterHistory: (id, ref) => history.listFilters(idSchema.parse(id), tableRefSchema.parse(ref)),
    clearHistory: (id, kind, ref) =>
      history.clear(idSchema.parse(id), historyKindSchema.parse(kind), ref == null ? undefined : tableRefSchema.parse(ref)),
    cancelQuery: (id) => sessions.cancel(idSchema.parse(id)),
    updaterState: async () => updater.get(),
    checkForUpdates: () => updater.check(true),
    downloadUpdate: () => updater.download(),
    installUpdate: async () => updater.install(),
    loadConsole: (id, database) => consoles.get(idSchema.parse(id), identifierSchema.nullable().parse(database)),
    saveConsole: (id, database, state) =>
      consoles.save(idSchema.parse(id), identifierSchema.nullable().parse(database), consoleStateSchema.parse(state)),
    exportFile: async (raw) => {
      const input = exportSchema.parse(raw)
      const win = window()
      const options = {
        title: 'Exportar resultado',
        defaultPath: join(app.getPath('downloads'), `${input.defaultName}.${input.format}`),
        filters: [{ name: input.format.toUpperCase(), extensions: [input.format] }]
      }
      const { canceled, filePath } = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (canceled || !filePath) return null
      await writeFile(filePath, input.content, 'utf8')
      return filePath
    },
    pickFile: async (title) => {
      const win = window()
      const options = { title: String(title).slice(0, 200), properties: ['openFile' as const, 'showHiddenFiles' as const] }
      const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return canceled ? null : (filePaths[0] ?? null)
    }
  }

  for (const [method, handler] of Object.entries(handlers) as [ApiChannel, (...args: unknown[]) => Promise<unknown>][]) {
    ipcMain.handle(channelName(method), async (event, ...args): Promise<IpcEnvelope<unknown>> => {
      // Solo aceptamos llamadas de nuestra propia ventana.
      if (event.sender !== window()?.webContents) return { ok: false, error: 'Origen IPC no permitido' }
      try {
        return { ok: true, value: await handler(...args) }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    })
  }
}
