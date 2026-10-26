// Exportar e importar conexiones entre equipos. Las contraseñas guardadas van cifradas con el
// llavero de cada sistema, así que no se pueden copiar tal cual: si se incluyen, se cifran con
// una clave que elige el usuario (scrypt + AES-256-GCM) y hay que darla al importar.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { z } from 'zod'
import type { ConnectionConfig, ImportResult, SecretKey } from '@shared/types'
import type { ConnectionStore } from './store/connections'
import type { SecretVault } from './store/secrets'
import { connectionConfigSchema, identifierSchema } from './validation'

export const CONFIG_FORMAT = 'gestor-bbdd-config'
export const MIN_PASSPHRASE = 8

type Secrets = Partial<Record<SecretKey, string>>

const KDF = { N: 2 ** 15, r: 8, p: 1 } as const

const b64 = z.string().max(10_000_000)
const encryptedSchema = z.object({
  kdf: z.literal('scrypt'),
  N: z.number().int().min(2 ** 14).max(2 ** 20),
  r: z.number().int().min(1).max(32),
  p: z.number().int().min(1).max(16),
  salt: b64,
  iv: b64,
  tag: b64,
  data: b64
})

const connectionSchema = connectionConfigSchema.and(
  z.object({ id: z.string().uuid(), visibleDatabases: z.array(identifierSchema).max(10_000).optional() })
)

const fileSchema = z.object({
  format: z.literal(CONFIG_FORMAT),
  version: z.literal(1),
  exportedAt: z.string().max(64),
  appVersion: z.string().max(64),
  connections: z.array(connectionSchema).max(1000),
  secrets: encryptedSchema.nullable()
})

export type ConfigFile = Omit<z.infer<typeof fileSchema>, 'connections'> & { connections: ConnectionConfig[] }

const secretValue = z.string().max(4096).optional()
const secretsSchema = z.record(
  z.string().uuid(),
  z.object({ password: secretValue, sshPassword: secretValue, sshPassphrase: secretValue })
)

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    // maxmem: scrypt con N = 2^15 necesita 32 MiB, justo el límite por defecto.
    scrypt(passphrase, salt, 32, { ...params, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)))
  )
}

/** Fichero de exportación; `secrets` (por id de conexión) solo se incluye con clave. */
export async function buildConfigFile(
  connections: ConnectionConfig[],
  secrets: Record<string, Secrets> | null,
  passphrase: string | null,
  appVersion: string
): Promise<ConfigFile> {
  let encrypted: ConfigFile['secrets'] = null
  if (secrets && passphrase !== null) {
    if (passphrase.length < MIN_PASSPHRASE) throw new Error(`La clave debe tener al menos ${MIN_PASSPHRASE} caracteres`)
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt, KDF), iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()])
    encrypted = {
      kdf: 'scrypt',
      ...KDF,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64')
    }
  }
  return {
    format: CONFIG_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion,
    connections,
    secrets: encrypted
  }
}

/** Lee y valida un fichero exportado; los errores se explican para el usuario. */
export function parseConfigFile(text: string): ConfigFile {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('El fichero no es un JSON válido')
  }
  if ((json as { format?: unknown } | null)?.format !== CONFIG_FORMAT) {
    throw new Error('El fichero no es una exportación de Gestor BBDD')
  }
  const parsed = fileSchema.safeParse(json)
  if (!parsed.success) throw new Error('La exportación está incompleta o dañada')
  return parsed.data
}

/** Contraseñas del fichero; la clave equivocada (o un fichero alterado) da un error claro. */
export async function decryptSecrets(file: ConfigFile, passphrase: string): Promise<Record<string, Secrets>> {
  const enc = file.secrets
  if (!enc) return {}
  try {
    const key = await deriveKey(passphrase, Buffer.from(enc.salt, 'base64'), enc)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(enc.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]).toString('utf8')
    return secretsSchema.parse(JSON.parse(plain))
  } catch {
    throw new Error('Clave incorrecta: no se han podido descifrar las contraseñas')
  }
}

/** Fichero con las conexiones elegidas, en el orden en que están guardadas. */
export async function exportConnections(
  store: ConnectionStore,
  vault: SecretVault,
  ids: string[],
  passphrase: string | null,
  appVersion: string
): Promise<ConfigFile> {
  const wanted = new Set(ids)
  const connections = (await store.list())
    .filter((c) => wanted.has(c.id))
    .map(({ storedSecrets: _stored, ...config }) => config)
  if (connections.length === 0) throw new Error('No hay conexiones que exportar')
  const secrets =
    passphrase === null ? null : Object.fromEntries(await Promise.all(connections.map(async (c) => [c.id, await vault.get(c.id)] as const)))
  return buildConfigFile(connections, secrets, passphrase, appVersion)
}

/**
 * Importa las conexiones elegidas. Con el mismo id que una existente, la sustituye (reimportar no
 * duplica); sin contraseñas en el fichero, conserva las que ya tuviera guardadas.
 */
export async function importConnections(
  store: ConnectionStore,
  file: ConfigFile,
  ids: string[],
  secrets: Record<string, Secrets>
): Promise<ImportResult> {
  const wanted = new Set(ids)
  const existing = new Set((await store.list()).map((c) => c.id))
  const result: ImportResult = { added: 0, updated: 0, withPasswords: Object.keys(secrets).length > 0 }
  for (const { visibleDatabases, ...config } of file.connections.filter((c) => wanted.has(c.id))) {
    await store.save({ config, secrets: secrets[config.id] })
    if (visibleDatabases) await store.setVisibleDatabases(config.id, visibleDatabases)
    if (existing.has(config.id)) result.updated++
    else result.added++
  }
  return result
}
