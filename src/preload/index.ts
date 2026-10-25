import { contextBridge, ipcRenderer } from 'electron'
import { API_CHANNELS, channelName, type IpcEnvelope } from '@shared/ipc'
import type { DbApi } from '@shared/types'

const api = Object.fromEntries(
  API_CHANNELS.map((method) => [
    method,
    async (...args: unknown[]) => {
      const reply = (await ipcRenderer.invoke(channelName(method), ...args)) as IpcEnvelope<unknown>
      if (!reply.ok) throw new Error(reply.error)
      return reply.value
    }
  ])
) as unknown as DbApi

contextBridge.exposeInMainWorld('api', api)
