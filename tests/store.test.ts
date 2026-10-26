import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConnectionStore } from '../src/main/store/connections'
import { SecretVault, type SecretCipher } from '../src/main/store/secrets'
import { KnownHosts } from '../src/main/ssh/known-hosts'
import { baseConfig } from './helpers'

/** Cifrado de pega: invierte y codifica, suficiente para comprobar que nada se guarda en claro. */
const fakeCipher = (persistent: boolean, { rotate = false } = {}): SecretCipher => ({
  status: async () => ({ persistent, backend: persistent ? 'fake' : 'basic_text' }),
  encrypt: async (plain) => Buffer.from(`enc2:${[...plain].reverse().join('')}`),
  decrypt: async (data) => {
    const text = data.toString()
    const [version, payload = ''] = text.split(/:(.*)/s)
    // Simula una rotación de clave: lo cifrado con la versión antigua pide re-cifrar.
    return { value: [...payload].reverse().join(''), reencrypt: rotate && version !== 'enc2' }
  }
})

const input = (overrides = {}) => {
  const { id: _id, ...config } = baseConfig({ name: 'Intranet', host: 'db.local', username: 'app', ...overrides })
  return config
}

describe('ConnectionStore + SecretVault', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-bbdd-store-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('guarda la conexión sin la contraseña y la contraseña cifrada aparte', async () => {
    const vault = new SecretVault(dir, fakeCipher(true))
    const store = new ConnectionStore(dir, vault)
    const saved = await store.save({ config: input(), secrets: { password: 'super-secreta' } })

    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(saved.storedSecrets).toEqual(['password'])
    const connectionsFile = await readFile(join(dir, 'connections.json'), 'utf8')
    const secretsFile = await readFile(join(dir, 'secrets.json'), 'utf8')
    expect(connectionsFile).not.toContain('super-secreta')
    expect(secretsFile).not.toContain('super-secreta')
    expect((await stat(join(dir, 'secrets.json'))).mode & 0o777).toBe(0o600)

    // Una instancia nueva (como al reiniciar la app) lee y descifra lo guardado.
    const reopened = new SecretVault(dir, fakeCipher(true))
    expect(await reopened.get(saved.id)).toEqual({ password: 'super-secreta' })
    expect((await new ConnectionStore(dir, reopened).list())[0]).toMatchObject({ name: 'Intranet', host: 'db.local' })
  })

  it('bases de datos visibles: se guardan aparte y editar la conexión no las pierde', async () => {
    const store = new ConnectionStore(dir, new SecretVault(dir, fakeCipher(true)))
    const { id } = await store.save({ config: input() })
    expect((await store.setVisibleDatabases(id, ['intranet', 'rrhh', 'intranet'])).visibleDatabases).toEqual(['intranet', 'rrhh'])

    // El formulario no envía la selección (y zod la descartaría): se conserva.
    await store.save({ config: { ...input({ name: 'Renombrada' }), id } })
    const reopened = new ConnectionStore(dir, new SecretVault(dir, fakeCipher(true)))
    expect((await reopened.get(id)).visibleDatabases).toEqual(['intranet', 'rrhh'])

    expect((await reopened.setVisibleDatabases(id, null)).visibleDatabases).toBeUndefined()
    await expect(reopened.setVisibleDatabases('no-existe', [])).rejects.toThrow('no existe')
  })

  it('undefined conserva, null borra y string reemplaza secretos', async () => {
    const vault = new SecretVault(dir, fakeCipher(true))
    const store = new ConnectionStore(dir, vault)
    const { id } = await store.save({ config: input(), secrets: { password: 'a', sshPassword: 'b' } })

    await store.save({ config: { ...input({ name: 'Renombrada' }), id } })
    expect(await vault.get(id)).toEqual({ password: 'a', sshPassword: 'b' })

    await store.save({ config: { ...input(), id }, secrets: { password: null, sshPassword: 'c' } })
    expect(await vault.get(id)).toEqual({ sshPassword: 'c' })
    expect(await store.list()).toHaveLength(1)
  })

  it('sin llavero seguro, los secretos solo viven en memoria', async () => {
    const vault = new SecretVault(dir, fakeCipher(false))
    const store = new ConnectionStore(dir, vault)
    const { id } = await store.save({ config: input(), secrets: { password: 'temporal' } })
    expect(await vault.get(id)).toEqual({ password: 'temporal' })
    await expect(stat(join(dir, 'secrets.json'))).rejects.toThrow()
    expect(await new SecretVault(dir, fakeCipher(false)).get(id)).toEqual({})
  })

  it('borrar una conexión borra también sus secretos', async () => {
    const vault = new SecretVault(dir, fakeCipher(true))
    const store = new ConnectionStore(dir, vault)
    const { id } = await store.save({ config: input(), secrets: { password: 'x' } })
    await store.delete(id)
    expect(await store.list()).toEqual([])
    expect(await vault.get(id)).toEqual({})
  })

  it('re-cifra al leer si el sistema rotó la clave', async () => {
    const { writeFile } = await import('node:fs/promises')
    const old = Buffer.from(`enc1:${[...'antigua'].reverse().join('')}`).toString('base64')
    await writeFile(join(dir, 'secrets.json'), JSON.stringify({ version: 1, entries: { c1: { password: old } } }))
    const vault = new SecretVault(dir, fakeCipher(true, { rotate: true }))
    expect(await vault.get('c1')).toEqual({ password: 'antigua' })
    const rewritten = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'))
    expect(Buffer.from(rewritten.entries.c1.password, 'base64').toString()).toMatch(/^enc2:/)
  })

  it('valida la configuración antes de guardar', async () => {
    const store = new ConnectionStore(dir, new SecretVault(dir, fakeCipher(true)))
    await expect(store.save({ config: input({ port: 70000 }) })).rejects.toThrow()
    await expect(
      store.save({ config: input({ ssh: { enabled: true, host: '', port: 22, username: '', authMethod: 'password' } }) })
    ).rejects.toThrow(/SSH/)
  })

  it('guardados simultáneos no se pisan', async () => {
    const store = new ConnectionStore(dir, new SecretVault(dir, fakeCipher(true)))
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.save({ config: input({ name: `c${i}` }), secrets: { password: `p${i}` } })))
    const fromDisk = await new ConnectionStore(dir, new SecretVault(dir, fakeCipher(true))).list()
    expect(fromDisk).toHaveLength(10)
  })
})

describe('KnownHosts', () => {
  it('nuevo → recordado → cambiado', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gestor-bbdd-kh-'))
    try {
      const hosts = new KnownHosts(dir)
      expect(await hosts.check('bastion', 22, 'SHA256:aaa')).toBe('new')
      await hosts.remember('bastion', 22, 'SHA256:aaa')
      const reopened = new KnownHosts(dir)
      expect(await reopened.check('bastion', 22, 'SHA256:aaa')).toBe('trusted')
      expect(await reopened.check('bastion', 22, 'SHA256:bbb')).toBe('changed')
      expect(await reopened.check('bastion', 2222, 'SHA256:bbb')).toBe('new')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
