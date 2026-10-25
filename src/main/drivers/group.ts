/** Agrupa filas consecutivas por clave conservando el orden (las consultas ya vienen ordenadas). */
export function groupBy<T>(rows: T[], key: (row: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    const list = groups.get(k)
    if (list) list.push(row)
    else groups.set(k, [row])
  }
  return [...groups.entries()]
}
