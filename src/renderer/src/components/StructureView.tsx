import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  buildAlterStatements,
  designFromStructure,
  diffDesign,
  hasDesignChanges,
  renameColumn,
  structureSignature,
  validateDesign,
  type DesignIssue
} from '@shared/table-ddl'
import type { AlterTableOutput, ColumnDesign, Engine, IndexDesign, TableDesign, TableRef, TableStructure } from '@shared/types'
import { Icon } from './Icon'

export type Loadable<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string }

const TYPES: Record<Engine, string[]> = {
  mysql: [
    'int', 'bigint', 'smallint', 'tinyint', 'tinyint(1)', 'decimal(10,2)', 'double', 'float', 'varchar(255)', 'char(36)', 'text',
    'mediumtext', 'longtext', 'date', 'datetime', 'timestamp', 'time', 'year', 'json', 'blob', 'varbinary(255)', "enum('a','b')", 'bit(1)'
  ],
  mssql: [
    'int', 'bigint', 'smallint', 'tinyint', 'bit', 'decimal(18,2)', 'numeric(18,2)', 'money', 'float', 'real', 'nvarchar(255)',
    'nvarchar(max)', 'varchar(255)', 'varchar(max)', 'nchar(10)', 'char(10)', 'date', 'datetime2', 'datetime', 'smalldatetime', 'time',
    'datetimeoffset', 'uniqueidentifier', 'varbinary(max)', 'xml'
  ]
}

/** Diseño en edición: lo borrado se queda en la lista (tachado, se puede restaurar) hasta aplicar. */
interface Draft {
  design: TableDesign
  droppedColumns: Set<string>
  droppedIndexes: Set<string>
}

const draftFrom = (s: TableStructure): Draft => ({ design: designFromStructure(s), droppedColumns: new Set(), droppedIndexes: new Set() })

/** El diseño sin lo borrado: lo que se compara con la tabla para sacar el SQL. */
const effectiveDesign = (d: Draft): TableDesign => ({
  ...d.design,
  columns: d.design.columns.filter((c) => c.original === null || !d.droppedColumns.has(c.original)),
  indexes: d.design.indexes.filter((i) => i.original === null || !d.droppedIndexes.has(i.original))
})

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

interface Props {
  structure: Loadable<TableStructure>
  engine: Engine
  tableRef: TableRef
  hidden: boolean
  /** Motivo por el que no se puede editar (vista, conexión de solo lectura) o null. */
  readOnlyReason: string | null
  prod: boolean
  onOpen: (ref: TableRef) => void
  onApply: (design: TableDesign, base: string, expected: string[]) => Promise<AlterTableOutput>
  /** Tras aplicar (aunque sea a medias): recargar estructura y datos. */
  onApplied: (message: string) => void
  onOpenConsole: (sql: string) => void
  onDirtyChange: (dirty: boolean) => void
}

/**
 * Estructura de la tabla, editable al estilo DataGrip: se cambian las celdas, se revisa el SQL que
 * se ha generado y se aplica. Nada se envía al servidor hasta pulsar «Aplicar».
 */
export function StructureView(props: Props) {
  const { structure, engine, tableRef, hidden, readOnlyReason, prod, onOpen, onApply, onApplied, onOpenConsole, onDirtyChange } = props
  const value = structure.state === 'ready' ? structure.value : null
  const [draft, setDraft] = useState<Draft | null>(null)
  const [review, setReview] = useState<{ statements: string[]; applying: boolean; error: string | null } | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const canEdit = readOnlyReason === null

  // Cada carga de la estructura (al abrir, recargar o aplicar) empieza un diseño limpio.
  useEffect(() => {
    setDraft(value ? draftFrom(value) : null)
    setReview(null)
  }, [value])

  const design = useMemo(() => (draft ? effectiveDesign(draft) : null), [draft])
  const diff = useMemo(() => (value && design ? diffDesign(value, design) : null), [value, design])
  const dirty = diff ? hasDesignChanges(diff) : false
  const issues = useMemo(() => (value && design ? validateDesign(engine, value, design) : []), [engine, value, design])

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty])

  if (structure.state === 'loading' && !draft) return hidden ? null : <div className="grid-empty">Cargando estructura…</div>
  if (structure.state === 'error') return hidden ? null : <div className="result-message error">{structure.message}</div>
  if (!value || !draft || !design || !diff) return null

  const update = (next: Partial<Draft>) => {
    setDraft({ ...draft, ...next })
    setApplyError(null)
  }
  const setColumn = (index: number, patch: Partial<ColumnDesign>) =>
    update({ design: { ...draft.design, columns: draft.design.columns.map((c, i) => (i === index ? { ...c, ...patch } : c)) } })
  const setIndex = (index: number, patch: Partial<IndexDesign>) =>
    update({ design: { ...draft.design, indexes: draft.design.indexes.map((x, i) => (i === index ? { ...x, ...patch } : x)) } })

  const addColumn = () => {
    const used = new Set(draft.design.columns.map((c) => c.name.toLowerCase()))
    let n = 1
    while (used.has(`columna${n}`)) n++
    const column: ColumnDesign = {
      original: null,
      name: `columna${n}`,
      dataType: engine === 'mysql' ? 'varchar(255)' : 'nvarchar(255)',
      nullable: true,
      defaultValue: null,
      autoIncrement: false,
      primaryKey: false,
      comment: null
    }
    update({ design: { ...draft.design, columns: [...draft.design.columns, column] } })
  }

  const addIndex = () => {
    const used = new Set(draft.design.indexes.map((i) => i.name.toLowerCase()))
    let n = 1
    while (used.has(`idx_${tableRef.table}_${n}`.toLowerCase())) n++
    const index: IndexDesign = { original: null, name: `idx_${tableRef.table}_${n}`, columns: [], unique: false }
    update({ design: { ...draft.design, indexes: [...draft.design.indexes, index] } })
  }

  /** Las nuevas se quitan; las existentes se marcan para borrar (o se restauran). */
  const toggleColumn = (index: number) => {
    const c = draft.design.columns[index]!
    if (c.original === null) {
      update({ design: { ...draft.design, columns: draft.design.columns.filter((_, i) => i !== index) } })
      return
    }
    const droppedColumns = new Set(draft.droppedColumns)
    if (!droppedColumns.delete(c.original)) droppedColumns.add(c.original)
    update({ droppedColumns })
  }
  const toggleIndex = (index: number) => {
    const ix = draft.design.indexes[index]!
    if (ix.original === null) {
      update({ design: { ...draft.design, indexes: draft.design.indexes.filter((_, i) => i !== index) } })
      return
    }
    const droppedIndexes = new Set(draft.droppedIndexes)
    if (!droppedIndexes.delete(ix.original)) droppedIndexes.add(ix.original)
    update({ droppedIndexes })
  }
  const toggleForeignKey = (name: string) => {
    const drop = draft.design.dropForeignKeys
    update({ design: { ...draft.design, dropForeignKeys: drop.includes(name) ? drop.filter((n) => n !== name) : [...drop, name] } })
  }

  // Los avisos de validación van por posición en el diseño efectivo (sin lo borrado); filtrar no
  // copia los elementos, así que se encuentran por referencia (-1 si está borrado).
  const effectiveColumn = (index: number) => design.columns.indexOf(draft.design.columns[index]!)
  const effectiveIndex = (index: number) => design.indexes.indexOf(draft.design.indexes[index]!)
  const issueOf = (scope: DesignIssue['scope'], at: number, field: DesignIssue['field']) =>
    at < 0 ? undefined : issues.find((i) => i.scope === scope && i.index === at && i.field === field)

  const openReview = () => {
    if (!dirty || issues.length > 0) return
    try {
      setReview({ statements: buildAlterStatements(engine, tableRef, value, design), applying: false, error: null })
      setCopied(false)
    } catch (err) {
      setApplyError((err as Error).message)
    }
  }

  const apply = async () => {
    if (!review) return
    setReview({ ...review, applying: true, error: null })
    try {
      const out = await onApply(design, structureSignature(value), review.statements)
      if (!out.error) {
        setReview(null)
        onApplied(`Estructura modificada: ${plural(out.executed, 'sentencia aplicada', 'sentencias aplicadas')}`)
      } else if (out.executed > 0) {
        // MySQL no deshace el DDL: lo aplicado se queda y hay que partir de la tabla tal como está.
        setReview(null)
        setApplyError(`Se aplicaron ${out.executed} de ${out.total} sentencias y falló la siguiente: ${out.error}. Se ha recargado la estructura.`)
        onApplied('Estructura modificada a medias')
      } else {
        setReview({ ...review, applying: false, error: out.error })
      }
    } catch (err) {
      setReview({ ...review, applying: false, error: (err as Error).message })
    }
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' && e.altKey && canEdit) {
      e.preventDefault()
      openReview()
    }
  }

  const summary = [
    diff.changedColumns.length && plural(diff.changedColumns.length, 'columna modificada', 'columnas modificadas'),
    diff.newColumns.length && plural(diff.newColumns.length, 'columna nueva', 'columnas nuevas'),
    diff.droppedColumns.length && plural(diff.droppedColumns.length, 'columna para borrar', 'columnas para borrar'),
    diff.pkChanged && 'clave primaria',
    diff.changedIndexes.length + diff.newIndexes.length + diff.droppedIndexes.length &&
      plural(diff.changedIndexes.length + diff.newIndexes.length + diff.droppedIndexes.length, 'índice', 'índices'),
    diff.dropForeignKeys.length && plural(diff.dropForeignKeys.length, 'clave foránea para borrar', 'claves foráneas para borrar')
  ].filter(Boolean)
  const firstIssue = issues[0]

  const primary = value.indexes.find((i) => i.primary)
  const sql = review ? `${review.statements.join(';\n\n')};` : ''

  return (
    <div className="structure-pane" hidden={hidden} onKeyDown={onKeyDown}>
      {(dirty || applyError) && (
        <div className={`edit-bar ${applyError ? 'error' : ''}`} role="status">
          {applyError ? (
            <span>{applyError}</span>
          ) : (
            <span>
              ✎ Sin guardar: {summary.join(' · ')}
              {firstIssue ? (
                <span className="bar-issue"> · ⚠ {firstIssue.message}</span>
              ) : (
                <>
                  {' '}
                  · <kbd>Alt</kbd>+<kbd>Enter</kbd> para revisar el SQL
                </>
              )}
            </span>
          )}
          <span className="spacer" />
          {dirty && (
            <>
              <button className="compact primary" disabled={issues.length > 0} onClick={openReview}>
                Revisar SQL…
              </button>
              <button className="compact" onClick={() => update({ ...draftFrom(value) })}>
                Descartar
              </button>
            </>
          )}
        </div>
      )}

      <div className="structure">
        <h3>
          Columnas ({design.columns.length})
          {canEdit && (
            <button className="link" title="Añadir una columna al final" onClick={addColumn}>
              + Añadir columna
            </button>
          )}
        </h3>
        <datalist id={`types-${engine}`}>
          {TYPES[engine].map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <table className="info-table structure-edit">
          <thead>
            <tr>
              <th>#</th>
              <th className="center" title="Clave primaria">
                🔑
              </th>
              <th>Nombre</th>
              <th>Tipo</th>
              <th className="center">Nulo</th>
              <th>Por defecto</th>
              <th className="center" title={engine === 'mysql' ? 'AUTO_INCREMENT' : 'IDENTITY'}>
                Auto
              </th>
              {engine === 'mysql' && <th>Comentario</th>}
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {draft.design.columns.map((c, i) => {
              const info = c.original === null ? undefined : value.columns.find((x) => x.name === c.original)
              const dropped = c.original !== null && draft.droppedColumns.has(c.original)
              const locked = !canEdit || dropped
              const generated = Boolean(info?.generated)
              const at = effectiveColumn(i)
              const changed = (field: keyof ColumnDesign) =>
                info !== undefined && !dropped && String(c[field] ?? '').trim() !== String(fieldOf(info, field) ?? '').trim()
              const anyChange = (['name', 'dataType', 'nullable', 'defaultValue', 'autoIncrement', 'primaryKey', 'comment'] as const).some(changed)
              const cell = (field: DesignIssue['field'], extra = '') => ({
                className: `${field !== 'columns' && changed(field) ? 'changed' : ''} ${extra}`,
                issue: issueOf('column', at, field)
              })
              const name = cell('name')
              const type = cell('dataType')
              const def = cell('defaultValue')
              const nullable = cell('nullable', 'center')
              const auto = cell('autoIncrement', 'center')
              return (
                <tr key={i} className={dropped ? 'row-dropped' : c.original === null ? 'row-added' : anyChange ? 'row-changed' : ''}>
                  <td className="dim">{i + 1}</td>
                  <td className={`center ${changed('primaryKey') ? 'changed' : ''}`}>
                    <input
                      type="checkbox"
                      aria-label={`Clave primaria: ${c.name}`}
                      checked={c.primaryKey}
                      disabled={locked || generated}
                      onChange={(e) => setColumn(i, e.target.checked ? { primaryKey: true, nullable: false } : { primaryKey: false })}
                    />
                  </td>
                  <td className={name.className}>
                    <input
                      className={`cell-input ${name.issue ? 'invalid' : ''}`}
                      aria-label="Nombre de la columna"
                      title={name.issue?.message ?? (info?.name !== undefined && info.name !== c.name ? `Antes: ${info.name}` : undefined)}
                      value={c.name}
                      readOnly={locked}
                      autoFocus={c.original === null && i === draft.design.columns.length - 1}
                      onFocus={(e) => c.original === null && e.target.select()}
                      onChange={(e) => update({ design: renameColumn(draft.design, i, e.target.value) })}
                    />
                  </td>
                  <td className={type.className}>
                    <input
                      className={`cell-input ${type.issue ? 'invalid' : ''}`}
                      aria-label={`Tipo de ${c.name}`}
                      title={type.issue?.message ?? (generated ? `Calculada: ${info!.generated!.expression}` : undefined)}
                      list={`types-${engine}`}
                      value={c.dataType}
                      readOnly={locked || generated}
                      spellCheck={false}
                      onChange={(e) => setColumn(i, { dataType: e.target.value })}
                    />
                  </td>
                  <td className={nullable.className} title={nullable.issue?.message}>
                    <input
                      type="checkbox"
                      aria-label={`Admite nulos: ${c.name}`}
                      checked={c.nullable}
                      className={nullable.issue ? 'invalid' : ''}
                      disabled={locked || generated}
                      onChange={(e) => setColumn(i, { nullable: e.target.checked })}
                    />
                  </td>
                  <td className={def.className}>
                    <input
                      className={`cell-input ${def.issue ? 'invalid' : ''}`}
                      aria-label={`Valor por defecto de ${c.name}`}
                      title={def.issue?.message ?? "Expresión SQL: 'texto', 0, CURRENT_TIMESTAMP… Vacío = sin valor por defecto"}
                      placeholder={locked || generated ? '' : '—'}
                      value={c.defaultValue ?? ''}
                      readOnly={locked || generated}
                      spellCheck={false}
                      onChange={(e) => setColumn(i, { defaultValue: e.target.value === '' ? null : e.target.value })}
                    />
                  </td>
                  <td className={auto.className} title={auto.issue?.message}>
                    <input
                      type="checkbox"
                      aria-label={`Autoincremental: ${c.name}`}
                      checked={c.autoIncrement}
                      disabled={locked || generated || (engine === 'mssql' && c.original !== null && !auto.issue)}
                      onChange={(e) => setColumn(i, { autoIncrement: e.target.checked })}
                    />
                  </td>
                  {engine === 'mysql' && (
                    <td className={changed('comment') ? 'changed' : ''}>
                      <input
                        className="cell-input plain"
                        aria-label={`Comentario de ${c.name}`}
                        value={c.comment ?? ''}
                        readOnly={locked}
                        onChange={(e) => setColumn(i, { comment: e.target.value === '' ? null : e.target.value })}
                      />
                    </td>
                  )}
                  {canEdit && (
                    <td className="row-tools">
                      <button
                        className="icon"
                        title={dropped ? 'Restaurar la columna' : c.original === null ? 'Quitar la columna nueva' : 'Borrar la columna'}
                        aria-label={dropped ? `Restaurar ${c.name}` : `Borrar ${c.name}`}
                        onClick={() => toggleColumn(i)}
                      >
                        {dropped ? '↺' : <Icon name="minus" />}
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>

        <h3>
          Índices ({design.indexes.length + (diff.newPk.length ? 1 : 0)})
          {canEdit && (
            <button className="link" onClick={addIndex}>
              + Añadir índice
            </button>
          )}
        </h3>
        <table className="info-table structure-edit">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Columnas</th>
              <th className="center">Único</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {diff.newPk.length > 0 && (
              <tr className={diff.pkChanged ? 'row-changed' : ''}>
                <td className="mono pk-name">{primary?.name ?? (engine === 'mysql' ? 'PRIMARY' : `PK_${tableRef.table}`)}</td>
                <td className="pk-name">
                  <span className={`mono ${diff.pkChanged ? 'changed-text' : ''}`}>{diff.newPk.join(', ')}</span>
                  <span className="note"> · clave primaria{canEdit && ', se cambia con 🔑 en las columnas'}</span>
                </td>
                <td className="center">
                  <input type="checkbox" aria-label="Clave primaria: única" checked disabled />
                </td>
                {canEdit && <td />}
              </tr>
            )}
            {draft.design.indexes.map((ix, i) => {
              const info = ix.original === null ? undefined : value.indexes.find((x) => x.name === ix.original)
              const dropped = ix.original !== null && draft.droppedIndexes.has(ix.original)
              const locked = !canEdit || dropped
              const at = effectiveIndex(i)
              const nameIssue = issueOf('index', at, 'name')
              const columnsIssue = issueOf('index', at, 'columns')
              const changed = info !== undefined && !dropped && diff.changedIndexes.some((x) => x.info.name === info.name)
              return (
                <tr key={i} className={dropped ? 'row-dropped' : ix.original === null ? 'row-added' : changed ? 'row-changed' : ''}>
                  <td>
                    <input
                      className={`cell-input ${nameIssue ? 'invalid' : ''}`}
                      aria-label="Nombre del índice"
                      title={nameIssue?.message}
                      value={ix.name}
                      readOnly={locked}
                      autoFocus={ix.original === null && i === draft.design.indexes.length - 1}
                      onFocus={(e) => ix.original === null && e.target.select()}
                      onChange={(e) => setIndex(i, { name: e.target.value })}
                    />
                  </td>
                  <td>
                    <ColumnsInput
                      value={ix.columns}
                      invalid={columnsIssue?.message}
                      readOnly={locked}
                      label={`Columnas de ${ix.name}`}
                      onChange={(columns) => setIndex(i, { columns })}
                    />
                  </td>
                  <td className="center">
                    <input
                      type="checkbox"
                      aria-label={`Índice único: ${ix.name}`}
                      checked={ix.unique}
                      disabled={locked}
                      onChange={(e) => setIndex(i, { unique: e.target.checked })}
                    />
                  </td>
                  {canEdit && (
                    <td className="row-tools">
                      <button
                        className="icon"
                        title={dropped ? 'Restaurar el índice' : 'Borrar el índice'}
                        aria-label={dropped ? `Restaurar ${ix.name}` : `Borrar ${ix.name}`}
                        onClick={() => toggleIndex(i)}
                      >
                        {dropped ? '↺' : <Icon name="minus" />}
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
        {design.indexes.length === 0 && diff.newPk.length === 0 && <p className="dim">Sin índices.</p>}

        <h3>Claves foráneas ({value.foreignKeys.length - diff.dropForeignKeys.length})</h3>
        {value.foreignKeys.length === 0 ? (
          <p className="dim">Sin claves foráneas.</p>
        ) : (
          <table className="info-table structure-edit">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Columnas</th>
                <th>Referencia</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {value.foreignKeys.map((fk) => {
                const dropped = draft.design.dropForeignKeys.includes(fk.name)
                return (
                  <tr key={fk.name} className={dropped ? 'row-dropped' : ''}>
                    <td className="fk-text">{fk.name}</td>
                    <td className="mono fk-text">{fk.columns.join(', ')}</td>
                    <td>
                      <button
                        className="link"
                        title="Abrir la tabla referenciada"
                        onClick={() => onOpen({ database: fk.refDatabase, schema: fk.refSchema, table: fk.refTable })}
                      >
                        {engine === 'mysql' ? `${fk.refDatabase}.${fk.refTable}` : `${fk.refSchema}.${fk.refTable}`}
                      </button>{' '}
                      <span className="mono dim">({fk.refColumns.join(', ')})</span>
                    </td>
                    {canEdit && (
                      <td className="row-tools">
                        <button
                          className="icon"
                          title={dropped ? 'Restaurar la clave foránea' : 'Borrar la clave foránea'}
                          aria-label={dropped ? `Restaurar ${fk.name}` : `Borrar ${fk.name}`}
                          onClick={() => toggleForeignKey(fk.name)}
                        >
                          {dropped ? '↺' : <Icon name="minus" />}
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {value.ddl && <Ddl ddl={value.ddl} />}
      </div>

      {review && (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !review.applying && setReview(null)}>
          <div
            className="dialog wide"
            role="dialog"
            aria-label="Revisar cambios de estructura"
            onKeyDown={(e) => e.key === 'Escape' && !review.applying && setReview(null)}
          >
            <h2>
              Modificar {tableRef.schema && engine === 'mssql' ? `${tableRef.schema}.` : ''}
              {tableRef.table}
            </h2>
            <div className="body">
              {review.error && <div className="notice error">{review.error}</div>}
              {prod && <div className="notice error">Conexión de producción: revisa bien el SQL antes de aplicarlo.</div>}
              <p className="note">
                {engine === 'mssql'
                  ? 'Se aplica todo en una transacción: si una sentencia falla, no se cambia nada.'
                  : review.statements.length > 1
                    ? 'MySQL no deshace los cambios de estructura: si una sentencia falla, las anteriores se quedan aplicadas.'
                    : 'Se aplica en una sola sentencia.'}{' '}
                En tablas grandes puede tardar y bloquear la tabla mientras dura.
              </p>
              <pre className="ddl review-sql">{sql}</pre>
            </div>
            <div className="footer">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(sql)
                  setCopied(true)
                }}
              >
                {copied ? 'Copiado' : 'Copiar'}
              </button>
              <button
                title="Abrir el SQL en una consola para ejecutarlo a mano"
                onClick={() => {
                  // La consola añade el «;» final.
                  onOpenConsole(review.statements.join(';\n\n'))
                  setReview(null)
                }}
              >
                Abrir en consola
              </button>
              <div className="spacer" />
              <button autoFocus disabled={review.applying} onClick={() => setReview(null)}>
                Cancelar
              </button>
              <button className={prod ? 'danger' : 'primary'} disabled={review.applying} onClick={() => void apply()}>
                {review.applying ? 'Aplicando…' : prod ? 'Aplicar en producción' : 'Aplicar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fieldOf(info: TableStructure['columns'][number], field: keyof ColumnDesign): unknown {
  switch (field) {
    case 'primaryKey':
      return info.isPrimaryKey
    case 'comment':
      return info.comment ?? null
    case 'original':
      return info.name
    default:
      return info[field]
  }
}

/** Columnas de un índice separadas por comas; el texto se conserva mientras se escribe. */
function ColumnsInput({
  value,
  invalid,
  readOnly,
  label,
  onChange
}: {
  value: string[]
  invalid?: string
  readOnly: boolean
  label: string
  onChange: (columns: string[]) => void
}) {
  const parse = (text: string) =>
    text
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
  const [text, setText] = useState(value.join(', '))
  // Si cambia desde fuera (renombrar una columna, descartar), se reescribe el texto.
  useEffect(() => {
    if (parse(text).join('\u0000') !== value.join('\u0000')) setText(value.join(', '))
  }, [value])
  return (
    <input
      className={`cell-input ${invalid ? 'invalid' : ''}`}
      aria-label={label}
      title={invalid ?? 'Columnas separadas por comas, en orden'}
      placeholder="columna1, columna2"
      value={text}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value)
        onChange(parse(e.target.value))
      }}
    />
  )
}

function Ddl({ ddl }: { ddl: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <>
      <h3>
        DDL{' '}
        <button
          className="link"
          onClick={() => {
            void navigator.clipboard.writeText(ddl)
            setCopied(true)
          }}
        >
          {copied ? 'copiado' : 'copiar'}
        </button>
      </h3>
      <pre className="ddl">{ddl}</pre>
    </>
  )
}
