import { describe, expect, it } from 'vitest'
import { tableAliases } from '@shared/completion'

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
