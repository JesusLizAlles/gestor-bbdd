import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { ConnectionConfig, McpAccess, McpSettings } from '@shared/types'
import { DEFAULT_MCP_MAX_ROWS, DEFAULT_MCP_PORT } from '@shared/types'
import { readJson, writeJson } from '../store/fs-utils'

export const MAX_MCP_ROWS = 5000

const accessSchema = z.enum(['off', 'read', 'confirm', 'write'])

export const mcpSettingsSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535),
  maxRows: z.number().int().min(1).max(MAX_MCP_ROWS),
  access: z.record(z.string().min(1).max(100), accessSchema)
})

/**
 * Lo que se guarda en mcp.json (0600). El token va en claro a propósito: el puente de Claude
 * Desktop lo lee de aquí, así que regenerarlo o cambiar el puerto no obliga a reinstalar nada.
 */
export interface McpFile extends McpSettings {
  version: 1
  token: string
}

export const newToken = (): string => randomBytes(32).toString('base64url')

const defaults = (): McpFile => ({
  version: 1,
  enabled: false,
  port: DEFAULT_MCP_PORT,
  maxRows: DEFAULT_MCP_MAX_ROWS,
  access: {},
  token: newToken()
})

/**
 * Nivel efectivo: una conexión de solo lectura no pasa de 'read' y en producción nunca se escribe
 * sin que el usuario lo apruebe, diga lo que diga el fichero.
 */
export function effectiveAccess(config: Pick<ConnectionConfig, 'readOnly' | 'environment'>, wanted: McpAccess | undefined): McpAccess {
  const access = wanted ?? 'off'
  if (access === 'off' || access === 'read') return access
  if (config.readOnly) return 'read'
  if (config.environment === 'prod' && access === 'write') return 'confirm'
  return access
}

export class McpSettingsStore {
  readonly path: string
  private file: Promise<McpFile> | null = null

  constructor(dir: string) {
    this.path = join(dir, 'mcp.json')
  }

  async get(): Promise<McpFile> {
    this.file ??= this.read()
    return this.file
  }

  async save(settings: McpSettings): Promise<McpFile> {
    const parsed = mcpSettingsSchema.parse(settings)
    // Lo que está en 'off' no hace falta guardarlo.
    const access = Object.fromEntries(Object.entries(parsed.access).filter(([, level]) => level !== 'off'))
    return this.write({ ...(await this.get()), ...parsed, access })
  }

  async regenerateToken(): Promise<McpFile> {
    return this.write({ ...(await this.get()), token: newToken() })
  }

  /** Al borrar una conexión se olvida su permiso: otra con el mismo id no lo heredaría. */
  async forgetConnection(id: string): Promise<void> {
    const file = await this.get()
    if (!(id in file.access)) return
    const access = { ...file.access }
    delete access[id]
    await this.write({ ...file, access })
  }

  private async write(file: McpFile): Promise<McpFile> {
    await writeJson(this.path, file)
    this.file = Promise.resolve(file)
    return file
  }

  private async read(): Promise<McpFile> {
    const raw = await readJson<Partial<McpFile>>(this.path, {})
    const base = defaults()
    const parsed = mcpSettingsSchema.partial().safeParse(raw)
    const merged: McpFile = {
      ...base,
      ...(parsed.success ? parsed.data : {}),
      token: typeof raw.token === 'string' && raw.token.length >= 32 ? raw.token : base.token
    }
    // Sin fichero (o con un token inválido) se guarda ya: el puente necesita leerlo.
    if (merged.token !== raw.token) await writeJson(this.path, merged)
    return merged
  }
}
