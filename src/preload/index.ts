import { contextBridge, ipcRenderer } from 'electron'
import { API_CHANNELS, channelName, MCP_APPROVAL_EVENT, MCP_STATE_EVENT, UPDATE_STATE_EVENT, type IpcEnvelope } from '@shared/ipc'
import type { DbApi, McpApprovalRequest, McpState, UpdateState } from '@shared/types'

/** Suscripción a un evento del proceso principal; devuelve la función para darse de baja. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  ...Object.fromEntries(
    API_CHANNELS.map((method) => [
      method,
      async (...args: unknown[]) => {
        const reply = (await ipcRenderer.invoke(channelName(method), ...args)) as IpcEnvelope<unknown>
        if (!reply.ok) throw new Error(reply.error)
        return reply.value
      }
    ])
  ),
  onUpdateState: (listener: (state: UpdateState) => void) => subscribe(UPDATE_STATE_EVENT, listener),
  onMcpState: (listener: (state: McpState) => void) => subscribe(MCP_STATE_EVENT, listener),
  onMcpApproval: (listener: (request: McpApprovalRequest) => void) => subscribe(MCP_APPROVAL_EVENT, listener)
} as unknown as DbApi

contextBridge.exposeInMainWorld('api', api)
