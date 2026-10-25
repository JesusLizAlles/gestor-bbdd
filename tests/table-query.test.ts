import { describe, expect, it } from 'vitest'
import {
  buildCountQuery,
  buildDelete,
  buildInsert,
  buildPageQuery,
  buildUpdate,
  equalsCondition,
  mssqlDateParam,
  previewDelete,
  previewInsert,
  previewUpdate,
  validateWhere
} from '@shared/table-query'

const my = { database: 'hotel', schema: null, table: 'reservas' }
const ms = { database: 'SAGE', schema: 'dbo', table: 'Clientes' }

describe('buildPageQuery', () => {
  it('MySQL: LIMIT con una fila extra y orden por clave primaria por defecto', () => {
    expect(buildPageQuery('mysql', my, { where: null, sort: [], fallbackOrder: ['id'], offset: 500, limit: 500 })).toBe(
      'SELECT * FROM `hotel`.`reservas` ORDER BY `id` LIMIT 501 OFFSET 500'
    )
  })

  it('MySQL: orden del usuario y filtro entre paréntesis', () => {
    expect(
      buildPageQuery('mysql', my, {
        where: "estado = 'confirmada'",
        sort: [{ column: 'importe', direction: 'desc' }],
        fallbackOrder: ['id'],
        offset: 0,
        limit: 100
      })
    ).toBe("SELECT * FROM `hotel`.`reservas` WHERE (estado = 'confirmada'\n) ORDER BY `importe` DESC LIMIT 101 OFFSET 0")
  })

  it('SQL Server: OFFSET/FETCH y ORDER BY (SELECT NULL) si no hay clave', () => {
    expect(buildPageQuery('mssql', ms, { where: null, sort: [], fallbackOrder: [], offset: 0, limit: 100 })).toBe(
      'SELECT * FROM [SAGE].[dbo].[Clientes] ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 101 ROWS ONLY'
    )
  })

  it('escapa nombres de columna maliciosos en el orden', () => {
    const sql = buildPageQuery('mysql', my, {
      where: null,
      sort: [{ column: 'x`; DROP TABLE t; --', direction: 'asc' }],
      fallbackOrder: [],
      offset: 0,
      limit: 1
    })
    expect(sql).toContain('ORDER BY `x``; DROP TABLE t; --` ASC')
  })

  it('normaliza offset y límite', () => {
    expect(buildPageQuery('mysql', my, { where: null, sort: [], fallbackOrder: [], offset: -5.7, limit: 0 })).toBe(
      'SELECT * FROM `hotel`.`reservas` LIMIT 2 OFFSET 0'
    )
  })
})

describe('buildCountQuery', () => {
  it('cuenta con y sin filtro', () => {
    expect(buildCountQuery('mssql', ms, null)).toBe('SELECT COUNT(*) AS total FROM [SAGE].[dbo].[Clientes]')
    expect(buildCountQuery('mysql', my, 'id > 3')).toBe('SELECT COUNT(*) AS total FROM `hotel`.`reservas` WHERE (id > 3\n)')
  })
})

describe('validateWhere', () => {
  it.each(["estado = 'confirmada'", 'id IN (SELECT cliente_id FROM clientes)', "nota LIKE '%;%'", 'importe > 100 -- comentario'])(
    'acepta: %s',
    (where) => expect(validateWhere(where, 'mysql')).toBe(where)
  )

  it('vacío = sin filtro', () => {
    expect(validateWhere('   ', 'mysql')).toBeNull()
    expect(validateWhere(undefined, 'mssql')).toBeNull()
  })

  it.each([
    '1=1; DELETE FROM reservas',
    '1=1) UNION SELECT * FROM mysql.user; --',
    "id = 1 OR (SELECT 1 INTO OUTFILE '/tmp/x')",
    'id = (UPDATE t SET a = 1)'
  ])('rechaza en MySQL: %s', (where) => expect(() => validateWhere(where, 'mysql')).toThrow(/única condición de lectura/))

  it.each(['1=1\nGO\nDROP TABLE Clientes', '1=1; EXEC xp_cmdshell', "1=1 DELETE FROM Clientes"])(
    'rechaza en SQL Server: %s',
    (where) => expect(() => validateWhere(where, 'mssql')).toThrow(/única condición de lectura/)
  )
})

describe('equalsCondition', () => {
  it('genera igualdades escapadas y IS NULL', () => {
    expect(equalsCondition('mysql', ['id', 'pais'], [3, "O'B"])).toBe("`id` = 3 AND `pais` = 'O''B'")
    expect(equalsCondition('mssql', ['Codigo'], [null])).toBe('[Codigo] IS NULL')
    expect(equalsCondition('mssql', ['Nombre'], ['Ana'])).toBe("[Nombre] = N'Ana'")
  })
})

describe('buildUpdate / previewUpdate', () => {
  const update = { key: [{ column: 'id', value: 7 }], set: [{ column: 'nombre', value: "O'Brien" }, { column: 'nota', value: null }] }

  it('MySQL: parámetros ? en SET y WHERE, en orden', () => {
    expect(buildUpdate('mysql', my, update)).toEqual({
      sql: 'UPDATE `hotel`.`reservas` SET `nombre` = ?, `nota` = ? WHERE `id` = ?',
      params: ["O'Brien", null, 7],
      label: 'la fila con id = 7'
    })
  })

  it('SQL Server: @pN numerados desde paramStart', () => {
    expect(buildUpdate('mssql', ms, update, 3)).toEqual({
      sql: 'UPDATE [SAGE].[dbo].[Clientes] SET [nombre] = @p3, [nota] = @p4 WHERE [id] = @p5',
      params: ["O'Brien", null, 7],
      label: 'la fila con id = 7'
    })
  })

  it('la vista previa muestra los valores escapados', () => {
    expect(previewUpdate('mysql', my, update)).toBe("UPDATE `hotel`.`reservas` SET `nombre` = 'O''Brien', `nota` = NULL WHERE `id` = 7")
  })
})

describe('mssqlDateParam', () => {
  it('usa la T de ISO 8601 solo en columnas datetime', () => {
    expect(mssqlDateParam('2026-07-01 10:30:00', 'datetime')).toBe('2026-07-01T10:30:00')
    expect(mssqlDateParam('2026-07-01 10:30:00.123', 'datetime2(3)')).toBe('2026-07-01T10:30:00.123')
    expect(mssqlDateParam('2026-07-01 10:30', 'nvarchar(50)')).toBe('2026-07-01 10:30')
    expect(mssqlDateParam('2026-07-01', 'date')).toBe('2026-07-01')
    expect(mssqlDateParam(5, 'datetime')).toBe(5)
  })
})

describe('buildInsert / buildDelete', () => {
  const set = [{ column: 'nombre', value: 'Nuevo' }, { column: 'nota', value: null }]

  it('INSERT con parámetros en ambos motores', () => {
    expect(buildInsert('mysql', my, set)).toEqual({
      sql: 'INSERT INTO `hotel`.`reservas` (`nombre`, `nota`) VALUES (?, ?)',
      params: ['Nuevo', null],
      label: 'la fila nueva'
    })
    expect(buildInsert('mssql', ms, set, 2, 'la fila nueva 1').sql).toBe('INSERT INTO [SAGE].[dbo].[Clientes] ([nombre], [nota]) VALUES (@p2, @p3)')
  })

  it('INSERT sin columnas usa todos los valores por defecto', () => {
    expect(buildInsert('mysql', my, []).sql).toBe('INSERT INTO `hotel`.`reservas` () VALUES ()')
    expect(buildInsert('mssql', ms, []).sql).toBe('INSERT INTO [SAGE].[dbo].[Clientes] DEFAULT VALUES')
  })

  it('DELETE por clave primaria compuesta', () => {
    const key = [{ column: 'hotel', value: 3 }, { column: 'fecha', value: '2026-07-01' }]
    expect(buildDelete('mssql', ms, key, 5)).toEqual({
      sql: 'DELETE FROM [SAGE].[dbo].[Clientes] WHERE [hotel] = @p5 AND [fecha] = @p6',
      params: [3, '2026-07-01'],
      label: 'la fila con hotel = 3, fecha = 2026-07-01'
    })
  })

  it('vistas previas con literales', () => {
    expect(previewInsert('mysql', my, set)).toBe("INSERT INTO `hotel`.`reservas` (`nombre`, `nota`) VALUES ('Nuevo', NULL)")
    expect(previewDelete('mssql', ms, [{ column: 'id', value: 4 }])).toBe('DELETE FROM [SAGE].[dbo].[Clientes] WHERE [id] = 4')
  })
})
