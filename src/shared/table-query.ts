// SQL que el visor de tablas genera por detrás. Puro y sin dependencias para poder probarlo aislado.
import { qualifiedName, quoteIdent, sqlLiteral } from './format'
import { isReadOnlyStatement, splitStatements } from './sql'
import type { CellValue, Engine, RowUpdate, SortSpec, TableRef } from './types'

/** `col1 = v1 AND col2 = v2`, con IS NULL para nulos. Lo usa la navegación por claves foráneas. */
export function equalsCondition(engine: Engine, columns: string[], values: CellValue[]): string {
  return columns
    .map((c, i) => {
      const v = values[i] ?? null
      return v === null ? `${quoteIdent(c, engine)} IS NULL` : `${quoteIdent(c, engine)} = ${sqlLiteral(v, engine)}`
    })
    .join(' AND ')
}

/**
 * Comprueba que el filtro del usuario es una única condición de lectura. Se evalúa dentro de
 * `WHERE (… \n)`: un `;`, un `GO` o una palabra de escritura lo invalidan, y un comentario `--`
 * no puede anular el ORDER BY ni el LIMIT porque el paréntesis va en otra línea.
 */
export function validateWhere(where: string | undefined, engine: Engine): string | null {
  const trimmed = where?.trim()
  if (!trimmed) return null
  const statements = splitStatements(`SELECT 1 FROM t WHERE (${trimmed}\n)`, engine)
  if (statements.length !== 1 || !isReadOnlyStatement(statements[0]!.words)) {
    throw new Error('El filtro debe ser una única condición de lectura, p. ej. estado = \'confirmada\'')
  }
  return trimmed
}

const whereClause = (where: string | null): string => (where ? ` WHERE (${where}\n)` : '')

function orderClause(engine: Engine, sort: SortSpec[], fallback: string[]): string {
  const parts = sort.length
    ? sort.map((s) => `${quoteIdent(s.column, engine)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`)
    : fallback.map((c) => quoteIdent(c, engine))
  if (parts.length) return ` ORDER BY ${parts.join(', ')}`
  // SQL Server exige ORDER BY para paginar con OFFSET/FETCH.
  return engine === 'mssql' ? ' ORDER BY (SELECT NULL)' : ''
}

export interface PageQueryOptions {
  where: string | null
  sort: SortSpec[]
  /** Orden por defecto (la clave primaria) para que las páginas sean estables. */
  fallbackOrder: string[]
  offset: number
  limit: number
}

/** Pide `limit + 1` filas: la de más solo sirve para saber si hay otra página. */
export function buildPageQuery(engine: Engine, ref: TableRef, o: PageQueryOptions): string {
  const from = qualifiedName(engine, ref.database, { schema: ref.schema, name: ref.table })
  const offset = Math.max(0, Math.trunc(o.offset))
  const fetch = Math.max(1, Math.trunc(o.limit)) + 1
  const base = `SELECT * FROM ${from}${whereClause(o.where)}${orderClause(engine, o.sort, o.fallbackOrder)}`
  return engine === 'mysql' ? `${base} LIMIT ${fetch} OFFSET ${offset}` : `${base} OFFSET ${offset} ROWS FETCH NEXT ${fetch} ROWS ONLY`
}

export function buildCountQuery(engine: Engine, ref: TableRef, where: string | null): string {
  const from = qualifiedName(engine, ref.database, { schema: ref.schema, name: ref.table })
  return `SELECT COUNT(*) AS total FROM ${from}${whereClause(where)}`
}

/** Sentencia con parámetros: `?` en MySQL, `@p0, @p1…` en SQL Server. */
export interface ParamStatement {
  sql: string
  params: CellValue[]
  /** Cómo nombrar la fila en los mensajes de error, p. ej. `id = 99`. */
  label?: string
}

/**
 * UPDATE de una fila localizada por su clave primaria, con valores como parámetros.
 * `paramStart` numera los parámetros de SQL Server cuando varias sentencias van en el mismo lote.
 */
export function buildUpdate(engine: Engine, ref: TableRef, update: RowUpdate, paramStart = 0): ParamStatement {
  const from = qualifiedName(engine, ref.database, { schema: ref.schema, name: ref.table })
  const params: CellValue[] = []
  const placeholder = (value: CellValue): string => {
    params.push(value)
    return engine === 'mysql' ? '?' : `@p${paramStart + params.length - 1}`
  }
  const set = update.set.map((c) => `${quoteIdent(c.column, engine)} = ${placeholder(c.value)}`).join(', ')
  const where = update.key.map((c) => `${quoteIdent(c.column, engine)} = ${placeholder(c.value)}`).join(' AND ')
  const label = update.key.map((k) => `${k.column} = ${k.value === null ? 'NULL' : String(k.value)}`).join(', ')
  return { sql: `UPDATE ${from} SET ${set} WHERE ${where}`, params, label }
}

/** La misma sentencia con los valores en línea, solo para mostrarla al pedir confirmación. */
export function previewUpdate(engine: Engine, ref: TableRef, update: RowUpdate): string {
  const from = qualifiedName(engine, ref.database, { schema: ref.schema, name: ref.table })
  const set = update.set.map((c) => `${quoteIdent(c.column, engine)} = ${sqlLiteral(c.value, engine)}`).join(', ')
  return `UPDATE ${from} SET ${set} WHERE ${equalsCondition(engine, update.key.map((k) => k.column), update.key.map((k) => k.value))}`
}

/**
 * SQL Server interpreta 'AAAA-MM-DD hh:mm:ss' según SET DATEFORMAT en columnas datetime (con dmy
 * intercambia día y mes). Con la 'T' de ISO 8601 la lectura es siempre la misma.
 */
export function mssqlDateParam(value: CellValue, dataType: string | undefined): CellValue {
  if (typeof value !== 'string' || !dataType || !/^(small)?datetime(2|offset)?\b/i.test(dataType)) return value
  return /^\d{4}-\d{2}-\d{2} \d/.test(value) ? value.replace(' ', 'T') : value
}
