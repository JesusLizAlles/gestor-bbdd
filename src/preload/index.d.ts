import type { DbApi } from '../shared/types'

declare global {
  interface Window {
    api: DbApi
  }
}

export {}
