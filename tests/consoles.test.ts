import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConsoleState } from '@shared/types'
import { ConsoleStore } from '../src/main/store/consoles'

const state = (text: string, database: string | null = 'hotel'): ConsoleState => ({
  text,
  database,
  selection: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 9 },
  scrollTop: 40
})

describe('ConsoleStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-bbdd-consolas-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('una consola por conexión y base de datos, que se recupera tal cual tras reiniciar', async () => {
    const store = new ConsoleStore(dir)
    await store.save('c1', 'hotel', state('SELECT 1;\nSELECT 2;'))
    await store.save('c1', null, state('SHOW DATABASES;', null))
    await store.save('c2', 'hotel', state('SELECT 3;'))

    const reopened = new ConsoleStore(dir)
    expect(await reopened.get('c1', 'hotel')).toEqual(state('SELECT 1;\nSELECT 2;'))
    expect(await reopened.get('c1', null)).toEqual(state('SHOW DATABASES;', null))
    expect(await reopened.get('c2', 'hotel')).toEqual(state('SELECT 3;'))
    expect(await reopened.get('c1', 'otra')).toBeNull()
    expect((await stat(join(dir, 'consoles.json'))).mode & 0o777).toBe(0o600)
  })

  it('vaciar una consola la borra del fichero', async () => {
    const store = new ConsoleStore(dir)
    await store.save('c1', 'hotel', state('SELECT 1;'))
    await store.save('c1', 'hotel', state('  \n'))
    expect(await new ConsoleStore(dir).get('c1', 'hotel')).toBeNull()
  })

  it('borrar la conexión borra sus consolas y no las de otras', async () => {
    const store = new ConsoleStore(dir)
    await store.save('c1', 'hotel', state('SELECT 1;'))
    await store.save('c1', null, state('SELECT 2;', null))
    await store.save('c10', 'hotel', state('SELECT 3;'))
    await store.deleteConnection('c1')
    const reopened = new ConsoleStore(dir)
    expect(await reopened.get('c1', 'hotel')).toBeNull()
    expect(await reopened.get('c1', null)).toBeNull()
    expect(await reopened.get('c10', 'hotel')).not.toBeNull()
  })

  it('al salir escribe en síncrono lo que aún no se había guardado', async () => {
    const store = new ConsoleStore(dir)
    await store.save('c1', 'hotel', state('SELECT 1;'))
    // Simula salir con la escritura en vuelo: no se espera a la promesa.
    void store.save('c1', 'hotel', state('SELECT 1;\nSELECT 2;'))
    await Promise.resolve()
    store.flushSync()
    const file = JSON.parse(await readFile(join(dir, 'consoles.json'), 'utf8'))
    expect(file.consoles['c1\u0000hotel'].text).toBe('SELECT 1;\nSELECT 2;')
  })
})
