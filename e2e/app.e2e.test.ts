// Prueba de humo de la app completa con Playwright controlando Electron.
// Requiere `npm run build` y un MySQL/MariaDB de pruebas (crea y borra la base de datos gestor_e2e):
//   TEST_MYSQL_HOST, TEST_MYSQL_PORT, TEST_MYSQL_USER, TEST_MYSQL_PASSWORD
// E2E_SCREENSHOTS=/ruta guarda capturas de cada paso.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql from 'mysql2/promise'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const env = process.env
const enabled = Boolean(env.TEST_MYSQL_HOST && env.TEST_MYSQL_USER)
const shots = env.E2E_SCREENSHOTS
const DB = 'gestor_e2e'

const SEED = `
  DROP DATABASE IF EXISTS ${DB};
  CREATE DATABASE ${DB} CHARACTER SET utf8mb4;
  USE ${DB};
  CREATE TABLE clientes (id INT PRIMARY KEY AUTO_INCREMENT, nombre VARCHAR(80) NOT NULL, email VARCHAR(120), pais CHAR(2));
  CREATE TABLE reservas (
    id INT PRIMARY KEY AUTO_INCREMENT, cliente_id INT NOT NULL, hotel VARCHAR(60), entrada DATE, salida DATE,
    importe DECIMAL(10,2), estado ENUM('confirmada','cancelada','pendiente'), notas TEXT NULL,
    CONSTRAINT fk_reservas_clientes FOREIGN KEY (cliente_id) REFERENCES clientes (id)
  );
  INSERT INTO clientes (nombre, email, pais) VALUES
    ('Ana García','ana@example.com','ES'), ('John Smith','john@example.com','GB'), ('Marie Dubois','marie@example.com','FR'),
    ('Luca Rossi',NULL,'IT'), ('Jordi Puig','jordi@example.com','ES');
  INSERT INTO reservas (cliente_id, hotel, entrada, salida, importe, estado, notas) VALUES
    (1,'Hotel Menorca','2026-07-01','2026-07-08',1240.50,'confirmada',NULL),
    (2,'Hotel Menorca','2026-07-15','2026-07-22',980.00,'pendiente','Cuna en la habitación'),
    (3,'Hotel Mallorca','2026-08-02','2026-08-09',1530.75,'confirmada',NULL),
    (4,'Hotel Mallorca','2026-08-10','2026-08-12',310.00,'cancelada','Cancelada por el cliente'),
    (5,'Hotel Menorca','2026-09-05','2026-09-12',1105.20,'confirmada',NULL);
  CREATE TABLE eventos (id INT PRIMARY KEY, descripcion VARCHAR(40));
  -- Sin CTE recursiva: MySQL y MariaDB la limitan a 1000 iteraciones por defecto.
  INSERT INTO eventos
    SELECT n, CONCAT('evento ', n) FROM (
      SELECT a.d + b.d * 10 + c.d * 100 + m.d * 1000 + 1 AS n
        FROM (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
              UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a
       CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
              UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b
       CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
              UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c
       CROSS JOIN (SELECT 0 d UNION ALL SELECT 1) m
    ) numeros WHERE n <= 1234;
`

describe.skipIf(!enabled)('Gestor BBDD (E2E)', () => {
  let app: ElectronApplication
  let page: Page
  let userData: string
  let admin: mysql.Connection

  const shot = async (name: string) => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
  }
  const tab = (name: string) => page.locator('.tab', { hasText: name })
  const view = () => page.locator('.table-view:visible, .console-view:visible')
  const firstRow = () => view().locator('.grid-row').first()

  beforeAll(async () => {
    admin = await mysql.createConnection({
      host: env.TEST_MYSQL_HOST,
      port: Number(env.TEST_MYSQL_PORT ?? 3306),
      user: env.TEST_MYSQL_USER,
      password: env.TEST_MYSQL_PASSWORD,
      multipleStatements: true
    })
    await admin.query(SEED)
    userData = await mkdtemp(join(tmpdir(), 'gestor-bbdd-e2e-'))
    app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`, '--password-store=basic'],
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RENDERER_URL: '' }
    })
    page = await app.firstWindow()
    await page.setViewportSize({ width: 1400, height: 860 })
  })

  // Captura del estado final de un paso fallido: imprescindible para entender el fallo.
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' || task.result?.errors?.length) await shot(`fallo-${task.name.slice(0, 40)}`)
  })

  afterAll(async () => {
    await app?.close()
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`)
    await admin?.end()
    if (userData) await rm(userData, { recursive: true, force: true })
  })

  it('arranca en la pantalla de bienvenida e indica que no hay llavero', async () => {
    await page.getByRole('heading', { name: 'Gestor BBDD' }).waitFor()
    await page.getByText('Sin llavero: contraseñas solo en memoria').waitFor()
  })

  it('crea, prueba y guarda una conexión', async () => {
    await page.getByRole('button', { name: 'Nueva conexión' }).click()
    await page.getByLabel('Nombre').fill('MariaDB pruebas')
    await page.getByLabel('Servidor', { exact: true }).fill(env.TEST_MYSQL_HOST!)
    await page.getByLabel('Puerto', { exact: true }).fill(env.TEST_MYSQL_PORT ?? '3306')
    await page.getByLabel('Usuario', { exact: true }).fill(env.TEST_MYSQL_USER!)
    await page.getByLabel('Contraseña', { exact: true }).fill(env.TEST_MYSQL_PASSWORD ?? '')
    await page.getByRole('button', { name: 'Probar conexión' }).click()
    await page.getByText(/Conexión correcta: (MariaDB|MySQL)/).waitFor()
    await page.getByRole('button', { name: 'Guardar' }).click()
    await page.locator('.connection', { hasText: 'MariaDB pruebas' }).waitFor()
  })

  it('abre una tabla con doble clic y la pantalla principal son sus datos, sin SQL a la vista', async () => {
    await page.locator('.connection', { hasText: 'MariaDB pruebas' }).dblclick()
    await page.getByText('Despliega una base de datos').waitFor()
    await page.locator('.tree-row', { hasText: DB }).click()
    await page.locator('.tree-row', { hasText: 'reservas' }).dblclick()
    await tab('reservas').waitFor()
    await view().locator('.grid-cell', { hasText: 'Cuna en la habitación' }).waitFor()
    expect(await page.locator('.monaco-editor').count()).toBe(0)
    await expect(view().locator('.pager .range').innerText()).resolves.toMatch(/1–5 de/)
    await expect(view().locator('.grid-header')).toBeDefined()
    // La columna FK se marca y la clave primaria lleva su icono.
    await view().locator('.grid-header .grid-cell', { hasText: 'cliente_id' }).locator('.fk-mark').waitFor()
    await shot('01-tabla-reservas')
  })

  it('ordena al pulsar la cabecera (ascendente, descendente)', async () => {
    const header = view().locator('.grid-header .grid-cell', { hasText: 'importe' })
    await header.click()
    await firstRow().getByText('310.00').waitFor()
    await header.click()
    await firstRow().getByText('1530.75').waitFor()
    expect(await header.getAttribute('aria-sort')).toBe('descending')
  })

  it('filtra con WHERE y cuenta las filas bajo demanda', async () => {
    await view().getByLabel('Filtro').fill("estado = 'confirmada'")
    await view().getByLabel('Filtro').press('Enter')
    await view().locator('.pager .range', { hasText: /1–3 de \?/ }).waitFor()
    await view().getByTitle('Contar filas').click()
    await view().locator('.pager .range', { hasText: '1–3 de 3' }).waitFor()
    await shot('02-filtro-orden')
  })

  it('navega por la clave foránea con Ctrl+clic hasta el cliente', async () => {
    // Primera fila (orden por importe desc): reserva 3 → cliente 3, Marie Dubois. Columna 1 = cliente_id.
    await view().locator('[data-cell="0:1"]').click({ modifiers: ['Control'] })
    await tab('clientes').waitFor()
    await view().locator('.grid-cell', { hasText: 'Marie Dubois' }).waitFor()
    await expect(view().getByLabel('Filtro').inputValue()).resolves.toBe('`id` = 3')
    expect(await view().locator('.grid-row').count()).toBe(1)
    await shot('03-navegacion-fk')
  })

  it('pagina tablas grandes y se mueve con el teclado', async () => {
    await page.locator('.tree-row', { hasText: 'eventos' }).dblclick()
    await tab('eventos').waitFor()
    await view().locator('.pager .range', { hasText: '1–500 de ?' }).waitFor()
    await view().getByTitle('Página siguiente').click()
    await view().locator('.pager .range', { hasText: '501–1000 de ?' }).waitFor()
    await view().getByTitle('Última página').click()
    await view().locator('.pager .range', { hasText: '1001–1234 de 1234' }).waitFor()
    await view().locator('.grid-cell', { hasText: 'evento 1001' }).click()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await view().locator('.value-viewer', { hasText: 'fila 1003' }).waitFor()
    await view().locator('.value-viewer', { hasText: 'evento 1003' }).waitFor()
    await shot('04-paginacion')
  })

  it('muestra la estructura y abre la tabla referenciada desde ella', async () => {
    await tab('reservas').click()
    await view().getByRole('tab', { name: 'Estructura' }).click()
    await view().getByText('Claves foráneas (1)').waitFor()
    await view().locator('.ddl', { hasText: 'CREATE TABLE `reservas`' }).waitFor()
    await shot('05-estructura')
    await view().getByRole('button', { name: `${DB}.clientes` }).click()
    // Al abrir sin filtro desde la estructura, la pestaña de clientes ya existente se reutiliza.
    await tab('clientes').and(page.locator('.active')).waitFor()
  })

  it('edita una celda y la guarda con Alt+Enter', async () => {
    await tab('clientes').click()
    // La pestaña de clientes sigue filtrada por la navegación anterior: solo Marie Dubois (fila 0).
    const email = view().locator('[data-cell="0:2"]')
    await email.dblclick()
    const editor = view().getByLabel('Editar email')
    await editor.fill('marie.dubois@example.org')
    await editor.press('Enter')
    await view().locator('.edit-bar', { hasText: '1 cambio en 1 fila' }).waitFor()
    expect(await email.getAttribute('class')).toContain('modified')
    await shot('06-edicion-pendiente')
    await page.keyboard.press('Alt+Enter')
    await view().locator('.table-footer', { hasText: '1 fila guardada' }).waitFor()
    await expect.poll(async () => (await view().locator('.edit-bar').count())).toBe(0)
    const [rows] = await admin.query(`SELECT email FROM ${DB}.clientes WHERE id = 3`)
    expect(rows).toEqual([{ email: 'marie.dubois@example.org' }])
  })

  it('Esc cancela la edición y "Descartar" deshace los cambios pendientes', async () => {
    const pais = view().locator('[data-cell="0:3"]')
    await pais.click()
    await page.keyboard.type('X')
    await view().getByLabel('Editar pais').waitFor()
    await page.keyboard.press('Escape')
    expect(await view().locator('.edit-bar').count()).toBe(0)
    await view().getByRole('button', { name: 'NULL', exact: true }).click()
    await view().locator('.edit-bar', { hasText: '1 cambio' }).waitFor()
    await view().getByRole('button', { name: 'Descartar' }).click()
    expect(await view().locator('.edit-bar').count()).toBe(0)
    await view().locator('[data-cell="0:3"]', { hasText: 'FR' }).waitFor()
  })

  it('si otro borró la fila, no guarda nada y lo explica', async () => {
    await view().getByLabel('Filtro').fill('')
    await view().getByLabel('Filtro').press('Enter')
    await view().locator('.pager .range', { hasText: /1–5/ }).waitFor()
    await admin.query(`INSERT INTO ${DB}.clientes (id, nombre) VALUES (99, 'Temporal')`)
    await view().getByTitle('Recargar (F5)').click()
    await view().locator('.grid-cell', { hasText: 'Temporal' }).waitFor()
    await view().locator('.grid-cell', { hasText: 'Temporal' }).dblclick()
    await view().getByLabel('Editar nombre').fill('Ya no existe')
    await view().getByLabel('Editar nombre').press('Enter')
    await view().locator('.grid-cell', { hasText: 'Ana García' }).dblclick()
    await view().getByLabel('Editar nombre').fill('Ana (no debe guardarse)')
    await view().getByLabel('Editar nombre').press('Enter')
    await admin.query(`DELETE FROM ${DB}.clientes WHERE id = 99`)
    await view().getByRole('button', { name: 'Guardar' }).click()
    await view().locator('.edit-bar.error', { hasText: 'la fila con id = 99 ya no existe' }).waitFor()
    const [rows] = await admin.query(`SELECT nombre FROM ${DB}.clientes WHERE id = 1`)
    expect(rows).toEqual([{ nombre: 'Ana García' }])
    await shot('07-error-guardado')
    await view().getByRole('button', { name: 'Descartar' }).click()
  })

  it('abre una consola en una base de datos con autocompletado por alias', async () => {
    const dbRow = page.locator('.tree-row', { hasText: DB })
    await dbRow.hover()
    await dbRow.getByTitle(`Nueva consola SQL en ${DB}`).click()
    await tab('Consola 1').waitFor()
    await expect(view().getByLabel('Base de datos').inputValue()).resolves.toBe(DB)
    await view().locator('.hint', { hasText: 'Cargando tablas' }).waitFor({ state: 'detached' })
    await view().locator('.monaco-editor').click()
    await page.keyboard.type('SELECT r.hotel, r.importe FROM reservas r WHERE r.', { delay: 5 })
    const suggest = page.locator('.suggest-widget')
    await suggest.locator('.monaco-list-row .label-name', { hasText: 'cliente_id' }).waitFor({ state: 'visible' })
    expect((await suggest.locator('.monaco-list-row .label-name', { hasText: 'cliente_id' }).boundingBox())?.width).toBeGreaterThan(40)
    expect(await suggest.locator('.monaco-list-row', { hasText: 'nombre' }).count()).toBe(0)
    await shot('08-consola-autocompletado')
    await page.keyboard.press('Escape')
    await page.keyboard.type('importe > 1000 ORDER BY r.importe;', { delay: 5 })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Enter')
    await view().locator('.result-tab', { hasText: 'Resultado 1 (3)' }).waitFor()
    await view().locator('.grid-cell', { hasText: '1530.75' }).waitFor()
    await shot('09-consola-resultados')
  })

  it('abre una consola sobre la tabla visible y la ejecuta', async () => {
    await tab('reservas').click()
    await view().getByRole('tab', { name: 'Datos' }).click()
    await view().getByRole('button', { name: 'Consola', exact: true }).click()
    await tab('Consola 2').waitFor()
    await view().locator('.view-line', { hasText: 'SELECT * FROM' }).waitFor()
    await view().getByRole('button', { name: '▶ Ejecutar' }).click()
    await view().locator('.result-tab', { hasText: 'Resultado 1 (5)' }).waitFor()
  })

  it('cierra la pestaña activa con Ctrl+W', async () => {
    const before = await page.locator('.tab').count()
    await page.keyboard.press('Control+w')
    await expect.poll(() => page.locator('.tab').count()).toBe(before - 1)
  })
})
