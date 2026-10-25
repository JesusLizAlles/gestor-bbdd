import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HistoryStore, MAX_FILTERS, MAX_QUERIES, MAX_SQL_LENGTH } from '../src/main/store/history'

const entry = (sql: string, database: string | null = 'hotel') => ({
  sql,
  database,
  executedAt: '2026-10-25T10:00:00.000Z',
  durationMs: 3,
  statements: 1,
  rowCount: 1
})

const reservas = { database: 'hotel', schema: null, table: 'reservas' }
const clientes = { database: 'hotel', schema: null, table: 'clientes' }

describe('HistoryStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-bbdd-historial-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('guarda consultas por conexión, de la más reciente a la más antigua, y persiste', async () => {
    const h = new HistoryStore(dir)
    await h.addQuery('c1', entry('SELECT 1'))
    await h.addQuery('c1', { ...entry('  SELECT 2  '), error: 'falló' })
    await h.addQuery('c2', entry('SELECT 3'))
    const list = await new HistoryStore(dir).listQueries('c1')
    expect(list.map((e) => e.sql)).toEqual(['SELECT 2', 'SELECT 1'])
    expect(list[0]).toMatchObject({ error: 'falló', database: 'hotel', id: expect.any(String) })
    expect((await stat(join(dir, 'history.json'))).mode & 0o777).toBe(0o600)
  })

  it('repetir la última consulta (misma SQL y BBDD) no la duplica', async () => {
    const h = new HistoryStore(dir)
    await h.addQuery('c1', entry('SELECT 1'))
    await h.addQuery('c1', entry('SELECT 1'))
    await h.addQuery('c1', entry('SELECT 1', 'otra'))
    expect((await h.listQueries('c1')).map((e) => e.database)).toEqual(['otra', 'hotel'])
  })

  it('busca sin distinguir mayúsculas y respeta el límite', async () => {
    const h = new HistoryStore(dir)
    for (let i = 0; i < MAX_QUERIES + 5; i++) await h.addQuery('c1', entry(i % 2 ? `SELECT ${i} FROM reservas` : `UPDATE x SET a = ${i}`))
    expect(await h.listQueries('c1')).toHaveLength(MAX_QUERIES)
    const found = await h.listQueries('c1', 'from RESERVAS')
    expect(found.every((e) => e.sql.includes('reservas'))).toBe(true)
    expect(found[0]!.sql).toBe(`SELECT ${MAX_QUERIES + 3} FROM reservas`)
  })

  it('no guarda scripts enormes ni consultas vacías', async () => {
    const h = new HistoryStore(dir)
    await h.addQuery('c1', entry('x'.repeat(MAX_SQL_LENGTH + 1)))
    await h.addQuery('c1', entry('   '))
    expect(await h.listQueries('c1')).toEqual([])
  })

  it('recuerda filtros por tabla, sin duplicados y con límite', async () => {
    const h = new HistoryStore(dir)
    await h.addFilter('c1', reservas, "estado = 'confirmada'")
    await h.addFilter('c1', reservas, 'importe > 100')
    await h.addFilter('c1', reservas, "estado = 'confirmada'")
    await h.addFilter('c1', clientes, "pais = 'ES'")
    expect(await h.listFilters('c1', reservas)).toEqual(["estado = 'confirmada'", 'importe > 100'])
    expect(await h.listFilters('c1', clientes)).toEqual(["pais = 'ES'"])
    for (let i = 0; i < MAX_FILTERS + 3; i++) await h.addFilter('c1', reservas, `id = ${i}`)
    expect(await h.listFilters('c1', reservas)).toHaveLength(MAX_FILTERS)
  })

  it('borra consultas, filtros de una tabla o todo lo de una conexión', async () => {
    const h = new HistoryStore(dir)
    await h.addQuery('c1', entry('SELECT 1'))
    await h.addFilter('c1', reservas, 'a = 1')
    await h.addFilter('c1', clientes, 'b = 2')
    await h.addQuery('c2', entry('SELECT 2'))
    await h.clear('c1', 'filters', reservas)
    expect(await h.listFilters('c1', reservas)).toEqual([])
    expect(await h.listFilters('c1', clientes)).toEqual(['b = 2'])
    await h.clear('c1', 'queries')
    expect(await h.listQueries('c1')).toEqual([])
    await h.deleteConnection('c1')
    expect(await h.listFilters('c1', clientes)).toEqual([])
    expect(JSON.parse(await readFile(join(dir, 'history.json'), 'utf8')).queries.c2).toHaveLength(1)
  })
})
