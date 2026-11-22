// Lógica compartida en su variante PostgreSQL: troceo de scripts, nombres, SQL del visor y DDL.
import { describe, expect, it } from 'vitest'
import { suggest, tokenize } from '@shared/filter'
import { isDefaultSchema, qualifiedName, quoteIdent, sqlLiteral, tableLabel, toSqlInserts } from '@shared/format'
import { isReadOnlyStatement, splitStatements } from '@shared/sql'
import {
  buildCountQuery,
  buildDelete,
  buildInsert,
  buildPageQuery,
  buildSelectColumns,
  buildUpdate,
  equalsCondition,
  previewUpdate,
  validateWhere
} from '@shared/table-query'
import { buildAlterStatements, checkSqlFragment, designFromStructure, renameColumn, validateDesign } from '@shared/table-ddl'
import type { ColumnInfo, TableDesign, TableStructure } from '@shared/types'
import { PG_TYPES } from '../src/main/drivers/postgres'

const texts = (sql: string): string[] => splitStatements(sql, 'postgres').map((s) => s.text)
const ref = { database: 'hotel', schema: 'public', table: 'reservas' }

describe('splitStatements · PostgreSQL', () => {
  it('no corta dentro de cuerpos $$ ni $etiqueta$', () => {
    const fn = `CREATE FUNCTION f() RETURNS int AS $$
BEGIN
  PERFORM 1; RETURN 2;
END;
$$ LANGUAGE plpgsql`
    const doBlock = "DO $cuerpo$ BEGIN RAISE NOTICE 'a;b $$'; END $cuerpo$"
    expect(texts(`${fn};\n${doBlock};\nSELECT 3`)).toEqual([fn, doBlock, 'SELECT 3'])
  })

  it('$1 y nombres con $ no abren cadenas', () => {
    expect(texts('SELECT a$b, $1 FROM t; SELECT 2')).toEqual(['SELECT a$b, $1 FROM t', 'SELECT 2'])
  })

  it("E'…' escapa con barra invertida; las cadenas normales no", () => {
    expect(texts("SELECT E'a\\';b'; SELECT 'c\\'; SELECT 3")).toEqual(["SELECT E'a\\';b'", "SELECT 'c\\'", 'SELECT 3'])
  })

  it('comentarios anidados, -- sin espacio y "identificadores" con ;', () => {
    expect(texts('/* a /* b; */ c; */ SELECT "x;y" --z;\n; SELECT [1]')).toEqual(['SELECT "x;y" --z;', 'SELECT [1]'])
  })

  it('BEGIN ATOMIC … END ocupa toda la función; BEGIN suelto es una transacción', () => {
    const fn = 'CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT CASE WHEN true THEN 2 END; END'
    expect(texts(`BEGIN; ${fn}; COMMIT`)).toEqual(['BEGIN', fn, 'COMMIT'])
  })

  it('# y @ son operadores, no comentarios ni parte de nombres', () => {
    expect(texts('SELECT 5 # 3; SELECT @ -2')).toEqual(['SELECT 5 # 3', 'SELECT @ -2'])
  })

  it('clasifica lecturas y escrituras', () => {
    const ro = (sql: string) => isReadOnlyStatement(splitStatements(sql, 'postgres')[0]!.words)
    expect(ro('TABLE reservas')).toBe(true)
    expect(ro("SELECT 'DELETE' FROM t")).toBe(true)
    expect(ro('SELECT $$ DROP TABLE x $$')).toBe(true)
    expect(ro('DO $$ BEGIN DELETE FROM t; END $$')).toBe(false)
    expect(ro('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x')).toBe(false)
    expect(ro('COPY t TO STDOUT')).toBe(false)
    expect(ro('SELECT * FROM t FOR UPDATE')).toBe(false)
  })
})

describe('nombres y literales', () => {
  it('comillas dobles y nombres sin base de datos', () => {
    expect(quoteIdent('a"b', 'postgres')).toBe('"a""b"')
    expect(qualifiedName('postgres', 'hotel', { schema: 'ventas', name: 'Pedidos' })).toBe('"ventas"."Pedidos"')
    expect(qualifiedName('postgres', 'hotel', { schema: null, name: 't' })).toBe('"public"."t"')
  })

  it("booleanos TRUE/FALSE y E'…' solo si hay barras invertidas", () => {
    expect(sqlLiteral(true, 'postgres')).toBe('TRUE')
    expect(sqlLiteral("l'a", 'postgres')).toBe("'l''a'")
    expect(sqlLiteral('C:\\temp', 'postgres')).toBe("E'C:\\\\temp'")
    expect(toSqlInserts({ statement: 'SELECT * FROM t', columns: [{ name: 'a', type: 'text' }], rows: [['x']], affectedRows: null, truncated: false, durationMs: 0 }, 'postgres')).toBe(
      `INSERT INTO t ("a") VALUES ('x');\n`
    )
  })

  it('no enseña el esquema public', () => {
    expect(isDefaultSchema('public')).toBe(true)
    expect(tableLabel('public', 't')).toBe('t')
    expect(tableLabel('ventas', 't')).toBe('ventas.t')
  })
})

describe('SQL del visor', () => {
  it('pagina con LIMIT/OFFSET y cuenta con el mismo filtro', () => {
    expect(buildPageQuery('postgres', ref, { where: 'id > 1', sort: [], fallbackOrder: ['id'], offset: 20, limit: 10 })).toBe(
      'SELECT * FROM "public"."reservas" WHERE (id > 1\n) ORDER BY "id" LIMIT 11 OFFSET 20'
    )
    expect(buildCountQuery('postgres', ref, null)).toBe('SELECT COUNT(*) AS total FROM "public"."reservas"')
    expect(buildSelectColumns('postgres', ref, ['id', 'Nombre'])).toBe('SELECT\n  "id",\n  "Nombre"\nFROM "public"."reservas"\nLIMIT 1000')
  })

  it('parámetros $1, $2… numerados en cada sentencia', () => {
    expect(buildUpdate('postgres', ref, { key: [{ column: 'id', value: 3 }], set: [{ column: 'nota', value: 'x' }] }, 7)).toEqual({
      sql: 'UPDATE "public"."reservas" SET "nota" = $1 WHERE "id" = $2',
      params: ['x', 3],
      label: 'la fila con id = 3'
    })
    expect(buildInsert('postgres', ref, [{ column: 'a', value: 1 }, { column: 'b', value: null }], 5).sql).toBe(
      'INSERT INTO "public"."reservas" ("a", "b") VALUES ($1, $2)'
    )
    expect(buildInsert('postgres', ref, []).sql).toBe('INSERT INTO "public"."reservas" DEFAULT VALUES')
    expect(buildDelete('postgres', ref, [{ column: 'id', value: 1 }], 9).sql).toBe('DELETE FROM "public"."reservas" WHERE "id" = $1')
    expect(previewUpdate('postgres', ref, { key: [{ column: 'id', value: 3 }], set: [{ column: 'activo', value: true }] })).toBe(
      'UPDATE "public"."reservas" SET "activo" = TRUE WHERE "id" = 3'
    )
    expect(equalsCondition('postgres', ['id', 'x'], [1, null])).toBe('"id" = 1 AND "x" IS NULL')
  })

  it('el filtro no puede escaparse con $$ ni E-strings', () => {
    expect(validateWhere("nombre = $$a$$", 'postgres')).toBe('nombre = $$a$$')
    expect(() => validateWhere("1=1; DELETE FROM t", 'postgres')).toThrow(/única condición/)
    expect(() => validateWhere("$$ $$; DELETE FROM t; SELECT $$", 'postgres')).toThrow(/única condición/)
    expect(() => validateWhere("E'\\''; DELETE FROM t; --'", 'postgres')).toThrow(/única condición/)
  })
})

describe('filtro WHERE', () => {
  const columns = [
    { name: 'id', dataType: 'integer' },
    { name: 'Estado', dataType: 'text' },
    { name: 'llegada', dataType: 'timestamp without time zone' }
  ]

  it('"…" son identificadores y E\'…\' cadenas', () => {
    const tokens = tokenize(`"Estado" = E'a\\'b' AND id::text ILIKE '1%'`, 'postgres', columns.map((c) => c.name))
      .filter((t) => t.type !== 'space')
      .map((t) => [t.text, t.type])
    expect(tokens).toEqual([
      ['"Estado"', 'column'],
      ['=', 'operator'],
      ["E'a\\'b'", 'string'],
      ['AND', 'keyword'],
      ['id', 'column'],
      ['::', 'operator'],
      ['text', 'ident'],
      ['ILIKE', 'keyword'],
      ["'1%'", 'string']
    ])
  })

  it('propone ILIKE, fechas de PostgreSQL y cita mayúsculas', () => {
    const labels = (text: string) => suggest(text, text.length, 'postgres', columns, '2026-10-26').items.map((s) => s.label)
    expect(labels('id ')).toContain('ILIKE')
    expect(labels('llegada > ')).toEqual(expect.arrayContaining(['CURRENT_DATE', "CURRENT_DATE - INTERVAL '7 days'"]))
    const estado = suggest('', 0, 'postgres', columns).items.find((s) => s.label === 'Estado')
    expect(estado?.insert).toBe('"Estado"')
    expect(suggest('', 0, 'postgres', columns).items.find((s) => s.label === 'id')?.insert).toBe('id')
  })
})

describe('editor de estructura', () => {
  const col = (name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
    name,
    dataType,
    nullable: true,
    isPrimaryKey: false,
    defaultValue: null,
    autoIncrement: false,
    comment: null,
    ...extra
  })
  const table: TableStructure = {
    columns: [
      col('id', 'integer', { nullable: false, isPrimaryKey: true, autoIncrement: true }),
      col('nombre', 'character varying(40)', { nullable: false, collation: 'es-ES-x-icu' }),
      col('estado', 'text', { defaultValue: "'nuevo'::text" }),
      col('total', 'numeric(10,2)', { generated: { expression: 'importe * 2', stored: true } }),
      col('etiquetas', 'text[]'),
      col('tipo', '"Tipo Raro"'),
      col('n', 'integer')
    ],
    indexes: [
      { name: 'reservas_pkey', columns: ['id'], unique: true, primary: true, uniqueConstraint: false },
      { name: 'idx_estado', columns: ['estado'], unique: false, primary: false, uniqueConstraint: false },
      { name: 'uq_nombre', columns: ['nombre'], unique: true, primary: false, uniqueConstraint: true }
    ],
    foreignKeys: [{ name: 'fk_n', columns: ['n'], refDatabase: 'hotel', refSchema: 'public', refTable: 'numeros', refColumns: ['n'] }],
    ddl: null
  }
  // `change` modifica el diseño o devuelve uno nuevo (como renameColumn).
  const design = (change: (d: TableDesign) => unknown): TableDesign => {
    const d = designFromStructure(table)
    const out = change(d)
    return out && typeof out === 'object' ? (out as TableDesign) : d
  }
  const alter = (change: (d: TableDesign) => unknown) => buildAlterStatements('postgres', ref, table, design(change))
  const T = 'ALTER TABLE "public"."reservas"'

  it('sin cambios no genera nada, aunque haya tipos que el patrón no reconocería', () => {
    expect(validateDesign('postgres', table, designFromStructure(table))).toEqual([])
    expect(alter(() => {})).toEqual([])
  })

  it('renombra, cambia tipo (conservando la intercalación), nulos, defecto y comentario', () => {
    expect(
      alter((base) => {
        const d = renameColumn(base, 1, 'nombre_completo')
        d.columns[1] = { ...d.columns[1]!, dataType: 'varchar(80)', nullable: true, comment: "De 'verdad'" }
        d.columns[2] = { ...d.columns[2]!, defaultValue: "'confirmada'" }
        return d
      })
    ).toEqual([
      `${T} RENAME COLUMN "nombre" TO "nombre_completo"`,
      `${T} ALTER COLUMN "nombre_completo" TYPE varchar(80) COLLATE "es-ES-x-icu"`,
      `${T} ALTER COLUMN "nombre_completo" DROP NOT NULL`,
      `COMMENT ON COLUMN "public"."reservas"."nombre_completo" IS 'De ''verdad'''`,
      `${T} ALTER COLUMN "estado" DROP DEFAULT`,
      `${T} ALTER COLUMN "estado" SET DEFAULT 'confirmada'`
    ])
  })

  it('pone y quita IDENTITY en columnas existentes y sincroniza la secuencia', () => {
    expect(alter((d) => (d.columns[0]!.autoIncrement = false))).toEqual([`${T} ALTER COLUMN "id" DROP IDENTITY`])
    expect(
      alter((d) => {
        d.columns[6] = { ...d.columns[6]!, autoIncrement: true, nullable: false }
      })
    ).toEqual([
      `${T} ALTER COLUMN "n" SET NOT NULL`,
      `${T} ALTER COLUMN "n" ADD GENERATED BY DEFAULT AS IDENTITY`,
      `SELECT setval(pg_get_serial_sequence('"public"."reservas"', 'n'), COALESCE(MAX("n"), 0) + 1, false) FROM "public"."reservas"`
    ])
    const issues = validateDesign('postgres', table, design((d) => (d.columns[6]!.autoIncrement = true)))
    expect(issues).toEqual([expect.objectContaining({ field: 'nullable', message: 'Una columna IDENTITY no admite nulos' })])
  })

  it('índices del esquema, restricciones UNIQUE, clave primaria, columnas nuevas y FK', () => {
    expect(
      alter((d) => {
        d.indexes = d.indexes.filter((i) => i.name !== 'idx_estado')
        d.indexes[0] = { ...d.indexes[0]!, columns: ['nombre', 'estado'] }
        d.indexes.push({ original: null, name: 'idx_n', columns: ['n'], unique: false })
        d.columns[6]!.primaryKey = true
        d.columns[6]!.nullable = false
        d.columns.push({ original: null, name: 'alta', dataType: 'timestamptz', nullable: false, defaultValue: 'now()', autoIncrement: false, primaryKey: false, comment: 'Alta' })
        d.columns.push({ original: null, name: 'num', dataType: 'bigint', nullable: false, defaultValue: null, autoIncrement: true, primaryKey: false, comment: null })
        d.columns = d.columns.filter((c) => c.name !== 'etiquetas')
        d.dropForeignKeys = ['fk_n']
      })
    ).toEqual([
      `${T} DROP CONSTRAINT "fk_n"`,
      'DROP INDEX "public"."idx_estado"',
      `${T} DROP CONSTRAINT "uq_nombre"`,
      `${T} DROP CONSTRAINT "reservas_pkey"`,
      `${T} DROP COLUMN "etiquetas"`,
      `${T} ALTER COLUMN "n" SET NOT NULL`,
      `${T} ADD COLUMN "alta" timestamptz NOT NULL DEFAULT now()`,
      `COMMENT ON COLUMN "public"."reservas"."alta" IS 'Alta'`,
      `${T} ADD COLUMN "num" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL`,
      `${T} ADD CONSTRAINT "reservas_pkey" PRIMARY KEY ("id", "n")`,
      `${T} ADD CONSTRAINT "uq_nombre" UNIQUE ("nombre", "estado")`,
      `CREATE INDEX "idx_n" ON "public"."reservas" ("n")`
    ])
  })

  it('acepta tipos de PostgreSQL y rechaza fragmentos peligrosos', () => {
    const typeIssues = (dataType: string) =>
      validateDesign('postgres', table, design((d) => (d.columns[4]!.dataType = dataType))).filter((i) => i.field === 'dataType')
    for (const t of ['integer[]', 'character varying(10)[]', 'public.mood', '"MiTipo"', 'timestamp(3) with time zone', 'double precision']) {
      expect(typeIssues(t), t).toEqual([])
    }
    expect(typeIssues('int; DROP TABLE x')).toHaveLength(1)
    expect(checkSqlFragment("'a'::text", 'postgres')).toBeNull()
    expect(checkSqlFragment('$$x$$', 'postgres')).toMatch(/\$\$/)
    expect(checkSqlFragment("E'\\'' ; '", 'postgres')).toBe('No puede llevar «;»')
    expect(checkSqlFragment('a # b', 'postgres')).toBeNull()
  })

  it('la columna calculada solo se renombra o se borra', () => {
    const issues = validateDesign('postgres', table, design((d) => (d.columns[3]!.dataType = 'numeric(12,2)')))
    expect(issues).toEqual([expect.objectContaining({ field: 'dataType', message: 'Columna calculada: solo se puede renombrar o borrar' })])
  })
})

describe('tipos devueltos por el driver', () => {
  const parse = (oid: number, value: string) => PG_TYPES.getTypeParser(oid, 'text')(value)

  it('números y booleanos como tales; bigint grande, numeric, fechas, arrays y JSON como texto', () => {
    expect(parse(16, 't')).toBe(true)
    expect(parse(23, '42')).toBe(42)
    expect(parse(20, '9007199254740993')).toBe('9007199254740993')
    expect(parse(701, '1.5')).toBe(1.5)
    expect(parse(1700, '1234.50')).toBe('1234.50')
    expect(parse(1114, '2026-10-25 13:45:01.123456')).toBe('2026-10-25 13:45:01.123456')
    expect(parse(1007, '{1,2}')).toBe('{1,2}')
    expect(parse(3802, '{"a": 1}')).toBe('{"a": 1}')
    expect(parse(17, '\\xcafe')).toEqual(Buffer.from([0xca, 0xfe]))
  })
})
