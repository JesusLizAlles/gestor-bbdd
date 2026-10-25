import type { CellValue } from '@shared/types'

const MAX_BINARY_PREVIEW = 64

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** Fecha en hora local, sin zona: así es como la guarda DATETIME y la muestra cualquier cliente. */
export function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return 'Fecha inválida'
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const ms = d.getMilliseconds()
  return ms ? `${base}.${pad(ms, 3)}` : base
}

/** Convierte cualquier valor de los drivers en algo que viaja por IPC y se pinta tal cual. */
export function normalizeValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'bigint':
      return value.toString()
  }
  if (value instanceof Date) return formatDate(value)
  if (value instanceof Uint8Array) {
    const hex = Buffer.from(value.subarray(0, MAX_BINARY_PREVIEW)).toString('hex').toUpperCase()
    return value.length > MAX_BINARY_PREVIEW ? `0x${hex}… (${value.length} bytes)` : `0x${hex}`
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
