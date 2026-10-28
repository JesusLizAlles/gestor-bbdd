// SQL que el visor de tablas genera por detrás. Puro y sin dependencias para poder probarlo aislado.
import { qualifiedName, quoteIdent, sqlLiteral } from './format'
import { isReadOnlyStatement, splitStatements } from './sql'
import type { CellChange, CellValue, Engine, RowUpdate, SortSpec, TableRef } from './types'

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

/**
 * SELECT de partida para la consola, con las columnas escritas una por línea (como «Select Top
 * 1000 Rows» de SSMS): así se ve qué campos tiene la tabla, también al copiarla a otro sitio.
 */
export function buildSelectColumns(engine: Engine, ref: TableRef, columns: string[], limit = 1000): string {
  const from = qualifiedName(engine, ref.database, { schema: ref.schema, name: ref.table })
  const list = columns.length ? columns.map((c) => `  ${quoteIdent(c, engine)}`).join(',\n') : '  *'
  return engine === 'mysql'
    ? `SELECT\n${list}\nFROM ${from}\nLIMIT ${limit}`
    : `SELECT TOP (${limit})\n${list}\nFROM ${from}`
}

export function buildCountQuery(engine: Engine, ref: TableRef, where: string | null): string {
  const from = qualifiedName(engine, ref.database, { schema: ref.schema, name: ref.table })
  return `SELECT COUNT(*) AS total FROM ${from}${whereClause(where)}`
}

const keyLabel = (key: CellChange[]): string =>
  `la fila con ${key.map((k) => `${k.column} = ${k.value === null ? 'NULL' : String(k.value)}`).join(', ')}`

/** Sentencia con parámetros: `?` en MySQL, `@p0, @p1…` en SQL Server. */
export interface ParamStatement {
  sql: string
  params: CellValue[]
  /** Cómo nombrar la fila en los mensajes de error, p. ej. `la fila con id = 99`. */
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
  return { sql: `UPDATE ${from} SET ${set} WHERE ${where}`, params, label: keyLabel(update.key) }
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

/** INSERT de una fila nueva. Sin columnas, la fila entera toma los valores por defecto. */
export function buildInsert(engine: Engine, ref: TableRef, set: CellChange[], paramStart = 0, label = 'la fila nueva'): ParamStatement {
  const from = qualifiedName(engine, ref.database, { schema: ref.schema, name: ref.table })
  if (set.length === 0) {
    return { sql: engine === 'mysql' ? `INSERT INTO ${from} () VALUES ()` : `INSERT INTO ${from} DEFAULT VALUES`, params: [], label }
  }
  const params = set.map((c) => c.value)
  const columns = set.map((c) => quoteIdent(c.column, engine)).join(', ')
  const values = set.map((_, i) => (engine === 'mysql' ? '?' : `@p${paramStart + i}`)).join(', ')
  return { sql: `INSERT INTO ${from} (${columns}) VALUES (${values})`, params, label }
}

/** DELETE de una fila localizada por su clave primaria. */
export function buildDelete(engine: Engine, ref: TableRef, key: CellChange[], paramStart = 0): ParamStatement {
  const from = qualifiedName(engine, ref.database, { schema: ref.schema, name: ref.table })
  const where = key.map((k, i) => `${quoteIdent(k.column, engine)} = ${engine === 'mysql' ? '?' : `@p${paramStart + i}`}`).join(' AND ')
  return { sql: `DELETE FROM ${from} WHERE ${where}`, params: key.map((k) => k.value), label: keyLabel(key) }
}

export function previewInsert(engine: Engine, ref: TableRef, set: CellChange[]): string {
  const from = qualifiedName(engine, ref.database, { schema: ref.schema, name: ref.table })
  if (set.length === 0) return engine === 'mysql' ? `INSERT INTO ${from} () VALUES ()` : `INSERT INTO ${from} DEFAULT VALUES`
  return `INSERT INTO ${from} (${set.map((c) => quoteIdent(c.column, engine)).join(', ')}) VALUES (${set.map((c) => sqlLiteral(c.value, engine)).join(', ')})`
}

export function previewDelete(engine: Engine, ref: TableRef, key: CellChange[]): string {
  const from = qualifiedName(engine, ref.database, { schema: ref.schema, name: ref.table })
  return `DELETE FROM ${from} WHERE ${equalsCondition(engine, key.map((k) => k.column), key.map((k) => k.value))}`
}
