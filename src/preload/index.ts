import { contextBridge, ipcRenderer } from 'electron'
import { API_CHANNELS, channelName, UPDATE_STATE_EVENT, type IpcEnvelope } from '@shared/ipc'
import type { DbApi, UpdateState } from '@shared/types'

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
  onUpdateState(listener: (state: UpdateState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) => listener(state)
    ipcRenderer.on(UPDATE_STATE_EVENT, handler)
    return () => ipcRenderer.removeListener(UPDATE_STATE_EVENT, handler)
  }
} as unknown as DbApi

contextBridge.exposeInMainWorld('api', api)
