import { describe, expect, it, vi } from 'vitest'
import { COMPLETION_COLUMN_LIMIT, completionColumns, tableAliases } from '@shared/completion'
import type { CompletionColumn } from '@shared/types'

const entries = (sql: string) => Object.fromEntries(tableAliases(sql))

describe('tableAliases', () => {
  it('reconoce tablas con y sin alias, con AS y en JOIN', () => {
    expect(entries('SELECT r. FROM reservas r JOIN clientes AS c ON c.id = r.cliente_id')).toEqual({
      reservas: 'reservas',
      r: 'reservas',
      clientes: 'clientes',
      c: 'clientes'
    })
  })

  it('quita comillas y cualificación bd.esquema', () => {
    expect(entries('SELECT * FROM `hotel`.`reservas` res')).toEqual({ reservas: 'reservas', res: 'reservas' })
    expect(entries('SELECT * FROM [SAGE].[dbo].[Clientes] cli WHERE 1=1')).toEqual({ clientes: 'Clientes', cli: 'Clientes' })
  })

  it('no toma palabras clave como alias', () => {
    expect(entries('SELECT * FROM reservas WHERE id = 1')).toEqual({ reservas: 'reservas' })
    expect(entries('SELECT * FROM a LEFT JOIN b ON a.id = b.id')).toEqual({ a: 'a', b: 'b' })
  })

  it('incluye UPDATE e INSERT INTO', () => {
    expect(entries('UPDATE reservas SET x = 1')).toEqual({ reservas: 'reservas' })
    expect(entries('INSERT INTO log (a) VALUES (1)')).toEqual({ log: 'log' })
  })
})

describe('completionColumns', () => {
  const col = (table: string, column: string, schema: string | null = 'dbo'): CompletionColumn => ({ schema, table, column, dataType: 'int' })
  // Carga inicial recortada justo en el límite: la última tabla, «Clientes», viene a medias.
  const truncated = [
    ...Array.from({ length: COMPLETION_COLUMN_LIMIT - 1 }, (_, i) => col('Albaranes', `c${i}`)),
    col('Clientes', 'Codigo')
  ]
  const tables = [
    { name: 'Albaranes', schema: 'dbo' },
    { name: 'Clientes', schema: 'dbo' },
    { name: 'Proveedores', schema: 'dbo' },
    { name: 'Proveedores', schema: 'hist' }
  ]

  it('si la carga inicial cabe entera, no pide nada', async () => {
    const fetch = vi.fn()
    const store = completionColumns(tables, [col('Clientes', 'Codigo')], fetch)
    await store.ensureColumns(['Proveedores'])
    expect(fetch).not.toHaveBeenCalled()
    expect(store.columns).toHaveLength(1)
  })

  it('si viene recortada, pide las tablas que faltan (de todos los esquemas) y la que llegó a medias', async () => {
    const fetch = vi.fn(async (t: { name: string; schema: string | null }) => [col(t.name, 'Nombre', t.schema)])
    const store = completionColumns(tables, truncated, fetch)
    expect(store.columns.some((c) => c.table === 'Clientes')).toBe(false)
    await store.ensureColumns(['proveedores', 'Clientes', 'Albaranes', 'p'])
    expect(fetch.mock.calls.map(([t]) => `${t.schema}.${t.name}`).sort()).toEqual(['dbo.Clientes', 'dbo.Proveedores', 'hist.Proveedores'])
    expect(store.columns.filter((c) => c.column === 'Nombre')).toHaveLength(3)
  })

  it('comparte las peticiones en curso y no repite las ya cargadas', async () => {
    const fetch = vi.fn(async (t: { name: string; schema: string | null }) => [col(t.name, 'Nombre', t.schema)])
    const store = completionColumns(tables.slice(0, 2), truncated, fetch)
    await Promise.all([store.ensureColumns(['Clientes']), store.ensureColumns(['clientes'])])
    await store.ensureColumns(['Clientes'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('tras un fallo lo vuelve a intentar', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('sin conexión')).mockResolvedValue([col('Clientes', 'Nombre')])
    const store = completionColumns(tables.slice(0, 2), truncated, fetch)
    await store.ensureColumns(['Clientes'])
    expect(store.columns.some((c) => c.table === 'Clientes')).toBe(false)
    await store.ensureColumns(['Clientes'])
    expect(store.columns.some((c) => c.table === 'Clientes')).toBe(true)
  })
})
