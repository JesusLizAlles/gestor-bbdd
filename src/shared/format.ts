// Formateo de resultados para exportar y nombres cualificados por motor. Sin dependencias.
import type { CellValue, Engine, QueryResult, TableInfo } from './types'

export function quoteIdent(name: string, engine: Engine): string {
  return engine === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `[${name.replace(/]/g, ']]')}]`
}

export function qualifiedName(engine: Engine, database: string, table: Pick<TableInfo, 'schema' | 'name'>): string {
  const parts = engine === 'mysql' ? [database, table.name] : [database, table.schema ?? 'dbo', table.name]
  return parts.map((p) => quoteIdent(p, engine)).join('.')
}

function csvCell(value: CellValue, separator: string): string {
  if (value === null) return ''
  const text = String(value)
  return /["\r\n]/.test(text) || text.includes(separator) ? `"${text.replace(/"/g, '""')}"` : text
}

/** CSV RFC 4180. Con `excel`, separador `;` y BOM UTF-8 para que Excel en español lo abra bien. */
export function toCsv(result: QueryResult, { excel = false } = {}): string {
  const sep = excel ? ';' : ','
  const lines = [result.columns.map((c) => csvCell(c.name, sep)).join(sep)]
  for (const row of result.rows) lines.push(row.map((v) => csvCell(v, sep)).join(sep))
  return (excel ? '﻿' : '') + lines.join('\r\n') + '\r\n'
}

export function toJson(result: QueryResult): string {
  const objects = result.rows.map((row) => {
    const obj: Record<string, CellValue> = {}
    result.columns.forEach((c, i) => {
      // Columnas repetidas (SELECT a, a): la segunda se guarda como a_2 para no perder datos.
      let key = c.name
      for (let n = 2; key in obj; n++) key = `${c.name}_${n}`
      obj[key] = row[i] ?? null
    })
    return obj
  })
  return JSON.stringify(objects, null, 2)
}

/** Literal SQL seguro para un valor ya normalizado. */
export function sqlLiteral(value: CellValue, engine: Engine): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  let escaped = value.replace(/'/g, "''")
  if (engine === 'mysql') escaped = escaped.replace(/\\/g, '\\\\')
  return engine === 'mssql' ? `N'${escaped}'` : `'${escaped}'`
}

/** Intenta adivinar la tabla de origen de un SELECT sencillo para las sentencias INSERT. */
export function guessTableName(statement: string): string | null {
  const match = /\bFROM\s+((?:[`"[][^`"\]]+[`"\]]|[\w$#]+)(?:\s*\.\s*(?:[`"[][^`"\]]+[`"\]]|[\w$#]+)){0,2})/i.exec(statement)
  return match ? match[1]!.replace(/\s+/g, '') : null
}

export function toSqlInserts(result: QueryResult, engine: Engine, table?: string): string {
  const target = table ?? guessTableName(result.statement) ?? quoteIdent('tabla', engine)
  const columns = result.columns.map((c) => quoteIdent(c.name, engine)).join(', ')
  return (
    result.rows
      .map((row) => `INSERT INTO ${target} (${columns}) VALUES (${row.map((v) => sqlLiteral(v, engine)).join(', ')});`)
      .join('\n') + '\n'
  )
}
