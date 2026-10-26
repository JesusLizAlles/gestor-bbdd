import { describe, expect, it } from 'vitest'
import { suggest, tokenize } from '@shared/filter'

const columns = [
  { name: 'id', dataType: 'int' },
  { name: 'estado', dataType: 'varchar(20)' },
  { name: 'fecha_entrada', dataType: 'date' },
  { name: 'importe', dataType: 'decimal(10,2)' }
]
const TODAY = '2026-10-26'

const types = (text: string, engine: 'mysql' | 'mssql' = 'mysql') =>
  tokenize(text, engine, columns.map((c) => c.name))
    .filter((t) => t.type !== 'space')
    .map((t) => [t.text, t.type])

const labels = (text: string, engine: 'mysql' | 'mssql' = 'mysql', cursor = text.length) =>
  suggest(text, cursor, engine, columns, TODAY).items.map((s) => s.label)

describe('tokenize', () => {
  it('distingue columnas, palabras clave, cadenas, números y funciones', () => {
    expect(types("estado = 'confirmada' AND importe >= 10.5 OR DATE(fecha_entrada) IS NULL")).toEqual([
      ['estado', 'column'],
      ['=', 'operator'],
      ["'confirmada'", 'string'],
      ['AND', 'keyword'],
      ['importe', 'column'],
      ['>=', 'operator'],
      ['10.5', 'number'],
      ['OR', 'keyword'],
      ['DATE', 'function'],
      ['(', 'operator'],
      ['fecha_entrada', 'column'],
      [')', 'operator'],
      ['IS', 'keyword'],
      ['NULL', 'keyword']
    ])
  })

  it('respeta escapes y comillas de cada motor', () => {
    expect(types("a = 'it''s' AND b = \"x\\\"y\"")).toEqual([
      ['a', 'ident'],
      ['=', 'operator'],
      ["'it''s'", 'string'],
      ['AND', 'keyword'],
      ['b', 'ident'],
      ['=', 'operator'],
      ['"x\\"y"', 'string']
    ])
    expect(types("[estado] = N'ñ' -- nota", 'mssql')).toEqual([
      ['[estado]', 'column'],
      ['=', 'operator'],
      ["N'ñ'", 'string'],
      ['-- nota', 'comment']
    ])
  })

  it('marca las cadenas sin cerrar', () => {
    const last = tokenize("estado = 'conf", 'mysql').at(-1)!
    expect(last).toMatchObject({ type: 'string', open: true })
  })
})

describe('suggest', () => {
  it('al empezar propone columnas y funciones, filtradas por lo escrito', () => {
    expect(labels('')).toEqual(expect.arrayContaining(['id', 'estado', 'NOT', 'CURDATE']))
    expect(labels('est')).toEqual(['estado'])
    expect(labels('importe > 1 AND fe')).toEqual(['fecha_entrada'])
  })

  it('tras una columna propone comparadores', () => {
    expect(labels('estado ')).toEqual(expect.arrayContaining(['=', 'LIKE', 'IN', 'IS NULL', 'BETWEEN']))
    expect(labels('estado li')).toEqual(['LIKE'])
  })

  it('tras un comparador de una fecha propone fechas', () => {
    const items = suggest('fecha_entrada >= ', 17, 'mysql', columns, TODAY).items
    expect(items[0]).toMatchObject({ insert: "'2026-10-26'", detail: 'hoy' })
    expect(items.map((s) => s.label)).toContain('CURDATE()')
    expect(labels('fecha_entrada >= ', 'mssql')).toContain('CAST(GETDATE() AS date)')
  })

  it('tras un valor propone AND / OR, y dentro de BETWEEN solo AND', () => {
    expect(labels("estado = 'x' ")).toEqual(['AND', 'OR'])
    expect(labels('importe BETWEEN 1 ')).toEqual(['AND'])
    expect(labels('importe IS ')).toEqual(['NULL', 'NOT NULL'])
    expect(labels('importe IS NOT ')).toEqual(['NULL'])
  })

  it('no sugiere dentro de cadenas, comentarios ni números', () => {
    expect(labels("estado = 'con")).toEqual([])
    expect(labels('importe > 10')).toEqual([])
    expect(labels('id = 1 /* es')).toEqual([])
  })

  it('sustituye la palabra completa bajo el cursor', () => {
    const r = suggest('esta = 1', 2, 'mysql', columns, TODAY)
    expect(r).toMatchObject({ from: 0, to: 4, prefix: 'es' })
  })

  it('las plantillas dejan el cursor en su sitio', () => {
    const like = suggest('estado ', 7, 'mysql', columns, TODAY).items.find((s) => s.label === 'LIKE')!
    expect(like.insert.slice(0, like.caret)).toBe("LIKE '%")
  })

  it('cita los nombres de columna que lo necesitan', () => {
    const items = suggest('', 0, 'mssql', [{ name: 'Fecha alta', dataType: 'datetime' }], TODAY).items
    expect(items[0]).toMatchObject({ label: 'Fecha alta', insert: '[Fecha alta]' })
  })
})
