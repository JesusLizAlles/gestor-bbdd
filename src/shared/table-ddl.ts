// SQL del editor de estructura. Puro y sin dependencias: la interfaz lo usa para la vista previa y
// el proceso principal lo vuelve a generar con la estructura recién leída antes de ejecutarlo.
import { qualifiedName, quoteIdent, sqlLiteral } from './format'
import type { ColumnDesign, ColumnInfo, Engine, IndexDesign, IndexInfo, TableDesign, TableRef, TableStructure } from './types'

export function designFromStructure(s: TableStructure): TableDesign {
  return {
    columns: s.columns.map((c) => ({
      original: c.name,
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      defaultValue: c.defaultValue,
      autoIncrement: c.autoIncrement,
      primaryKey: c.isPrimaryKey,
      comment: c.comment ?? null
    })),
    indexes: s.indexes.filter((i) => !i.primary).map((i) => ({ original: i.name, name: i.name, columns: [...i.columns], unique: i.unique })),
    dropForeignKeys: []
  }
}

/**
 * Huella de la estructura sobre la que se hizo el diseño. El diseño guarda valores completos (un
 * comentario vacío significa «quitarlo»), así que si la tabla cambia entre medias hay que saberlo:
 * si no, se desharían en silencio los cambios de otra persona.
 */
export function structureSignature(s: TableStructure): string {
  return JSON.stringify([s.columns, s.indexes, s.foreignKeys])
}

/** Renombra una columna del diseño y la cambia también en los índices que la usan. */
export function renameColumn(design: TableDesign, index: number, name: string): TableDesign {
  const previous = design.columns[index]?.name.trim().toLowerCase()
  return {
    ...design,
    columns: design.columns.map((c, i) => (i === index ? { ...c, name } : c)),
    indexes: design.indexes.map((ix) => ({ ...ix, columns: ix.columns.map((c) => (c.trim().toLowerCase() === previous ? name : c)) }))
  }
}

/**
 * Recorre `text` fuera de comillas y comentarios. Devuelve un error si el fragmento no es una única
 * expresión (un `;`, un comentario, comillas o paréntesis sin cerrar) o null si vale.
 */
export function checkSqlFragment(text: string, engine: Engine): string | null {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const close = ch === "'" || ch === '"' ? ch : ch === '`' && engine === 'mysql' ? '`' : ch === '[' && engine === 'mssql' ? ']' : null
    if (close) {
      let j = i + 1
      for (; j < text.length; j++) {
        if (engine === 'mysql' && close !== '`' && text[j] === '\\') j++
        else if (text[j] === close) {
          if (text[j + 1] === close && close !== ']') j++
          else break
        }
      }
      if (j >= text.length) return 'Hay comillas sin cerrar'
      i = j
      continue
    }
    if (ch === ';') return 'No puede llevar «;»'
    if ((ch === '-' && text[i + 1] === '-') || (ch === '/' && text[i + 1] === '*') || (ch === '#' && engine === 'mysql')) {
      return 'No puede llevar comentarios'
    }
    if (ch === '(') depth++
    if (ch === ')' && --depth < 0) return 'Paréntesis sin abrir'
  }
  return depth === 0 ? null : 'Paréntesis sin cerrar'
}

/** Quita los paréntesis que envuelven toda la expresión: SQL Server guarda `((0))` o `(getdate())`. */
export function unwrapParens(expr: string): string {
  let text = expr.trim()
  while (text.startsWith('(') && text.endsWith(')')) {
    // ¿El primer paréntesis se cierra en el último carácter? (`(1)+(2)` no se puede desenvolver.)
    let depth = 0
    let quote: string | null = null
    let closesAtEnd = false
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!
      if (quote) {
        if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"') quote = ch
      else if (ch === '(') depth++
      else if (ch === ')' && --depth === 0) {
        closesAtEnd = i === text.length - 1
        break
      }
    }
    if (!closesAtEnd) break
    text = text.slice(1, -1).trim()
  }
  return text
}

const TYPE_PATTERN = /^[a-z_][\w ]*(\(.*\))?[\w ]*$/is
const isTextType = (type: string): boolean => /^\s*(n?(var)?char|n?text|tinytext|mediumtext|longtext|enum|set)\b/i.test(type)
const hasCharset = (type: string): boolean => /\b(collate|character\s+set|charset)\b/i.test(type)
const normType = (type: string): string => type.trim().replace(/\s+/g, ' ').toLowerCase()
const normDefault = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim())
const maxIdent = (engine: Engine): number => (engine === 'mysql' ? 64 : 128)

export interface DesignIssue {
  scope: 'column' | 'index'
  /** Posición en `design.columns` o `design.indexes`. */
  index: number
  field: 'name' | 'dataType' | 'defaultValue' | 'autoIncrement' | 'nullable' | 'columns'
  message: string
}

/** Columna de la tabla actual de la que sale cada columna del diseño (undefined si es nueva). */
function originals(structure: TableStructure, design: TableDesign): (ColumnInfo | undefined)[] {
  return design.columns.map((c) => (c.original === null ? undefined : structure.columns.find((x) => x.name === c.original)))
}

/** Qué cambia en una columna existente. */
function columnChanges(c: ColumnDesign, info: ColumnInfo) {
  return {
    renamed: c.name !== info.name,
    definition: normType(c.dataType) !== normType(info.dataType) || c.nullable !== info.nullable,
    identity: c.autoIncrement !== info.autoIncrement,
    defaultValue: normDefault(c.defaultValue) !== normDefault(info.defaultValue),
    comment: (c.comment ?? '') !== (info.comment ?? '')
  }
}

/** Errores que impiden generar el SQL, para marcarlos en la interfaz. */
export function validateDesign(engine: Engine, structure: TableStructure, design: TableDesign): DesignIssue[] {
  const issues: DesignIssue[] = []
  const infos = originals(structure, design)
  const names = new Map<string, number>()
  for (const c of design.columns) names.set(c.name.trim().toLowerCase(), (names.get(c.name.trim().toLowerCase()) ?? 0) + 1)
  design.columns.forEach((c, index) => {
    const add = (field: DesignIssue['field'], message: string) => issues.push({ scope: 'column', index, field, message })
    const info = infos[index]
    const name = c.name.trim()
    if (!name) add('name', 'Falta el nombre')
    else if (name.length > maxIdent(engine)) add('name', `Nombre demasiado largo (máx. ${maxIdent(engine)})`)
    else if ((names.get(name.toLowerCase()) ?? 0) > 1) add('name', 'Nombre repetido')
    if (info?.generated) {
      const ch = columnChanges(c, info)
      if (ch.definition || ch.identity || ch.defaultValue) add('dataType', 'Columna calculada: solo se puede renombrar o borrar')
      return
    }
    if (!c.dataType.trim()) add('dataType', 'Falta el tipo')
    else if (!TYPE_PATTERN.test(c.dataType.trim()) || checkSqlFragment(c.dataType, engine)) add('dataType', 'Tipo no válido')
    const def = normDefault(c.defaultValue)
    if (def !== null) {
      const problem = checkSqlFragment(def, engine)
      if (problem) add('defaultValue', problem)
      else if (c.autoIncrement) add('defaultValue', 'Una columna autoincremental no lleva valor por defecto')
    }
    if (c.primaryKey && c.nullable) add('nullable', 'La clave primaria no admite nulos')
    if (engine === 'mssql' && info && c.autoIncrement !== info.autoIncrement) {
      add('autoIncrement', 'SQL Server no permite poner o quitar IDENTITY en una columna existente')
    }
  })
  if (design.columns.length === 0) issues.push({ scope: 'column', index: 0, field: 'name', message: 'La tabla necesita al menos una columna' })

  const finalColumns = new Set(design.columns.map((c) => c.name.trim().toLowerCase()))
  const indexNames = new Map<string, number>()
  for (const ix of design.indexes) indexNames.set(ix.name.trim().toLowerCase(), (indexNames.get(ix.name.trim().toLowerCase()) ?? 0) + 1)
  design.indexes.forEach((ix, index) => {
    const add = (field: DesignIssue['field'], message: string) => issues.push({ scope: 'index', index, field, message })
    const name = ix.name.trim()
    if (!name) add('name', 'Falta el nombre')
    else if (name.length > maxIdent(engine)) add('name', `Nombre demasiado largo (máx. ${maxIdent(engine)})`)
    else if ((indexNames.get(name.toLowerCase()) ?? 0) > 1) add('name', 'Nombre repetido')
    else if (engine === 'mysql' && name.toUpperCase() === 'PRIMARY') add('name', 'PRIMARY está reservado para la clave primaria')
    if (ix.columns.length === 0) add('columns', 'Indica al menos una columna')
    const missing = ix.columns.find((c) => !finalColumns.has(c.trim().toLowerCase()))
    if (missing) add('columns', `No existe la columna ${missing}`)
  })
  return issues
}

/** Resumen de lo que cambia, para la barra de cambios sin guardar y para generar el SQL. */
export function diffDesign(structure: TableStructure, design: TableDesign) {
  const infos = originals(structure, design)
  const kept = new Set(design.columns.map((c) => c.original).filter((n): n is string => n !== null))
  const changedColumns: { design: ColumnDesign; info: ColumnInfo; changes: ReturnType<typeof columnChanges> }[] = []
  design.columns.forEach((c, i) => {
    const info = infos[i]
    if (!info) return
    const changes = columnChanges(c, info)
    if (Object.values(changes).some(Boolean)) changedColumns.push({ design: c, info, changes })
  })
  const newColumns = design.columns.filter((c) => c.original === null)
  const droppedColumns = structure.columns.filter((c) => !kept.has(c.name))

  // Clave primaria: se compara qué columnas la forman (renombrar una no la cambia).
  const primary = structure.indexes.find((i) => i.primary)
  const oldPk = primary?.columns ?? structure.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
  const identity = (c: ColumnDesign, i: number) => c.original ?? `\u0000nueva${i}`
  const newPkIds = design.columns.map((c, i) => (c.primaryKey ? identity(c, i) : null)).filter((x): x is string => x !== null)
  const pkChanged = oldPk.length !== newPkIds.length || oldPk.some((c) => !newPkIds.includes(c))
  // Orden de la clave nueva: el que tenía para las columnas que siguen y detrás las añadidas.
  const byId = new Map(design.columns.map((c, i) => [identity(c, i), c.name.trim()]))
  const newPk = [...oldPk.filter((c) => newPkIds.includes(c)), ...newPkIds.filter((c) => !oldPk.includes(c))].map((c) => byId.get(c)!)

  const keptIndexes = new Set(design.indexes.map((i) => i.original).filter((n): n is string => n !== null))
  const droppedIndexes = structure.indexes.filter((i) => !i.primary && !keptIndexes.has(i.name))
  const changedIndexes: { design: IndexDesign; info: IndexInfo }[] = []
  for (const ix of design.indexes) {
    if (ix.original === null) continue
    const info = structure.indexes.find((i) => i.name === ix.original)
    if (!info) continue
    // Las columnas se comparan por nombre final: si se renombra una columna, el índice la sigue.
    const renamed = (name: string) => design.columns.find((c) => c.original === name)?.name.trim() ?? name
    const sameColumns = info.columns.map(renamed).join('\u0000').toLowerCase() === ix.columns.map((c) => c.trim()).join('\u0000').toLowerCase()
    if (ix.name.trim() !== info.name || ix.unique !== info.unique || !sameColumns) changedIndexes.push({ design: ix, info })
  }
  const newIndexes = design.indexes.filter((i) => i.original === null)
  const dropForeignKeys = design.dropForeignKeys.filter((name) => structure.foreignKeys.some((fk) => fk.name === name))

  return { changedColumns, newColumns, droppedColumns, pkChanged, oldPk, newPk, primary, droppedIndexes, changedIndexes, newIndexes, dropForeignKeys }
}

export type DesignDiff = ReturnType<typeof diffDesign>

export function hasDesignChanges(d: DesignDiff): boolean {
  return (
    d.changedColumns.length + d.newColumns.length + d.droppedColumns.length + d.droppedIndexes.length + d.changedIndexes.length +
      d.newIndexes.length + d.dropForeignKeys.length > 0 || d.pkChanged
  )
}

const columnList = (engine: Engine, columns: string[]): string => columns.map((c) => quoteIdent(c.trim(), engine)).join(', ')

/** Definición completa de una columna MySQL: CHANGE COLUMN la reemplaza entera, así que se conserva lo que no se edita. */
function mysqlColumnDef(c: ColumnDesign, info: ColumnInfo | undefined): string {
  const type = c.dataType.trim()
  const parts = [quoteIdent(c.name.trim(), 'mysql'), info?.generated ? info.dataType : type]
  if (info?.collation && /^\w+$/.test(info.collation) && isTextType(type) && !hasCharset(type)) parts.push(`COLLATE ${info.collation}`)
  if (info?.generated) {
    parts.push(`GENERATED ALWAYS AS (${info.generated.expression}) ${info.generated.stored ? 'STORED' : 'VIRTUAL'}`)
  } else {
    parts.push(c.nullable ? 'NULL' : 'NOT NULL')
    const def = normDefault(c.defaultValue)
    if (def !== null) parts.push(`DEFAULT ${def}`)
    if (c.autoIncrement) parts.push('AUTO_INCREMENT')
    if (info?.onUpdate) parts.push(`ON UPDATE ${info.onUpdate}`)
  }
  if (c.comment) parts.push(`COMMENT ${sqlLiteral(c.comment, 'mysql')}`)
  return parts.join(' ')
}

/**
 * MySQL: un único ALTER TABLE con todas las cláusulas (se aplica de una vez). Las claves foráneas
 * se quitan antes en otro, porque algunas versiones no dejan quitar en la misma sentencia el índice
 * que usan.
 */
function mysqlStatements(ref: TableRef, d: DesignDiff): string[] {
  const table = qualifiedName('mysql', ref.database, { schema: null, name: ref.table })
  const q = (name: string) => quoteIdent(name, 'mysql')
  const out: string[] = []
  if (d.dropForeignKeys.length) out.push(`ALTER TABLE ${table}\n  ${d.dropForeignKeys.map((fk) => `DROP FOREIGN KEY ${q(fk)}`).join(',\n  ')}`)
  const clauses: string[] = []
  for (const ix of [...d.droppedIndexes, ...d.changedIndexes.map((c) => c.info)]) clauses.push(`DROP INDEX ${q(ix.name)}`)
  if (d.pkChanged && d.oldPk.length) clauses.push('DROP PRIMARY KEY')
  for (const c of d.droppedColumns) clauses.push(`DROP COLUMN ${q(c.name)}`)
  for (const { design: c, info } of d.changedColumns) clauses.push(`CHANGE COLUMN ${q(info.name)} ${mysqlColumnDef(c, info)}`)
  for (const c of d.newColumns) clauses.push(`ADD COLUMN ${mysqlColumnDef(c, undefined)}`)
  if (d.pkChanged && d.newPk.length) clauses.push(`ADD PRIMARY KEY (${columnList('mysql', d.newPk)})`)
  for (const ix of [...d.changedIndexes.map((c) => c.design), ...d.newIndexes]) {
    clauses.push(`ADD ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ix.name.trim())} (${columnList('mysql', ix.columns)})`)
  }
  if (clauses.length) out.push(`ALTER TABLE ${table}\n  ${clauses.join(',\n  ')}`)
  return out
}

function mssqlColumnType(c: ColumnDesign, info: ColumnInfo | undefined): string {
  const type = c.dataType.trim()
  // Sin COLLATE, ALTER COLUMN pondría la intercalación por defecto de la base de datos.
  const collate = info?.collation && /^\w+$/.test(info.collation) && isTextType(type) && !hasCharset(type) ? ` COLLATE ${info.collation}` : ''
  return `${type}${collate}`
}

/**
 * SQL Server: una sentencia por cambio, que se ejecutan en una transacción. ALTER COLUMN no acepta
 * columnas de la clave primaria ni de índices: esos se quitan antes y se vuelven a crear después.
 */
function mssqlStatements(ref: TableRef, d: DesignDiff, structure: TableStructure): string[] {
  const table = qualifiedName('mssql', ref.database, { schema: ref.schema, name: ref.table })
  const q = (name: string) => quoteIdent(name, 'mssql')
  const alter = (clause: string) => `ALTER TABLE ${table} ${clause}`
  const out: string[] = []

  const altered = new Set(d.changedColumns.filter((c) => c.changes.definition).map((c) => c.info.name))
  const renamedTo = (name: string) => d.changedColumns.find((c) => c.info.name === name)?.design.name.trim() ?? name
  const pkRebuild = d.pkChanged || d.oldPk.some((c) => altered.has(c))
  const handled = new Set([...d.droppedIndexes, ...d.changedIndexes.map((c) => c.info)].map((i) => i.name))
  const dependent = structure.indexes.filter((i) => !i.primary && !handled.has(i.name) && i.columns.some((c) => altered.has(c)))

  for (const fk of d.dropForeignKeys) out.push(alter(`DROP CONSTRAINT ${q(fk)}`))
  for (const ix of [...d.droppedIndexes, ...d.changedIndexes.map((c) => c.info), ...dependent]) {
    out.push(ix.uniqueConstraint ? alter(`DROP CONSTRAINT ${q(ix.name)}`) : `DROP INDEX ${q(ix.name)} ON ${table}`)
  }
  if (pkRebuild && d.primary) out.push(alter(`DROP CONSTRAINT ${q(d.primary.name)}`))
  for (const c of d.droppedColumns) {
    if (c.defaultConstraint) out.push(alter(`DROP CONSTRAINT ${q(c.defaultConstraint)}`))
    out.push(alter(`DROP COLUMN ${q(c.name)}`))
  }
  for (const { design: c, info, changes } of d.changedColumns) {
    if (!changes.renamed) continue
    const objname = [ref.schema ?? 'dbo', ref.table, info.name].map(q).join('.')
    out.push(`EXEC ${q(ref.database)}.sys.sp_rename ${sqlLiteral(objname, 'mssql')}, ${sqlLiteral(c.name.trim(), 'mssql')}, 'COLUMN'`)
  }
  for (const { design: c, info, changes } of d.changedColumns) {
    const column = q(c.name.trim())
    const def = normDefault(c.defaultValue)
    // ALTER COLUMN no cambia el tipo de una columna con DEFAULT: se quita y se vuelve a poner.
    const redoDefault = changes.defaultValue || (changes.definition && Boolean(info.defaultConstraint))
    if (redoDefault && info.defaultConstraint) out.push(alter(`DROP CONSTRAINT ${q(info.defaultConstraint)}`))
    if (changes.definition) out.push(alter(`ALTER COLUMN ${column} ${mssqlColumnType(c, info)} ${c.nullable ? 'NULL' : 'NOT NULL'}`))
    if (redoDefault && def !== null) out.push(alter(`ADD DEFAULT ${def} FOR ${column}`))
  }
  for (const c of d.newColumns) {
    const def = normDefault(c.defaultValue)
    out.push(
      alter(`ADD ${q(c.name.trim())} ${mssqlColumnType(c, undefined)}${c.autoIncrement ? ' IDENTITY(1,1)' : ''} ${c.nullable ? 'NULL' : 'NOT NULL'}${def !== null ? ` DEFAULT ${def}` : ''}`)
    )
  }
  if (pkRebuild && d.newPk.length) {
    out.push(alter(`ADD CONSTRAINT ${q(d.primary?.name ?? `PK_${ref.table}`)} PRIMARY KEY (${columnList('mssql', d.newPk)})`))
  }
  const create = (name: string, columns: string[], unique: boolean, constraint = false) =>
    unique && constraint
      ? alter(`ADD CONSTRAINT ${q(name)} UNIQUE (${columnList('mssql', columns)})`)
      : `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${table} (${columnList('mssql', columns)})`
  for (const { design: ix, info } of d.changedIndexes) out.push(create(ix.name.trim(), ix.columns, ix.unique, info.uniqueConstraint))
  for (const ix of dependent) out.push(create(ix.name, ix.columns.map(renamedTo), ix.unique, ix.uniqueConstraint))
  for (const ix of d.newIndexes) out.push(create(ix.name.trim(), ix.columns, ix.unique))
  return out
}

/** Sentencias que llevan la tabla de `structure` a `design`; [] si no hay cambios. Lanza si el diseño no es válido. */
export function buildAlterStatements(engine: Engine, ref: TableRef, structure: TableStructure, design: TableDesign): string[] {
  const issues = validateDesign(engine, structure, design)
  if (issues.length) {
    const first = issues[0]!
    const target = first.scope === 'column' ? design.columns[first.index]?.name : design.indexes[first.index]?.name
    throw new Error(target ? `${target}: ${first.message}` : first.message)
  }
  const d = diffDesign(structure, design)
  if (!hasDesignChanges(d)) return []
  return engine === 'mysql' ? mysqlStatements(ref, d) : mssqlStatements(ref, d, structure)
}
