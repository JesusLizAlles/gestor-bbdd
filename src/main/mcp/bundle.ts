// Extensión de Claude Desktop (.mcpb): un zip con manifest.json, el puente stdio ↔ HTTP y el icono.
// Se genera en la propia app para dejar dentro la carpeta de datos (de donde el puente lee puerto
// y token) y la lista de herramientas de esta versión.
import { crc32, deflateRawSync } from 'node:zlib'
import type { ToolDefinition } from './tools'

export interface ZipEntry {
  name: string
  data: Buffer
}

/** Zip mínimo (deflate, sin zip64): suficiente para unos pocos ficheros pequeños. */
export function createZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  // Fecha fija (1-1-2024 00:00) en formato DOS: el mismo contenido da el mismo fichero.
  const dosTime = 0
  const dosDate = ((2024 - 1980) << 9) | (1 << 5) | 1
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const compressed = deflateRawSync(entry.data, { level: 9 })
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // versión necesaria
    local.writeUInt16LE(0x0800, 6) // nombres en UTF-8
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // creado en Unix, versión 2.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38) // permisos rw-r--r--
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

export interface BundleOptions {
  version: string
  /** Carpeta de datos de la app (donde está mcp.json). */
  dataDir: string
  /** Código del puente con los marcadores sin rellenar. */
  bridgeSource: string
  tools: ToolDefinition[]
  icon: Buffer | null
}

export function buildManifest(opts: Pick<BundleOptions, 'version' | 'dataDir' | 'tools'> & { hasIcon: boolean }) {
  return {
    manifest_version: '0.3',
    name: 'gestor-bbdd',
    display_name: 'Gestor BBDD',
    version: opts.version,
    description: 'Consulta y analiza las bases de datos MySQL/MariaDB, SQL Server y PostgreSQL que tienes en Gestor BBDD.',
    long_description:
      'Conecta Claude con Gestor BBDD. Claude solo ve las conexiones a las que le des acceso en Gestor BBDD ' +
      '(Ajustes → Servidor MCP), con el nivel que elijas: solo lectura, escritura con tu aprobación o escritura ' +
      'sin confirmación (nunca en producción). Gestor BBDD tiene que estar abierto, con el servidor MCP activado. ' +
      'Las contraseñas no salen de Gestor BBDD.',
    author: { name: 'Jesús Liz Alles' },
    homepage: 'https://github.com/JesusLizAlles/gestor-bbdd',
    repository: { type: 'git', url: 'https://github.com/JesusLizAlles/gestor-bbdd.git' },
    ...(opts.hasIcon ? { icon: 'icon.png' } : {}),
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.js'],
        env: { GESTOR_BBDD_DATA_DIR: opts.dataDir }
      }
    },
    tools: opts.tools.map((t) => ({ name: t.name, description: t.description })),
    keywords: ['database', 'sql', 'mysql', 'mariadb', 'sqlserver', 'mssql', 'postgresql', 'postgres'],
    license: 'MIT',
    compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=18.0.0' } }
  }
}

/** Rellena los marcadores del puente con las herramientas y la versión. */
export function fillBridge(source: string, tools: ToolDefinition[], version: string): string {
  const filled = source
    .replace('/*@@TOOLS@@*/ []', () => JSON.stringify(tools))
    .replace("/*@@VERSION@@*/ '0.0.0'", () => JSON.stringify(version))
  if (filled.includes('/*@@')) throw new Error('El puente MCP no tiene los marcadores esperados')
  return filled
}

export function buildMcpb(opts: BundleOptions): Buffer {
  const manifest = buildManifest({ ...opts, hasIcon: opts.icon !== null })
  return createZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: 'server/index.js', data: Buffer.from(fillBridge(opts.bridgeSource, opts.tools, opts.version)) },
    ...(opts.icon ? [{ name: 'icon.png', data: opts.icon }] : [])
  ])
}
