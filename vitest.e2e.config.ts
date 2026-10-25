import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
    // Un solo proceso: los pasos comparten la misma ventana de Electron.
    fileParallelism: false
  }
})
