import type { DbApi } from './types'

/** Un canal IPC por método de la API; el nombre del canal es el del método. */
export type ApiChannel = keyof DbApi

export const API_CHANNELS = [
  'secretStorageStatus',
  'listConnections',
  'saveConnection',
  'deleteConnection',
  'testConnection',
  'openSession',
  'closeSession',
  'listDatabases',
  'listTables',
  'listColumns',
  'completionColumns',
  'fetchTableData',
  'countTableRows',
  'tableStructure',
  'updateRows',
  'runQuery',
  'cancelQuery',
  'exportFile',
  'pickFile'
] as const satisfies readonly ApiChannel[]

/** Respuesta envuelta: así el mensaje de error llega limpio al renderer. */
export type IpcEnvelope<T> = { ok: true; value: T } | { ok: false; error: string }

export const channelName = (method: ApiChannel): string => `api:${method}`
