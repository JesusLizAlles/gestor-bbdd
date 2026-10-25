// Esquemas zod para todo lo que entra por IPC: el renderer no es de confianza.
import { z } from 'zod'

const nonEmpty = z.string().trim().min(1).max(255)
const port = z.number().int().min(1).max(65535)
const optionalText = z
  .string()
  .trim()
  .max(1024)
  .optional()
  .transform((v) => (v ? v : undefined))

export const connectionConfigSchema = z.object({
  id: z.string().uuid().optional(),
  name: nonEmpty,
  engine: z.enum(['mysql', 'mssql']),
  host: nonEmpty,
  port,
  username: z.string().max(255),
  database: optionalText,
  instanceName: optionalText,
  environment: z.enum(['dev', 'test', 'prod']),
  readOnly: z.boolean(),
  tls: z.object({
    enabled: z.boolean(),
    verifyServerCert: z.boolean(),
    caPath: optionalText
  }),
  ssh: z.object({
    enabled: z.boolean(),
    host: z.string().trim().max(255),
    port,
    username: z.string().trim().max(255),
    authMethod: z.enum(['password', 'privateKey', 'agent']),
    privateKeyPath: optionalText
  })
}).superRefine((c, ctx) => {
  if (c.ssh.enabled && (!c.ssh.host || !c.ssh.username)) {
    ctx.addIssue({ code: 'custom', path: ['ssh'], message: 'El túnel SSH necesita servidor y usuario' })
  }
  if (c.ssh.enabled && c.ssh.authMethod === 'privateKey' && !c.ssh.privateKeyPath) {
    ctx.addIssue({ code: 'custom', path: ['ssh', 'privateKeyPath'], message: 'Indica la ruta de la clave privada' })
  }
})

const secretValue = z.string().max(4096).nullable().optional()

export const saveConnectionSchema = z.object({
  config: connectionConfigSchema,
  secrets: z
    .object({ password: secretValue, sshPassword: secretValue, sshPassphrase: secretValue })
    .optional()
})

export const idSchema = z.string().min(1).max(100)
export const identifierSchema = z.string().min(1).max(256)

export const runQuerySchema = z.object({
  sql: z.string().max(5_000_000),
  database: z.string().max(256).nullable().optional(),
  maxRows: z.number().int().min(1).max(100_000).optional(),
  confirmedWrite: z.boolean().optional()
})

const tableRef = {
  database: identifierSchema,
  schema: identifierSchema.nullable(),
  table: identifierSchema
}

export const tableRefSchema = z.object(tableRef)

export const countSchema = z.object({ ...tableRef, where: z.string().max(10_000).optional() })

export const tableDataSchema = z.object({
  ...tableRef,
  offset: z.number().int().min(0).max(1_000_000_000),
  limit: z.number().int().min(1).max(10_000),
  sort: z.array(z.object({ column: identifierSchema, direction: z.enum(['asc', 'desc']) })).max(16),
  where: z.string().max(10_000).optional()
})

const cellValue = z.union([z.string().max(16_000_000), z.number(), z.boolean(), z.null()])
const cellChange = z.object({ column: identifierSchema, value: cellValue })

export const updateRowsSchema = z.object({
  ...tableRef,
  updates: z.array(z.object({ key: z.array(cellChange).min(1).max(32), set: z.array(cellChange).min(1).max(1000) })).max(10_000),
  confirmedWrite: z.boolean().optional()
})

export const exportSchema = z.object({
  defaultName: z.string().min(1).max(200),
  format: z.enum(['csv', 'json', 'sql']),
  content: z.string().max(200_000_000)
})
