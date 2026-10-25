// Tests contra un SQL Server real. Se saltan si no hay variables de entorno:
//   TEST_MSSQL_HOST, TEST_MSSQL_PORT, TEST_MSSQL_USER, TEST_MSSQL_PASSWORD
//   TEST_MSSQL_DATABASE (opcional, por defecto master), TEST_MSSQL_TLS=1 (opcional)
// Solo usan tablas temporales (#tmp) y vistas del sistema: no modifican ninguna base de datos.
// Aun así, mejor contra un servidor de desarrollo.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDriver } from '../src/main/drivers'
import { SessionManager } from '../src/main/sessions'
import { KnownHosts } from '../src/main/ssh/known-hosts'
import { baseConfig } from './helpers'

const env = process.env
const enabled = Boolean(env.TEST_MSSQL_HOST && env.TEST_MSSQL_USER)
const database = env.TEST_MSSQL_DATABASE ?? 'master'

const config = baseConfig({
  engine: 'mssql',
  host: env.TEST_MSSQL_HOST ?? '127.0.0.1',
  port: Number(env.TEST_MSSQL_PORT ?? 1433),
  username: env.TEST_MSSQL_USER ?? '',
  database,
  tls: { enabled: env.TEST_MSSQL_TLS === '1', verifyServerCert: false }
})

describe.skipIf(!enabled)('SQL Server (integración)', () => {
  let dir: string
  let sessions: SessionManager
  let sessionId: string

  const run = async (sql: string, maxRows?: number) => {
    const out = await sessions.run(sessionId, { sql, database, maxRows })
    const failed = out.results.find((r) => r.error)
    if (failed) throw new Error(failed.error)
    return out.results
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-bbdd-ms-'))
    sessions = new SessionManager({ createDriver, knownHosts: new KnownHosts(dir) })
    const info = await sessions.open(config, { password: env.TEST_MSSQL_PASSWORD ?? '' })
    sessionId = info.sessionId
    expect(info.server.product).toMatch(/SQL Server|Azure/)
  })

  afterAll(async () => {
    await sessions?.closeAll()
    await rm(dir, { recursive: true, force: true })
  })

  it('las #temporales sobreviven entre ejecuciones (lotes, no sp_executesql)', async () => {
    await run(`
      CREATE TABLE #tipos (id INT PRIMARY KEY, grande BIGINT, importe DECIMAL(12,2), creado DATETIME2(3),
                           texto NVARCHAR(50), binario VARBINARY(8), nulo INT NULL);
      INSERT INTO #tipos VALUES (1, 9007199254740993, 1234.50, '2026-10-25T13:45:01.250', N'Mañana 🏨', 0xCAFE, NULL)
    `)
    const [result] = await run('SELECT grande, importe, creado, texto, binario, nulo FROM #tipos')
    expect(result!.columns.map((c) => c.name)).toEqual(['grande', 'importe', 'creado', 'texto', 'binario', 'nulo'])
    expect(result!.rows[0]).toEqual(['9007199254740993', 1234.5, '2026-10-25 13:45:01.250', 'Mañana 🏨', '0xCAFE', null])
  })

  it('un lote con varios SELECT devuelve varios resultados y columnas repetidas', async () => {
    const results = await run('IF 1 = 1 BEGIN SELECT 1 AS a, 2 AS a; SELECT 3 AS b; END')
    expect(results).toHaveLength(2)
    expect(results[0]!.columns.map((c) => c.name)).toEqual(['a', 'a'])
    expect(results[0]!.rows[0]).toEqual([1, 2])
  })

  it('corta en maxRows y deja la conexión usable', async () => {
    const [limited] = await run('SELECT TOP 200 o1.object_id FROM sys.all_objects o1 CROSS JOIN sys.all_objects o2', 25)
    expect(limited!.rows).toHaveLength(25)
    expect(limited!.truncated).toBe(true)
    const [after] = await run('SELECT 7 AS siete')
    expect(after!.rows[0]).toEqual([7])
  })

  it('cuenta filas afectadas', async () => {
    await run('CREATE TABLE #n (n INT)')
    const [res] = await run('INSERT INTO #n SELECT TOP 5 object_id FROM sys.all_objects')
    expect(res!.affectedRows).toBe(5)
  })

  it('cancela WAITFOR sin romper la conexión', async () => {
    const started = Date.now()
    const pending = sessions.run(sessionId, { sql: "WAITFOR DELAY '00:00:20'", database })
    await new Promise((r) => setTimeout(r, 400))
    await sessions.cancel(sessionId)
    const out = await pending
    expect(out.results[0]!.error).toMatch(/cancelada/)
    expect(Date.now() - started).toBeLessThan(5000)
    expect((await run('SELECT 1 AS uno'))[0]!.rows[0]).toEqual([1])
  })

  it('visor: pagina, cuenta y describe la primera tabla del catálogo (solo lectura)', async () => {
    const first = (await sessions.listTables(sessionId, database)).find((t) => t.kind === 'table')
    if (!first) return
    const ref = { database, schema: first.schema, table: first.name }
    const page = await sessions.fetchTableData(sessionId, { ...ref, offset: 0, limit: 5, sort: [] })
    expect(page.rows.length).toBeLessThanOrEqual(5)
    const total = await sessions.countTableRows(sessionId, ref)
    expect(page.hasMore).toBe(total > 5)
    const structure = await sessions.tableStructure(sessionId, ref)
    expect(structure.columns.length).toBe(page.columns.length)
    await expect(sessions.fetchTableData(sessionId, { ...ref, offset: 0, limit: 5, sort: [], where: '1=1; DROP TABLE x' })).rejects.toThrow(
      /única condición/
    )
  })

  it('edición: guarda en transacción y deshace todo si una fila ha desaparecido (tabla en tempdb)', async () => {
    const ref = { database: 'tempdb', schema: 'dbo', table: 'gestor_bbdd_edicion' }
    await run(`DROP TABLE IF EXISTS tempdb.dbo.gestor_bbdd_edicion;
      CREATE TABLE tempdb.dbo.gestor_bbdd_edicion (id INT PRIMARY KEY, nombre NVARCHAR(40), alta DATETIME);
      INSERT INTO tempdb.dbo.gestor_bbdd_edicion VALUES (1, N'uno', '2026-01-02T03:04:05'), (2, N'dos', NULL)`)
    try {
      await expect(
        sessions.saveRowChanges(sessionId, {
          ...ref,
          updates: [{ key: [{ column: 'id', value: 1 }], set: [{ column: 'nombre', value: 'Uno ✓' }, { column: 'alta', value: '2026-12-01 08:30:00' }] }]
        })
      ).resolves.toEqual({ updated: 1, inserted: 0, deleted: 0 })
      await expect(
        sessions.saveRowChanges(sessionId, {
          ...ref,
          updates: [
            { key: [{ column: 'id', value: 2 }], set: [{ column: 'nombre', value: 'no debe quedar' }] },
            { key: [{ column: 'id', value: 99 }], set: [{ column: 'nombre', value: 'x' }] }
          ]
        })
      ).rejects.toThrow(/No se guardó nada/)
      const page = await sessions.fetchTableData(sessionId, { ...ref, offset: 0, limit: 10, sort: [] })
      // 1 de diciembre aunque el servidor use DATEFORMAT dmy, gracias al formato ISO.
      expect(page.rows).toEqual([
        [1, 'Uno ✓', '2026-12-01 08:30:00'],
        [2, 'dos', null]
      ])
      await expect(
        sessions.saveRowChanges(sessionId, {
          ...ref,
          deletes: [[{ column: 'id', value: 2 }]],
          inserts: [[{ column: 'id', value: 2 }, { column: 'nombre', value: 'dos (nueva)' }], [{ column: 'id', value: 3 }]]
        })
      ).resolves.toEqual({ updated: 0, inserted: 2, deleted: 1 })
      const after = await sessions.fetchTableData(sessionId, { ...ref, offset: 0, limit: 10, sort: [] })
      expect(after.rows.map((r) => r.slice(0, 2))).toEqual([
        [1, 'Uno ✓'],
        [2, 'dos (nueva)'],
        [3, null]
      ])
    } finally {
      await run('DROP TABLE IF EXISTS tempdb.dbo.gestor_bbdd_edicion')
    }
  })

  it('lista bases de datos, tablas y columnas', async () => {
    const dbs = await sessions.listDatabases(sessionId)
    expect(dbs).toContain(database)
    const tables = await sessions.listTables(sessionId, database)
    expect(Array.isArray(tables)).toBe(true)
    const first = tables.find((t) => t.kind === 'table')
    if (first) {
      const columns = await sessions.listColumns(sessionId, database, first.name, first.schema)
      expect(columns.length).toBeGreaterThan(0)
    }
  })
})
