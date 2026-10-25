import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
}

// Las escrituras al mismo fichero se encadenan para que dos IPC simultáneos no se pisen el temporal.
const pending = new Map<string, Promise<void>>()

/** Escritura atómica (fichero temporal + rename) con permisos 0600. */
export function writeJson(path: string, data: unknown): Promise<void> {
  const body = JSON.stringify(data, null, 2)
  const run = async (): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
  }
  const next = (pending.get(path) ?? Promise.resolve()).then(run, run)
  pending.set(path, next)
  return next
}
