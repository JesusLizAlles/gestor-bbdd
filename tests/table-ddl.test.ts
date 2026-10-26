import { describe, expect, it } from 'vitest'
import {
  buildAlterStatements,
  checkSqlFragment,
  designFromStructure,
  diffDesign,
  hasDesignChanges,
  renameColumn,
  unwrapParens,
  validateDesign
} from '@shared/table-ddl'
import type { ColumnInfo, TableDesign, TableStructure } from '@shared/types'
import { mysqlDefault } from '../src/main/drivers/mysql'

const col = (name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  dataType,
  nullable: true,
  isPrimaryKey: false,
  defaultValue: null,
  autoIncrement: false,
  ...extra
})

const mysqlTable: TableStructure = {
  columns: [
    col('id', 'int(11)', { nullable: false, isPrimaryKey: true, autoIncrement: true }),
    col('nombre', 'varchar(40)', { nullable: false, collation: 'utf8mb4_spanish_ci', comment: 'Nombre del cliente' }),
    col('estado', 'varchar(10)', { nullable: false, defaultValue: "'nuevo'", collation: 'utf8mb4_general_ci' }),
    col('modificado', 'timestamp', { nullable: false, defaultValue: 'current_timestamp()', onUpdate: 'current_timestamp()' }),
    col('total', 'decimal(10,2)', { generated: { expression: '`importe` * 2', stored: false } }),
    col('nota', 'text', { collation: 'utf8mb4_general_ci' })
  ],
  indexes: [
    { name: 'PRIMARY', columns: ['id'], unique: true, primary: true },
    { name: 'idx_estado', columns: ['estado'], unique: false, primary: false },
    { name: 'uq_nombre', columns: ['nombre'], unique: true, primary: false }
  ],
  foreignKeys: [{ name: 'fk_cliente', columns: ['id'], refDatabase: 'hotel', refSchema: null, refTable: 'otra', refColumns: ['id'] }],
  ddl: null
}
const myRef = { database: 'hotel', schema: null, table: 'clientes' }

const mssqlTable: TableStructure = {
  columns: [
    col('Id', 'int', { nullable: false, isPrimaryKey: true, autoIncrement: true }),
    col('Codigo', 'nvarchar(20)', { nullable: false, collation: 'Modern_Spanish_CI_AS' }),
    col('Alta', 'datetime2(7)', { nullable: false, defaultValue: 'getdate()', defaultConstraint: 'DF__Clientes__Alta__1A2B' }),
    col('Saldo', 'decimal(18,2)', { defaultValue: '0', defaultConstraint: 'DF_Saldo' })
  ],
  indexes: [
    { name: 'PK_Clientes', columns: ['Id'], unique: true, primary: true, uniqueConstraint: false },
    { name: 'IX_Codigo', columns: ['Codigo'], unique: false, primary: false, uniqueConstraint: false },
    { name: 'UQ_Codigo_Saldo', columns: ['Codigo', 'Saldo'], unique: true, primary: false, uniqueConstraint: true }
  ],
  foreignKeys: [],
  ddl: null
}
const msRef = { database: 'SAGE', schema: 'dbo', table: 'Clientes' }

const edit = (s: TableStructure, change: (d: TableDesign) => TableDesign | void): TableDesign => {
  const d = designFromStructure(s)
  return change(d) ?? d
}
const newColumn = (name: string, dataType: string, extra: Partial<TableDesign['columns'][number]> = {}) => ({
  original: null,
  name,
  dataType,
  nullable: true,
  defaultValue: null,
  autoIncrement: false,
  primaryKey: false,
  comment: null,
  ...extra
})

describe('Editor de estructura: MySQL', () => {
  it('sin cambios no genera nada', () => {
    const d = designFromStructure(mysqlTable)
    expect(hasDesignChanges(diffDesign(mysqlTable, d))).toBe(false)
    expect(buildAlterStatements('mysql', myRef, mysqlTable, d)).toEqual([])
  })

  it('renombrar y cambiar el tipo conserva intercalación, comentario, ON UPDATE y valor por defecto', () => {
    const d = edit(mysqlTable, (d) => {
      d.columns[1]!.dataType = 'varchar(120)'
      d.columns[3]!.name = 'actualizado'
      return renameColumn(d, 1, 'nombre_completo')
    })
    expect(buildAlterStatements('mysql', myRef, mysqlTable, d)).toEqual([
      'ALTER TABLE `hotel`.`clientes`\n' +
        "  CHANGE COLUMN `nombre` `nombre_completo` varchar(120) COLLATE utf8mb4_spanish_ci NOT NULL COMMENT 'Nombre del cliente',\n" +
        '  CHANGE COLUMN `modificado` `actualizado` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()'
    ])
  })

  it('pasar a un tipo que no es texto quita la intercalación; quitar el valor por defecto y el comentario', () => {
    const d = edit(mysqlTable, (d) => {
      d.columns[2]!.dataType = 'int'
      d.columns[2]!.defaultValue = '0'
      d.columns[1]!.comment = null
    })
    expect(buildAlterStatements('mysql', myRef, mysqlTable, d)).toEqual([
      'ALTER TABLE `hotel`.`clientes`\n' +
        '  CHANGE COLUMN `nombre` `nombre` varchar(40) COLLATE utf8mb4_spanish_ci NOT NULL,\n' +
        '  CHANGE COLUMN `estado` `estado` int NOT NULL DEFAULT 0'
    ])
  })

  it('una columna calculada solo se renombra (y conserva su expresión)', () => {
    const renamed = edit(mysqlTable, (d) => {
      d.columns[4]!.name = 'doble'
    })
    expect(buildAlterStatements('mysql', myRef, mysqlTable, renamed)[0]).toContain(
      'CHANGE COLUMN `total` `doble` decimal(10,2) GENERATED ALWAYS AS (`importe` * 2) VIRTUAL'
    )
    const retyped = edit(mysqlTable, (d) => {
      d.columns[4]!.dataType = 'int'
    })
    expect(validateDesign('mysql', mysqlTable, retyped)).toEqual([
      { scope: 'column', index: 4, field: 'dataType', message: 'Columna calculada: solo se puede renombrar o borrar' }
    ])
  })

  it('altas, bajas, clave primaria, índices y claves foráneas en el orden correcto', () => {
    const d = edit(mysqlTable, (d) => {
      d.columns.splice(5, 1) // nota
      d.columns.push(newColumn('email', 'varchar(150)', { nullable: false, defaultValue: "''", comment: "del cliente's" }))
      d.columns.push(newColumn('codigo', 'char(5)', { nullable: false, primaryKey: true }))
      d.indexes[0]!.columns = ['estado', 'email'] // idx_estado cambia
      d.indexes.splice(1, 1) // uq_nombre se borra
      d.indexes.push({ original: null, name: 'uq_email', columns: ['email'], unique: true })
      d.dropForeignKeys = ['fk_cliente']
    })
    expect(buildAlterStatements('mysql', myRef, mysqlTable, d)).toEqual([
      'ALTER TABLE `hotel`.`clientes`\n  DROP FOREIGN KEY `fk_cliente`',
      'ALTER TABLE `hotel`.`clientes`\n' +
        '  DROP INDEX `uq_nombre`,\n' +
        '  DROP INDEX `idx_estado`,\n' +
        '  DROP PRIMARY KEY,\n' +
        '  DROP COLUMN `nota`,\n' +
        "  ADD COLUMN `email` varchar(150) NOT NULL DEFAULT '' COMMENT 'del cliente''s',\n" +
        '  ADD COLUMN `codigo` char(5) NOT NULL,\n' +
        '  ADD PRIMARY KEY (`id`, `codigo`),\n' +
        '  ADD INDEX `idx_estado` (`estado`, `email`),\n' +
        '  ADD UNIQUE INDEX `uq_email` (`email`)'
    ])
  })

  it('renombrar una columna no cambia los índices ni la clave que la usan', () => {
    const d = edit(mysqlTable, (d) => renameColumn(renameColumn(d, 0, 'cliente_id'), 2, 'situacion'))
    expect(d.indexes[0]!.columns).toEqual(['situacion'])
    const diff = diffDesign(mysqlTable, d)
    expect(diff.pkChanged).toBe(false)
    expect(diff.changedIndexes).toEqual([])
    expect(buildAlterStatements('mysql', myRef, mysqlTable, d)).toHaveLength(1)
  })

  it('valida nombres, tipos, valores por defecto e índices', () => {
    const d = edit(mysqlTable, (d) => {
      d.columns[1]!.name = 'ESTADO'
      d.indexes[1]!.columns = ['ESTADO']
      d.columns[3]!.dataType = 'int; DROP TABLE x'
      d.columns[5]!.defaultValue = "'a' -- comentario"
      d.columns.push(newColumn('', 'int'))
      d.columns.push(newColumn('n', 'int', { primaryKey: true, nullable: true }))
      d.columns.push(newColumn('m', 'int', { autoIncrement: true, defaultValue: '1' }))
      d.indexes.push({ original: null, name: 'primary', columns: ['no_existe'], unique: false })
      d.indexes.push({ original: null, name: 'idx_estado', columns: [], unique: false })
    })
    expect(validateDesign('mysql', mysqlTable, d).map((i) => `${i.scope}${i.index}.${i.field}: ${i.message}`)).toEqual([
      'column1.name: Nombre repetido',
      'column2.name: Nombre repetido',
      'column3.dataType: Tipo no válido',
      'column5.defaultValue: No puede llevar comentarios',
      'column6.name: Falta el nombre',
      'column7.nullable: La clave primaria no admite nulos',
      'column8.defaultValue: Una columna autoincremental no lleva valor por defecto',
      'index0.name: Nombre repetido',
      'index2.name: PRIMARY está reservado para la clave primaria',
      'index2.columns: No existe la columna no_existe',
      'index3.name: Nombre repetido',
      'index3.columns: Indica al menos una columna'
    ])
    expect(() => buildAlterStatements('mysql', myRef, mysqlTable, d)).toThrow('ESTADO: Nombre repetido')
  })
})

describe('Editor de estructura: SQL Server', () => {
  it('renombrar con sp_rename y cambiar el tipo rehace los índices y la clave que dependen de la columna', () => {
    const d = edit(mssqlTable, (d) => {
      d.columns[1]!.dataType = 'nvarchar(40)'
      return renameColumn(d, 1, "Código'")
    })
    expect(buildAlterStatements('mssql', msRef, mssqlTable, d)).toEqual([
      'DROP INDEX [IX_Codigo] ON [SAGE].[dbo].[Clientes]',
      'ALTER TABLE [SAGE].[dbo].[Clientes] DROP CONSTRAINT [UQ_Codigo_Saldo]',
      "EXEC [SAGE].sys.sp_rename N'[dbo].[Clientes].[Codigo]', N'Código''', 'COLUMN'",
      "ALTER TABLE [SAGE].[dbo].[Clientes] ALTER COLUMN [Código'] nvarchar(40) COLLATE Modern_Spanish_CI_AS NOT NULL",
      "CREATE INDEX [IX_Codigo] ON [SAGE].[dbo].[Clientes] ([Código'])",
      "ALTER TABLE [SAGE].[dbo].[Clientes] ADD CONSTRAINT [UQ_Codigo_Saldo] UNIQUE ([Código'], [Saldo])"
    ])
  })

  it('cambiar el tipo de la clave primaria la quita y la vuelve a crear con el mismo nombre', () => {
    const d = edit(mssqlTable, (d) => {
      d.columns[0]!.dataType = 'bigint'
    })
    expect(buildAlterStatements('mssql', msRef, mssqlTable, d)).toEqual([
      'ALTER TABLE [SAGE].[dbo].[Clientes] DROP CONSTRAINT [PK_Clientes]',
      'ALTER TABLE [SAGE].[dbo].[Clientes] ALTER COLUMN [Id] bigint NOT NULL',
      'ALTER TABLE [SAGE].[dbo].[Clientes] ADD CONSTRAINT [PK_Clientes] PRIMARY KEY ([Id])'
    ])
  })

  it('valores por defecto: se quita la restricción con su nombre y se crea otra', () => {
    const d = edit(mssqlTable, (d) => {
      d.columns[2]!.defaultValue = 'sysdatetime()'
      d.columns[3]!.defaultValue = null
    })
    expect(buildAlterStatements('mssql', msRef, mssqlTable, d)).toEqual([
      'ALTER TABLE [SAGE].[dbo].[Clientes] DROP CONSTRAINT [DF__Clientes__Alta__1A2B]',
      'ALTER TABLE [SAGE].[dbo].[Clientes] ADD DEFAULT sysdatetime() FOR [Alta]',
      'ALTER TABLE [SAGE].[dbo].[Clientes] DROP CONSTRAINT [DF_Saldo]'
    ])
  })

  it('cambiar el tipo de una columna con DEFAULT quita la restricción y la vuelve a poner', () => {
    const d = edit(mssqlTable, (d) => {
      d.columns[3]!.dataType = 'money'
    })
    expect(buildAlterStatements('mssql', msRef, mssqlTable, d)).toEqual([
      'ALTER TABLE [SAGE].[dbo].[Clientes] DROP CONSTRAINT [UQ_Codigo_Saldo]',
      'ALTER TABLE [SAGE].[dbo].[Clientes] DROP CONSTRAINT [DF_Saldo]',
      'ALTER TABLE [SAGE].[dbo].[Clientes] ALTER COLUMN [Saldo] money NULL',
      'ALTER TABLE [SAGE].[dbo].[Clientes] ADD DEFAULT 0 FOR [Saldo]',
      'ALTER TABLE [SAGE].[dbo].[Clientes] ADD CONSTRAINT [UQ_Codigo_Saldo] UNIQUE ([Codigo], [Saldo])'
    ])
  })

  it('borrar una columna quita antes su DEFAULT; las nuevas llevan IDENTITY y DEFAULT en línea', () => {
    const d = edit(mssqlTable, (d) => {
      d.columns.splice(3, 1)
      d.indexes.splice(1, 1)
      d.columns.push(newColumn('Activo', 'bit', { nullable: false, defaultValue: '1' }))
      d.indexes.push({ original: null, name: 'IX_Activo', columns: ['Activo'], unique: false })
    })
    expect(buildAlterStatements('mssql', msRef, mssqlTable, d)).toEqual([
      'ALTER TABLE [SAGE].[dbo].[Clientes] DROP CONSTRAINT [UQ_Codigo_Saldo]',
      'ALTER TABLE [SAGE].[dbo].[Clientes] DROP CONSTRAINT [DF_Saldo]',
      'ALTER TABLE [SAGE].[dbo].[Clientes] DROP COLUMN [Saldo]',
      'ALTER TABLE [SAGE].[dbo].[Clientes] ADD [Activo] bit NOT NULL DEFAULT 1',
      'CREATE INDEX [IX_Activo] ON [SAGE].[dbo].[Clientes] ([Activo])'
    ])
  })

  it('no deja poner ni quitar IDENTITY en una columna existente', () => {
    const d = edit(mssqlTable, (d) => {
      d.columns[0]!.autoIncrement = false
    })
    expect(validateDesign('mssql', mssqlTable, d)).toEqual([
      { scope: 'column', index: 0, field: 'autoIncrement', message: 'SQL Server no permite poner o quitar IDENTITY en una columna existente' }
    ])
  })
})

describe('Fragmentos SQL', () => {
  it('acepta expresiones normales y rechaza varias sentencias, comentarios y comillas o paréntesis sin cerrar', () => {
    expect(checkSqlFragment("'a;b' -- dentro de comillas no cuenta", 'mysql')).toBe('No puede llevar comentarios')
    expect(checkSqlFragment("'a;b--'", 'mysql')).toBeNull()
    expect(checkSqlFragment("concat('it''s', 'x\\'y')", 'mysql')).toBeNull()
    expect(checkSqlFragment('[a;b]', 'mssql')).toBeNull()
    expect(checkSqlFragment('0; DROP TABLE t', 'mysql')).toBe('No puede llevar «;»')
    expect(checkSqlFragment("'sin cerrar", 'mssql')).toBe('Hay comillas sin cerrar')
    expect(checkSqlFragment('now(', 'mysql')).toBe('Paréntesis sin cerrar')
    expect(checkSqlFragment('1)', 'mysql')).toBe('Paréntesis sin abrir')
    expect(checkSqlFragment('1 # x', 'mysql')).toBe('No puede llevar comentarios')
  })

  it('quita los paréntesis que envuelven el DEFAULT de SQL Server', () => {
    expect(unwrapParens('((0))')).toBe('0')
    expect(unwrapParens("(N'a)(b')")).toBe("N'a)(b'")
    expect(unwrapParens('(getdate())')).toBe('getdate()')
    expect(unwrapParens('((1)+(2))')).toBe('(1)+(2)')
  })

  it('MySQL: COLUMN_DEFAULT como expresión en MySQL y MariaDB', () => {
    expect(mysqlDefault(null, '', 'int', false)).toBeNull()
    expect(mysqlDefault('nuevo', '', 'varchar(10)', false)).toBe("'nuevo'")
    expect(mysqlDefault("it's", '', 'varchar(10)', false)).toBe("'it''s'")
    expect(mysqlDefault('0', '', 'int', false)).toBe('0')
    expect(mysqlDefault('0', '', 'varchar(3)', false)).toBe("'0'")
    expect(mysqlDefault('CURRENT_TIMESTAMP', 'DEFAULT_GENERATED', 'timestamp', false)).toBe('CURRENT_TIMESTAMP')
    expect(mysqlDefault('uuid()', 'DEFAULT_GENERATED', 'char(36)', false)).toBe('(uuid())')
    expect(mysqlDefault("b'1'", '', 'bit(1)', false)).toBe("b'1'")
    expect(mysqlDefault("'nuevo'", '', 'varchar(10)', true)).toBe("'nuevo'")
    expect(mysqlDefault('NULL', '', 'varchar(10)', true)).toBeNull()
  })
})
