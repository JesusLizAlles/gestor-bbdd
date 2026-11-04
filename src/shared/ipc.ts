import type { DbApi } from './types'

/** Un canal IPC por método de la API; el nombre del canal es el del método. Los eventos van aparte. */
export type ApiChannel = Exclude<keyof DbApi, 'onUpdateState' | 'onMcpState' | 'onMcpApproval'>

/** Evento del proceso principal al renderer con cada cambio del actualizador. */
export const UPDATE_STATE_EVENT = 'updater:state'
/** Cambios del servidor MCP (arranque, actividad del agente). */
export const MCP_STATE_EVENT = 'mcp:state'
/** Un agente quiere escribir en una conexión con acceso «con confirmación». */
export const MCP_APPROVAL_EVENT = 'mcp:approval'

export const API_CHANNELS = [
  'secretStorageStatus',
  'listConnections',
  'saveConnection',
  'deleteConnection',
  'setVisibleDatabases',
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
  'saveRowChanges',
  'alterTable',
  'runQuery',
  'queryHistory',
  'filterHistory',
  'clearHistory',
  'cancelQuery',
  'updaterState',
  'checkForUpdates',
  'downloadUpdate',
  'installUpdate',
  'loadConsole',
  'saveConsole',
  'exportConfig',
  'previewImport',
  'importConfig',
  'exportFile',
  'pickFile',
  'mcpState',
  'mcpSaveSettings',
  'mcpRegenerateToken',
  'mcpCreateExtension',
  'mcpOpenExtension',
  'mcpRespondApproval'
] as const satisfies readonly ApiChannel[]

/** Respuesta envuelta: así el mensaje de error llega limpio al renderer. */
export type IpcEnvelope<T> = { ok: true; value: T } | { ok: false; error: string }

export const channelName = (method: ApiChannel): string => `api:${method}`
