import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decryptSecrets, exportConnections, importConnections, parseConfigFile } from '../src/main/config-transfer'
import { ConnectionStore } from '../src/main/store/connections'
import { SecretVault, type SecretCipher } from '../src/main/store/secrets'
import { baseConfig } from './helpers'

/** Cada «equipo» cifra con su propio llavero: lo de uno no se descifra en el otro. */
const machineCipher = (machine: string): SecretCipher => ({
  status: async () => ({ persistent: true, backend: machine }),
  encrypt: async (plain) => Buffer.from(`${machine}:${Buffer.from(plain).toString('base64')}`),
  decrypt: async (data) => {
    const [owner, payload = ''] = data.toString().split(':')
    if (owner !== machine) throw new Error('otro llavero')
    return { value: Buffer.from(payload, 'base64').toString(), reencrypt: false }
  }
})

const input = (overrides = {}) => {
  const { id: _id, ...config } = baseConfig({ name: 'Intranet', host: 'db.local', username: 'app', ...overrides })
  return config
}

describe('Exportar e importar conexiones', () => {
  let dirs: string[]
  const machine = async (name: string) => {
    const dir = await mkdtemp(join(tmpdir(), `gestor-bbdd-${name}-`))
    dirs.push(dir)
    const vault = new SecretVault(dir, machineCipher(name))
    return { vault, store: new ConnectionStore(dir, vault) }
  }
  beforeEach(() => {
    dirs = []
  })
  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  })

  it('con clave: las conexiones, su selección de bases de datos y sus contraseñas pasan a otro equipo', async () => {
    const a = await machine('pc-a')
    const intranet = await a.store.save({ config: input(), secrets: { password: 'secreta', sshPassword: 'ssh' } })
    await a.store.setVisibleDatabases(intranet.id, ['intranet', 'rrhh'])
    const otra = await a.store.save({ config: input({ name: 'SAGE', engine: 'mssql' }), secrets: { password: 'sage' } })

    const file = await exportConnections(a.store, a.vault, [intranet.id], 'clave-del-equipo', '0.5.1')
    const text = JSON.stringify(file)
    expect(text).not.toContain('secreta')
    expect(text).not.toContain(otra.id)

    const b = await machine('pc-b')
    const parsed = parseConfigFile(text)
    const secrets = await decryptSecrets(parsed, 'clave-del-equipo')
    expect(await importConnections(b.store, parsed, [intranet.id], secrets)).toEqual({ added: 1, updated: 0, withPasswords: true })

    const [imported] = await b.store.list()
    expect(imported).toMatchObject({ id: intranet.id, name: 'Intranet', visibleDatabases: ['intranet', 'rrhh'] })
    expect(await b.vault.get(intranet.id)).toEqual({ password: 'secreta', sshPassword: 'ssh' })
  })

  it('sin clave no viajan contraseñas; reimportar actualiza sin duplicar y conserva las del destino', async () => {
    const a = await machine('pc-a')
    const c = await a.store.save({ config: input(), secrets: { password: 'secreta' } })
    const b = await machine('pc-b')

    const first = parseConfigFile(JSON.stringify(await exportConnections(a.store, a.vault, [c.id], null, '0.5.1')))
    expect(first.secrets).toBeNull()
    expect(await importConnections(b.store, first, [c.id], {})).toEqual({ added: 1, updated: 0, withPasswords: false })
    expect(await b.vault.get(c.id)).toEqual({})

    // En el destino se escribe la contraseña a mano; luego llega una exportación con otro nombre.
    await b.vault.apply(c.id, { password: 'la-de-b' })
    await a.store.save({ config: { ...input({ name: 'Intranet nueva' }), id: c.id } })
    const second = parseConfigFile(JSON.stringify(await exportConnections(a.store, a.vault, [c.id], null, '0.5.1')))
    expect(await importConnections(b.store, second, [c.id], {})).toEqual({ added: 0, updated: 1, withPasswords: false })
    expect(await b.store.list()).toHaveLength(1)
    expect((await b.store.list())[0]!.name).toBe('Intranet nueva')
    expect(await b.vault.get(c.id)).toEqual({ password: 'la-de-b' })
  })

  it('clave equivocada, clave corta y ficheros que no son una exportación', async () => {
    const a = await machine('pc-a')
    const c = await a.store.save({ config: input(), secrets: { password: 'secreta' } })
    const file = await exportConnections(a.store, a.vault, [c.id], 'clave-del-equipo', '0.5.1')

    await expect(decryptSecrets(file, 'otra-clave')).rejects.toThrow('Clave incorrecta')
    // Un fichero alterado tampoco se descifra (GCM autentica el contenido).
    const tampered = { ...file, secrets: { ...file.secrets!, data: Buffer.from('x'.repeat(40)).toString('base64') } }
    await expect(decryptSecrets(tampered, 'clave-del-equipo')).rejects.toThrow('Clave incorrecta')

    await expect(exportConnections(a.store, a.vault, [c.id], 'corta', '0.5.1')).rejects.toThrow('al menos 8')
    expect(() => parseConfigFile('no es json')).toThrow('JSON válido')
    expect(() => parseConfigFile(JSON.stringify({ hola: 1 }))).toThrow('no es una exportación')
    expect(() => parseConfigFile(JSON.stringify({ ...file, connections: [{ name: 'sin campos' }] }))).toThrow('dañada')
  })
})
