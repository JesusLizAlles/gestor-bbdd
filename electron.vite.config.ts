import { fileURLToPath } from 'node:url'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url))
const shared = fromRoot('./src/shared')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      // El renderer corre con sandbox: true, y Electron solo admite preloads CommonJS en ese modo.
      rolldownOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: { alias: { '@shared': shared, '@renderer': fromRoot('./src/renderer/src') } },
    plugins: [react()]
  }
})
