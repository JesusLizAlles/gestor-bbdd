// Tests contra un MySQL/MariaDB real. Se saltan si no hay variables de entorno:
//   TEST_MYSQL_HOST, TEST_MYSQL_PORT, TEST_MYSQL_USER, TEST_MYSQL_PASSWORD   (usuario con permisos de escritura)
//   TEST_MYSQL_RO_USER, TEST_MYSQL_RO_PASSWORD                             (opcional, usuario solo SELECT)
// ¡Crean y borran la base de datos gestor_bbdd_test! No usar contra un servidor de producción.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server as SshServer } from 'ssh2'
import { utils } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { equalsCondition } from '../src/shared/table-query'
import { createDriver } from '../src/main/drivers'
import { MysqlDriver } from '../src/main/drivers/mysql'
import { SessionManager } from '../src/main/sessions'
import { KnownHosts } from '../src/main/ssh/known-hosts'
import { baseConfig, listen, SSH_PASSWORD, SSH_USER, startSshServer } from './helpers'

const env = process.env
const enabled = Boolean(env.TEST_MYSQL_HOST && env.TEST_MYSQL_USER)
const DB = 'gestor_bbdd_test'

const config = baseConfig({
  engine: 'mysql',
  host: env.TEST_MYSQL_HOST ?? '127.0.0.1',
  port: Number(env.TEST_MYSQL_PORT ?? 3306),
  username: env.TEST_MYSQL_USER ?? ''
})
const password = env.TEST_MYSQL_PASSWORD ?? ''

describe.skipIf(!enabled)('MySQL/MariaDB (integración)', () => {
  let dir: string
  let sessions: SessionManager
  let sessionId: string

  const run = async (sql: string, extra: { maxRows?: number; database?: string } = {}) => {
    const out = await sessions.run(sessionId, { sql, database: DB, ...extra })
    const failed = out.results.find((r) => r.error)
    if (failed) throw new Error(failed.error)
    return out
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-bbdd-my-'))
    sessions = new SessionManager({ createDriver, knownHosts: new KnownHosts(dir) })
    const info = await sessions.open(config, { password })
    sessionId = info.sessionId
    await sessions.run(sessionId, { sql: `DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4` })
    await run(`
      CREATE TABLE tipos (
        id INT PRIMARY KEY AUTO_INCREMENT,
        grande BIGINT,
        importe DECIMAL(12,2),
        creado DATETIME(3),
        dia DATE,
        datos JSON,
        binario VARBINARY(16),
        texto VARCHAR(50),
        nulo VARCHAR(5) NULL
      );
      INSERT INTO tipos (grande, importe, creado, dia, datos, binario, texto)
        VALUES (9007199254740993, 1234.50, '2026-10-25 13:45:01.250', '2026-10-25', '{"a": 1}', 0xCAFE, 'Mañana 🏨');
      CREATE TABLE numeros (n INT PRIMARY KEY);
      INSERT INTO numeros (n) WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 50) SELECT n FROM s;
      CREATE VIEW vista_numeros AS SELECT n FROM numeros WHERE n > 10;
      CREATE TABLE hijos (
        id INT PRIMARY KEY, n INT NOT NULL, nombre VARCHAR(20),
        UNIQUE KEY uq_nombre (nombre), KEY idx_n (n),
        CONSTRAINT fk_hijos_numeros FOREIGN KEY (n) REFERENCES numeros (n)
      );
      INSERT INTO hijos VALUES (1, 7, 'siete'), (2, 9, 'nueve');
      CREATE TABLE editable (id INT PRIMARY KEY, nombre VARCHAR(40), importe DECIMAL(10,2), nota TEXT NULL);
      INSERT INTO editable VALUES (1, 'uno', 10.00, 'a'), (2, 'dos', 20.00, NULL), (3, 'tres', 30.00, NULL);
      CREATE TABLE sin_pk (a INT, b INT);
    `)
  })

  afterAll(async () => {
    if (sessionId) {
      await sessions.run(sessionId, { sql: `DROP DATABASE IF EXISTS ${DB}` }).catch(() => {})
    }
    await sessions?.closeAll()
    await rm(dir, { recursive: true, force: true })
  })

  it('normaliza tipos sin perder precisión ni zona horaria', async () => {
    const { results } = await run('SELECT grande, importe, creado, dia, datos, binario, texto, nulo FROM tipos')
    expect(results[0]!.columns.map((c) => c.type)).toEqual([
      'bigint', 'decimal', 'datetime', 'date', 'json', 'varbinary', 'varchar', 'varchar'
    ])
    expect(results[0]!.rows[0]).toEqual([
      '9007199254740993',
      '1234.50',
      '2026-10-25 13:45:01.250',
      '2026-10-25',
      expect.stringMatching(/"a":\s?1/),
      '0xCAFE',
      'Mañana 🏨',
      null
    ])
  })

  it('corta en maxRows en el servidor y marca el resultado como truncado', async () => {
    const limited = await run('SELECT n FROM numeros ORDER BY n', { maxRows: 10 })
    expect(limited.results[0]!.rows).toHaveLength(10)
    expect(limited.results[0]!.truncated).toBe(true)
    const exact = await run('SELECT n FROM numeros ORDER BY n', { maxRows: 50 })
    expect(exact.results[0]!.rows).toHaveLength(50)
    expect(exact.results[0]!.truncated).toBe(false)
  })

  it('el límite no afecta a INSERT … SELECT', async () => {
    await run('CREATE TEMPORARY TABLE copia AS SELECT n FROM numeros WHERE 1 = 0', { maxRows: 5 })
    const out = await run('INSERT INTO copia SELECT n FROM numeros', { maxRows: 5 })
    expect(out.results[0]!.affectedRows).toBe(50)
  })

  it('ejecuta varias sentencias y conserva el estado de sesión entre ejecuciones', async () => {
    const out = await run('SET @x = 41; SELECT @x + 1 AS r; SELECT DATABASE() AS db')
    expect(out.results.map((r) => r.rows[0]?.[0] ?? r.affectedRows)).toEqual([0, 42, DB])
    const again = await run('SELECT @x AS x')
    expect(again.results[0]!.rows[0]).toEqual([41])
  })

  it('se detiene en el primer error e indica la sentencia', async () => {
    const out = await sessions.run(sessionId, { sql: 'SELECT 1; SELECT * FROM no_existe; SELECT 3', database: DB })
    expect(out.results).toHaveLength(2)
    expect(out.results[1]!.statement).toBe('SELECT * FROM no_existe')
    expect(out.results[1]!.error).toMatch(/no_existe/)
  })

  it('lista bases de datos, tablas, vistas y columnas con clave primaria', async () => {
    expect(await sessions.listDatabases(sessionId)).toContain(DB)
    const tables = await sessions.listTables(sessionId, DB)
    expect(tables).toEqual(
      expect.arrayContaining([
        { schema: null, name: 'tipos', kind: 'table' },
        { schema: null, name: 'vista_numeros', kind: 'view' }
      ])
    )
    const columns = await sessions.listColumns(sessionId, DB, 'tipos', null)
    expect(columns[0]).toMatchObject({ name: 'id', isPrimaryKey: true, nullable: false })
    expect(columns.find((c) => c.name === 'importe')?.dataType).toBe('decimal(12,2)')
    const completion = await sessions.completionColumns(sessionId, DB)
    expect(completion).toContainEqual({ schema: null, table: 'numeros', column: 'n', dataType: 'int' })
  })

  it('cancela una consulta larga sin romper la conexión', async () => {
    const started = Date.now()
    const pending = sessions.run(sessionId, { sql: 'SELECT SLEEP(20)', database: DB })
    await new Promise((r) => setTimeout(r, 400))
    await sessions.cancel(sessionId)
    await pending
    expect(Date.now() - started).toBeLessThan(5000)
    const after = await run('SELECT 7')
    expect(after.results[0]!.rows[0]).toEqual([7])
  })

  it('una segunda consulta espera su turno en lugar de fallar', async () => {
    const started = Date.now()
    const slow = sessions.run(sessionId, { sql: 'SELECT SLEEP(1)', database: DB })
    await new Promise((r) => setTimeout(r, 100))
    const second = await sessions.run(sessionId, { sql: 'SELECT 1' })
    expect(second.results[0]!.rows[0]).toEqual([1])
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    await slow
  })

  it('una conexión de solo lectura bloquea escrituras antes de enviarlas', async () => {
    const ro = await sessions.open({ ...config, id: 'ro', readOnly: true }, { password })
    try {
      const blocked = await sessions.run(ro.sessionId, { sql: 'SELECT 1; DELETE FROM numeros', database: DB })
      expect(blocked.blocked).toBe('readOnly')
      expect(blocked.blockedStatements).toEqual(['DELETE FROM numeros'])
      const ok = await sessions.run(ro.sessionId, { sql: 'SELECT COUNT(*) FROM numeros', database: DB })
      expect(ok.results[0]!.rows[0]).toEqual([50])
    } finally {
      await sessions.close(ro.sessionId)
    }
  })

  it('el servidor también rechaza escrituras en modo solo lectura', async () => {
    const driver = new MysqlDriver({ config: { ...config, readOnly: true }, host: config.host, port: config.port, password, tunneled: false })
    await driver.connect()
    try {
      // Saltándonos el clasificador: llega al servidor y es la sesión READ ONLY la que lo impide.
      await expect(driver.execute(`UPDATE ${DB}.numeros SET n = n`, { maxRows: 10 })).rejects.toThrow(/READ ONLY/i)
    } finally {
      await driver.close()
    }
  })

  it('en producción pide confirmación antes de escribir', async () => {
    const prod = await sessions.open({ ...config, id: 'prod', environment: 'prod' }, { password })
    try {
      const first = await sessions.run(prod.sessionId, { sql: 'UPDATE numeros SET n = n WHERE n = 1', database: DB })
      expect(first.blocked).toBe('needsConfirmation')
      const confirmed = await sessions.run(prod.sessionId, {
        sql: 'UPDATE numeros SET n = n WHERE n = 1',
        database: DB,
        confirmedWrite: true
      })
      expect(confirmed.results[0]!.error).toBeUndefined()
      const read = await sessions.run(prod.sessionId, { sql: 'SELECT 1', database: DB })
      expect(read.blocked).toBeUndefined()
    } finally {
      await sessions.close(prod.sessionId)
    }
  })

  it('informa de credenciales incorrectas con un mensaje claro', async () => {
    await expect(sessions.test(config, { password: 'incorrecta' })).rejects.toThrow(/Acceso denegado/)
  })

  it.skipIf(!env.TEST_MYSQL_RO_USER)('un usuario sin permisos recibe el error del servidor', async () => {
    const ro = await sessions.open({ ...config, id: 'lector', username: env.TEST_MYSQL_RO_USER! }, { password: env.TEST_MYSQL_RO_PASSWORD ?? '' })
    try {
      const out = await sessions.run(ro.sessionId, { sql: 'DELETE FROM numeros', database: DB })
      expect(out.results[0]!.error).toMatch(/denied/i)
    } finally {
      await sessions.close(ro.sessionId)
    }
  })

  describe('visor de tablas', () => {
    const numeros = { database: DB, schema: null, table: 'numeros' }
    const page = (extra: Partial<Parameters<SessionManager['fetchTableData']>[1]> = {}) =>
      sessions.fetchTableData(sessionId, { ...numeros, offset: 0, limit: 20, sort: [], ...extra })

    it('pagina en orden de clave primaria e indica si hay más', async () => {
      const first = await page()
      expect(first.rows.map((r) => r[0])).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
      expect(first.hasMore).toBe(true)
      expect(first.columns).toEqual([{ name: 'n', type: 'int' }])
      const last = await page({ offset: 40 })
      expect(last.rows).toHaveLength(10)
      expect(last.hasMore).toBe(false)
    })

    it('ordena por la columna pedida', async () => {
      const desc = await page({ sort: [{ column: 'n', direction: 'desc' }], limit: 3 })
      expect(desc.rows).toEqual([[50], [49], [48]])
    })

    it('filtra y cuenta con el mismo filtro', async () => {
      const filtered = await page({ where: 'n BETWEEN 10 AND 12' })
      expect(filtered.rows).toEqual([[10], [11], [12]])
      expect(await sessions.countTableRows(sessionId, { ...numeros, where: 'n BETWEEN 10 AND 12' })).toBe(3)
      expect(await sessions.countTableRows(sessionId, numeros)).toBe(50)
    })

    it('rechaza filtros con escritura o varias sentencias antes de enviarlos', async () => {
      await expect(page({ where: '1=1; DELETE FROM numeros' })).rejects.toThrow(/única condición/)
      expect(await sessions.countTableRows(sessionId, numeros)).toBe(50)
    })

    it('devuelve el error del servidor si el filtro no es válido', async () => {
      await expect(page({ where: 'columna_inventada = 1' })).rejects.toThrow(/columna_inventada/)
    })

    it('rechaza ordenar por una columna que no existe', async () => {
      await expect(page({ sort: [{ column: 'nope', direction: 'asc' }] })).rejects.toThrow(/no existe/)
    })

    it('varias pestañas de la misma conexión cargan a la vez sin chocar', async () => {
      const pages = await Promise.all([page(), page({ offset: 20 }), sessions.countTableRows(sessionId, numeros), page({ offset: 40 })])
      expect((pages[0] as { rows: unknown[] }).rows).toHaveLength(20)
      expect(pages[2]).toBe(50)
      expect((pages[3] as { rows: unknown[] }).rows).toHaveLength(10)
    })

    it('describe índices, claves foráneas y DDL', async () => {
      const structure = await sessions.tableStructure(sessionId, { database: DB, schema: null, table: 'hijos' })
      expect(structure.columns.map((c) => c.name)).toEqual(['id', 'n', 'nombre'])
      // La FK reutiliza idx_n, así que el servidor no crea un índice propio para ella.
      expect(structure.indexes).toEqual([
        { name: 'PRIMARY', columns: ['id'], unique: true, primary: true },
        { name: 'idx_n', columns: ['n'], unique: false, primary: false },
        { name: 'uq_nombre', columns: ['nombre'], unique: true, primary: false }
      ])
      expect(structure.foreignKeys).toEqual([
        { name: 'fk_hijos_numeros', columns: ['n'], refDatabase: DB, refSchema: null, refTable: 'numeros', refColumns: ['n'] }
      ])
      expect(structure.ddl).toMatch(/^CREATE TABLE `hijos`/)
      const view = await sessions.tableStructure(sessionId, { database: DB, schema: null, table: 'vista_numeros' })
      expect(view.ddl).toMatch(/VIEW/)
    })

    it('navega por la clave foránea hasta la fila referenciada', async () => {
      const { foreignKeys } = await sessions.tableStructure(sessionId, { database: DB, schema: null, table: 'hijos' })
      const fk = foreignKeys[0]!
      const target = await sessions.fetchTableData(sessionId, {
        database: fk.refDatabase,
        schema: fk.refSchema,
        table: fk.refTable,
        offset: 0,
        limit: 10,
        sort: [],
        where: equalsCondition('mysql', fk.refColumns, [7])
      })
      expect(target.rows).toEqual([[7]])
    })
  })

  describe('edición en la rejilla', () => {
    const editable = { database: DB, schema: null, table: 'editable' }
    const read = async () => (await sessions.fetchTableData(sessionId, { ...editable, offset: 0, limit: 10, sort: [] })).rows

    it('guarda varios cambios en una transacción', async () => {
      const out = await sessions.updateRows(sessionId, {
        ...editable,
        updates: [
          { key: [{ column: 'id', value: 1 }], set: [{ column: 'nombre', value: "Uno 'editado'" }, { column: 'nota', value: null }] },
          { key: [{ column: 'id', value: 2 }], set: [{ column: 'importe', value: '25.5' }] }
        ]
      })
      expect(out).toEqual({ applied: 2 })
      expect(await read()).toEqual([
        [1, "Uno 'editado'", '10.00', null],
        [2, 'dos', '25.50', null],
        [3, 'tres', '30.00', null]
      ])
    })

    it('guardar el mismo valor que ya tenía no se toma como fila perdida', async () => {
      await expect(
        sessions.updateRows(sessionId, { ...editable, updates: [{ key: [{ column: 'id', value: 3 }], set: [{ column: 'nombre', value: 'tres' }] }] })
      ).resolves.toEqual({ applied: 1 })
    })

    it('si una fila ya no existe no se guarda nada (rollback de todo el lote)', async () => {
      await expect(
        sessions.updateRows(sessionId, {
          ...editable,
          updates: [
            { key: [{ column: 'id', value: 3 }], set: [{ column: 'nombre', value: 'no debe quedar' }] },
            { key: [{ column: 'id', value: 99 }], set: [{ column: 'nombre', value: 'fantasma' }] }
          ]
        })
      ).rejects.toThrow(/No se guardó nada: la fila con id = 99 ya no existe/)
      expect((await read())[2]).toEqual([3, 'tres', '30.00', null])
    })

    it('devuelve el error del servidor y deshace si un valor no es válido', async () => {
      await expect(
        sessions.updateRows(sessionId, {
          ...editable,
          updates: [
            { key: [{ column: 'id', value: 3 }], set: [{ column: 'nombre', value: 'tampoco' }] },
            { key: [{ column: 'id', value: 2 }], set: [{ column: 'nombre', value: 'x'.repeat(100) }] }
          ]
        })
      ).rejects.toThrow(/too long|demasiado/i)
      expect((await read())[2]![1]).toBe('tres')
    })

    it('exige identificar la fila por toda la clave primaria y columnas existentes', async () => {
      await expect(
        sessions.updateRows(sessionId, { ...editable, updates: [{ key: [{ column: 'nombre', value: 'tres' }], set: [{ column: 'nota', value: 'x' }] }] })
      ).rejects.toThrow(/toda su clave primaria/)
      await expect(
        sessions.updateRows(sessionId, { ...editable, updates: [{ key: [{ column: 'id', value: 3 }], set: [{ column: 'nope', value: 'x' }] }] })
      ).rejects.toThrow(/no existe/)
    })

    it('no permite editar tablas sin clave primaria', async () => {
      await expect(
        sessions.updateRows(sessionId, {
          database: DB,
          schema: null,
          table: 'sin_pk',
          updates: [{ key: [{ column: 'a', value: 1 }], set: [{ column: 'b', value: 2 }] }]
        })
      ).rejects.toThrow(/no tiene clave primaria/)
    })

    it('en producción devuelve la vista previa y no guarda sin confirmar', async () => {
      const prod = await sessions.open({ ...config, id: 'prod-edit', environment: 'prod' }, { password })
      try {
        const updates = [{ key: [{ column: 'id', value: 3 }], set: [{ column: 'nota', value: 'confirmado' }] }]
        const first = await sessions.updateRows(prod.sessionId, { ...editable, updates })
        expect(first).toEqual({
          applied: 0,
          needsConfirmation: true,
          preview: [`UPDATE \`${DB}\`.\`editable\` SET \`nota\` = 'confirmado' WHERE \`id\` = 3`]
        })
        expect((await read())[2]![3]).toBeNull()
        await expect(sessions.updateRows(prod.sessionId, { ...editable, updates, confirmedWrite: true })).resolves.toEqual({ applied: 1 })
        expect((await read())[2]![3]).toBe('confirmado')
      } finally {
        await sessions.close(prod.sessionId)
      }
    })

    it('las conexiones de solo lectura no pueden guardar', async () => {
      const ro = await sessions.open({ ...config, id: 'ro-edit', readOnly: true }, { password })
      try {
        await expect(
          sessions.updateRows(ro.sessionId, { ...editable, updates: [{ key: [{ column: 'id', value: 1 }], set: [{ column: 'nota', value: 'x' }] }] })
        ).rejects.toThrow(/solo lectura/)
      } finally {
        await sessions.close(ro.sessionId)
      }
    })
  })

  describe('a través de un túnel SSH', () => {
    let ssh: SshServer
    let sshPort: number

    beforeAll(async () => {
      ssh = startSshServer(utils.generateKeyPairSync('ed25519').private)
      sshPort = await listen(ssh)
    })
    afterAll(() => {
      ssh.close()
    })

    it('conecta, consulta y devuelve la huella del servidor SSH', async () => {
      const tunneled = {
        ...config,
        id: 'ssh',
        ssh: { enabled: true, host: '127.0.0.1', port: sshPort, username: SSH_USER, authMethod: 'password' as const }
      }
      const info = await sessions.open(tunneled, { password, sshPassword: SSH_PASSWORD })
      try {
        expect(info.server.sshHostFingerprint).toMatch(/^SHA256:/)
        const out = await sessions.run(info.sessionId, { sql: 'SELECT COUNT(*) AS c FROM vista_numeros', database: DB })
        expect(out.results[0]!.rows[0]).toEqual([40])
        // Cancelar también funciona por el túnel (usa la segunda conexión).
        const pending = sessions.run(info.sessionId, { sql: 'SELECT SLEEP(20)' })
        await new Promise((r) => setTimeout(r, 300))
        await sessions.cancel(info.sessionId)
        await pending
      } finally {
        await sessions.close(info.sessionId)
      }
    })

    it('explica cuándo el servidor SSH no llega a la base de datos', async () => {
      const tunneled = {
        ...config,
        id: 'ssh-destino',
        port: 1,
        ssh: { enabled: true, host: '127.0.0.1', port: sshPort, username: SSH_USER, authMethod: 'password' as const }
      }
      await expect(sessions.test(tunneled, { password, sshPassword: SSH_PASSWORD })).rejects.toThrow(
        /El servidor SSH no pudo conectar con 127\.0\.0\.1:1/
      )
    })

    it('si falla la autenticación SSH no llega a abrir la base de datos', async () => {
      const tunneled = {
        ...config,
        id: 'ssh-mal',
        ssh: { enabled: true, host: '127.0.0.1', port: sshPort, username: SSH_USER, authMethod: 'password' as const }
      }
      await expect(sessions.test(tunneled, { password, sshPassword: 'mala' })).rejects.toThrow(/Autenticación SSH/)
    })
  })
})
