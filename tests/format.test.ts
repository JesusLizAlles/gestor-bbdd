import { describe, expect, it } from 'vitest'
import { guessTableName, qualifiedName, quoteIdent, toCsv, toJson, toSqlInserts } from '@shared/format'
import type { QueryResult } from '@shared/types'

const result: QueryResult = {
  statement: 'SELECT id, nombre, nota, activo FROM `hotel`.`clientes` WHERE id < 3',
  columns: [
    { name: 'id', type: 'LONG' },
    { name: 'nombre', type: 'VAR_STRING' },
    { name: 'nota', type: 'VAR_STRING' },
    { name: 'activo', type: 'TINY' }
  ],
  rows: [
    [1, 'Ana; "la jefa"', null, true],
    [2, "O'Brien\\x", 'línea1\nlínea2', false]
  ],
  affectedRows: null,
  truncated: false,
  durationMs: 1
}

describe('quoteIdent / qualifiedName', () => {
  it('escapa el carácter de cierre de cada motor', () => {
    expect(quoteIdent('a`b', 'mysql')).toBe('`a``b`')
    expect(quoteIdent('a]b', 'mssql')).toBe('[a]]b]')
  })

  it('SQL Server incluye el esquema (dbo por defecto)', () => {
    expect(qualifiedName('mysql', 'hotel', { schema: null, name: 'clientes' })).toBe('`hotel`.`clientes`')
    expect(qualifiedName('mssql', 'SAGE', { schema: null, name: 'Clientes' })).toBe('[SAGE].[dbo].[Clientes]')
    expect(qualifiedName('mssql', 'SAGE', { schema: 'ventas', name: 'Facturas' })).toBe('[SAGE].[ventas].[Facturas]')
  })
})

describe('toCsv', () => {
  it('sigue RFC 4180', () => {
    expect(toCsv(result)).toBe(
      'id,nombre,nota,activo\r\n1,"Ana; ""la jefa""",,true\r\n2,O\'Brien\\x,"línea1\nlínea2",false\r\n'
    )
  })

  it('modo Excel: punto y coma y BOM', () => {
    const csv = toCsv(result, { excel: true })
    expect(csv.startsWith('﻿id;nombre;nota;activo\r\n')).toBe(true)
    expect(csv).toContain('1;"Ana; ""la jefa""";;true')
  })
})

describe('toJson', () => {
  it('genera objetos y renombra columnas repetidas', () => {
    const dup: QueryResult = { ...result, columns: [{ name: 'a', type: '' }, { name: 'a', type: '' }], rows: [[1, 2]] }
    expect(JSON.parse(toJson(dup))).toEqual([{ a: 1, a_2: 2 }])
    expect(JSON.parse(toJson(result))[0]).toEqual({ id: 1, nombre: 'Ana; "la jefa"', nota: null, activo: true })
  })
})

describe('toSqlInserts', () => {
  it('MySQL: escapa comillas y barras, usa la tabla del FROM', () => {
    expect(toSqlInserts(result, 'mysql').split('\n')[1]).toBe(
      "INSERT INTO `hotel`.`clientes` (`id`, `nombre`, `nota`, `activo`) VALUES (2, 'O''Brien\\\\x', 'línea1\nlínea2', 0);".split('\n')[0]
    )
  })

  it('SQL Server: literales N\'…\' sin escapar barras', () => {
    const out = toSqlInserts({ ...result, statement: 'SELECT * FROM [dbo].[Clientes]' }, 'mssql')
    expect(out.split('\n')[0]).toBe(`INSERT INTO [dbo].[Clientes] ([id], [nombre], [nota], [activo]) VALUES (1, N'Ana; "la jefa"', NULL, 1);`)
    expect(out).toContain("N'O''Brien\\x'")
  })

  it('adivina tablas con y sin comillas', () => {
    expect(guessTableName('select * from clientes c')).toBe('clientes')
    expect(guessTableName('SELECT * FROM SAGE.dbo.Clientes')).toBe('SAGE.dbo.Clientes')
    expect(guessTableName('SELECT * FROM [SAGE] . [dbo].[Clientes]')).toBe('[SAGE].[dbo].[Clientes]')
    expect(guessTableName('SELECT 1')).toBeNull()
  })
})
