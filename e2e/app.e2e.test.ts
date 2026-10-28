// Prueba de humo de la app completa con Playwright controlando Electron.
// Requiere `npm run build` y un MySQL/MariaDB de pruebas (crea y borra la base de datos gestor_e2e):
//   TEST_MYSQL_HOST, TEST_MYSQL_PORT, TEST_MYSQL_USER, TEST_MYSQL_PASSWORD
// E2E_SCREENSHOTS=/ruta guarda capturas de cada paso.
// E2E_RENDERER_URL=http://localhost:5173 usa la interfaz de `npm run dev` (React en desarrollo, con
// StrictMode montando dos veces) en vez de la compilada.
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
  const consoleTab = () => page.locator('.tab', { has: page.locator('.kind-console') })
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
      env: { ...process.env, ELECTRON_RENDERER_URL: env.E2E_RENDERER_URL ?? '' }
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
    await page.locator('.connection', { hasText: 'MariaDB pruebas' }).click()
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
    await view().getByLabel('Filtro', { exact: true }).fill("estado = 'confirmada'")
    await view().getByLabel('Filtro', { exact: true }).press('Enter')
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
    await expect(view().getByLabel('Filtro', { exact: true }).inputValue()).resolves.toBe('`id` = 3')
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
    await view().locator('.edit-bar', { hasText: '1 fila modificada' }).waitFor()
    expect(await email.getAttribute('class')).toContain('modified')
    await shot('06-edicion-pendiente')
    await page.keyboard.press('Alt+Enter')
    await view().locator('.table-footer', { hasText: 'Guardado: 1 modificada' }).waitFor()
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
    await view().locator('.edit-bar', { hasText: '1 fila modificada' }).waitFor()
    await view().getByRole('button', { name: 'Descartar' }).click()
    expect(await view().locator('.edit-bar').count()).toBe(0)
    await view().locator('[data-cell="0:3"]', { hasText: 'FR' }).waitFor()
  })

  it('si otro borró la fila, no guarda nada y lo explica', async () => {
    await view().getByLabel('Filtro', { exact: true }).fill('')
    await view().getByLabel('Filtro', { exact: true }).press('Enter')
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

  it('añade una fila con Alt+Insert y la guarda', async () => {
    await view().getByTitle('Recargar (F5)').click()
    await view().locator('.pager .range', { hasText: /1–5 de/ }).waitFor()
    await view().locator('.grid-cell', { hasText: 'Jordi Puig' }).click()
    await page.keyboard.press('Alt+Insert')
    // La nueva fila empieza a editarse en la primera columna que no es autoincremental.
    const editor = view().getByLabel('Editar nombre')
    await editor.waitFor()
    await editor.fill('Nueva Clienta')
    await editor.press('Enter')
    const newRow = view().getByRole('row', { name: 'Fila nueva' })
    await newRow.locator('.grid-cell.placeholder', { hasText: '(auto)' }).waitFor()
    await newRow.locator('.grid-cell.placeholder', { hasText: 'NULL' }).first().waitFor()
    await view().locator('.edit-bar', { hasText: '1 nueva' }).waitFor()
    await shot('08-fila-nueva')
    await page.keyboard.press('Alt+Enter')
    await view().locator('.table-footer', { hasText: 'Guardado: 1 añadida' }).waitFor()
    const [rows] = await admin.query(`SELECT nombre, email FROM ${DB}.clientes WHERE nombre = 'Nueva Clienta'`)
    expect(rows).toEqual([{ nombre: 'Nueva Clienta', email: null }])
  })

  it('una fila nueva sin guardar se quita con Ctrl+Supr', async () => {
    await view().locator('.grid-cell', { hasText: 'Nueva Clienta' }).click()
    await page.keyboard.press('Alt+Insert')
    await view().getByLabel('Editar nombre').press('Escape')
    await view().locator('.edit-bar', { hasText: '1 nueva' }).waitFor()
    await page.keyboard.press('Control+Delete')
    await expect.poll(() => view().locator('.edit-bar').count()).toBe(0)
    expect(await view().getByRole('row', { name: 'Fila nueva' }).count()).toBe(0)
  })

  it('borra varias filas con Mayús+clic y Ctrl+Supr, y se pueden restaurar antes de guardar', async () => {
    await admin.query(`INSERT INTO ${DB}.clientes (id, nombre) VALUES (50, 'Borrar A'), (51, 'Borrar B')`)
    await view().getByTitle('Recargar (F5)').click()
    await view().locator('.grid-cell', { hasText: 'Borrar A' }).click()
    await view().locator('.grid-cell', { hasText: 'Borrar B' }).click({ modifiers: ['Shift'] })
    await view().locator('.value-viewer', { hasText: '2 filas seleccionadas' }).waitFor()
    await page.keyboard.press('Control+Delete')
    await view().locator('.edit-bar', { hasText: '2 para borrar' }).waitFor()
    expect(await view().getByRole('row', { name: 'Fila marcada para borrar' }).count()).toBe(2)
    await shot('09-filas-para-borrar')
    // Repetir el atajo sobre las mismas filas las restaura.
    await page.keyboard.press('Control+Delete')
    await expect.poll(() => view().locator('.edit-bar').count()).toBe(0)
    await view().getByTitle('Borrar o restaurar las filas seleccionadas (Ctrl+Supr)').click()
    await view().locator('.edit-bar', { hasText: '2 para borrar' }).waitFor()
    await view().getByRole('button', { name: 'Guardar' }).click()
    await view().locator('.table-footer', { hasText: 'Guardado: 2 borradas' }).waitFor()
    const [rows] = await admin.query(`SELECT COUNT(*) AS n FROM ${DB}.clientes WHERE id IN (50, 51)`)
    expect(rows).toEqual([{ n: 0 }])
  })

  it('selecciona arrastrando, copia como TSV y pega un bloque', async () => {
    await view().getByTitle('Recargar (F5)').click()
    await view().locator('.pager .range', { hasText: /1–/ }).waitFor()
    const center = async (selector: string) => {
      const box = (await view().locator(selector).boundingBox())!
      return [box.x + box.width / 2, box.y + box.height / 2] as const
    }
    // Arrastrar desde nombre de la fila 1 hasta email de la fila 2.
    await page.mouse.move(...(await center('[data-cell="0:1"]')))
    await page.mouse.down()
    await page.mouse.move(...(await center('[data-cell="1:2"]')), { steps: 5 })
    await page.mouse.up()
    await view().locator('.value-viewer', { hasText: '2 × 2 celdas seleccionadas' }).waitFor()
    await page.keyboard.press('Control+c')
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('Ana García\tana@example.com\nJohn Smith\tjohn@example.com')
    // Pegar sobre las filas 3-4 deja los cambios pendientes, sin guardar.
    await view().locator('[data-cell="2:1"]').click()
    await page.keyboard.press('Control+v')
    await view().locator('.edit-bar', { hasText: '2 filas modificadas' }).waitFor()
    await view().locator('[data-cell="3:2"]', { hasText: 'john@example.com' }).waitFor()
    await shot('15-seleccion-y-pegado')
    await view().getByRole('button', { name: 'Descartar' }).click()
    // Filas enteras por su número: Supr las marca para borrar.
    await page.mouse.move(...(await center('[data-row="0"]')))
    await page.mouse.down()
    await page.mouse.move(...(await center('[data-row="1"]')), { steps: 3 })
    await page.mouse.up()
    await page.keyboard.press('Delete')
    await view().locator('.edit-bar', { hasText: '2 para borrar' }).waitFor()
    await view().getByRole('button', { name: 'Descartar' }).click()
  })

  it('abre una consola en una base de datos con autocompletado por alias', async () => {
    const dbRow = page.locator('.tree-row', { hasText: DB })
    await dbRow.hover()
    await dbRow.getByTitle(`Consola SQL de ${DB}`).click()
    await consoleTab().waitFor()
    // La lista de bases de datos llega después de abrir la consola.
    await expect.poll(() => view().getByLabel('Base de datos').inputValue()).toBe(DB)
    await view().locator('.hint', { hasText: 'Cargando tablas' }).waitFor({ state: 'detached' })
    await view().locator('.monaco-editor').click()
    await page.keyboard.type('SELECT r.hotel, r.importe FROM reservas r WHERE r.', { delay: 5 })
    const suggest = page.locator('.suggest-widget')
    await suggest.locator('.monaco-list-row .label-name', { hasText: 'cliente_id' }).waitFor({ state: 'visible' })
    expect((await suggest.locator('.monaco-list-row .label-name', { hasText: 'cliente_id' }).boundingBox())?.width).toBeGreaterThan(40)
    expect(await suggest.locator('.monaco-list-row', { hasText: 'nombre' }).count()).toBe(0)
    await shot('10-consola-autocompletado')
    await page.keyboard.press('Escape')
    await page.keyboard.type('importe > 1000 ORDER BY r.importe;', { delay: 5 })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Enter')
    await view().locator('.result-tab', { hasText: 'Resultado 1 (3)' }).waitFor()
    await view().locator('.grid-cell', { hasText: '1530.75' }).waitFor()
    await shot('11-consola-resultados')
  })

  it('«Consola» en una tabla añade un SELECT con sus columnas al final de la consola de esa base de datos y lo ejecuta', async () => {
    await tab('reservas').click()
    await view().getByRole('tab', { name: 'Datos' }).click()
    await view().getByRole('button', { name: 'Consola', exact: true }).click()
    // La misma consola de antes (una por base de datos), con lo escrito y la sentencia nueva debajo.
    await expect.poll(() => consoleTab().count()).toBe(1)
    await expect(consoleTab().getAttribute('aria-selected')).resolves.toBe('true')
    await view().locator('.view-line', { hasText: 'r.importe > 1000' }).waitFor()
    // Las columnas escritas una a una, como «Select Top 1000 Rows» de SSMS.
    await view().locator('.view-line', { hasText: '`cliente_id`,' }).waitFor()
    await view().locator('.view-line', { hasText: 'FROM `gestor_e2e`.`reservas`' }).waitFor()
    await view().getByRole('button', { name: '▶ Ejecutar' }).click()
    await view().locator('.result-tab', { hasText: 'Resultado 1 (5)' }).waitFor()
  })

  it('el historial de la consola (Ctrl+Alt+E) busca e inserta consultas anteriores', async () => {
    // Seguimos en la consola, que acaba de ejecutar el SELECT de reservas. El historial inserta
    // en el cursor: al final, para no caer dentro del SELECT de varias líneas.
    await view().locator('.monaco-editor').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Control+Alt+e')
    const panel = view().getByRole('complementary', { name: 'Historial de consultas' })
    await panel.waitFor()
    // Las dos consolas comparten conexión y por tanto historial; la más reciente, primero.
    await expect(panel.locator('.history-item').first().innerText()).resolves.toContain('FROM `gestor_e2e`.`reservas`')
    await panel.locator('.history-item', { hasText: 'r.importe > 1000' }).locator('.history-meta', { hasText: '3 filas' }).waitFor()
    await panel.getByLabel('Buscar en el historial').fill('importe > 1000')
    await expect.poll(() => panel.locator('.history-item').count()).toBe(1)
    await shot('12-historial-consultas')
    await panel.getByLabel('Buscar en el historial').press('Enter')
    // La consola ya tenía esa consulta (es la misma de la primera prueba): ahora está dos veces.
    await expect.poll(() => view().locator('.view-line', { hasText: 'WHERE r.importe > 1000' }).count()).toBe(2)
    // El cursor queda tras la sentencia insertada: Ctrl+Enter la ejecuta.
    await page.keyboard.press('Control+Enter')
    await view().locator('.result-tab', { hasText: 'Resultado 1 (3)' }).waitFor()
    await panel.getByLabel('Buscar en el historial').fill('')
    await expect(panel.locator('.history-item').first().innerText()).resolves.toContain('r.importe > 1000')
    await page.keyboard.press('Control+Alt+e')
    await expect.poll(() => panel.count()).toBe(0)
  })

  it('lo escrito en la consola se guarda: cerrarla y volver a abrirla lo recupera', async () => {
    await consoleTab().getByTitle(/^Cerrar/).click()
    await expect.poll(() => consoleTab().count()).toBe(0)
    const dbRow = page.locator('.tree-row', { hasText: DB })
    await dbRow.hover()
    await dbRow.getByTitle(`Consola SQL de ${DB}`).click()
    await view().locator('.view-line', { hasText: 'FROM `gestor_e2e`.`reservas`' }).waitFor()
    await view().locator('.view-line', { hasText: 'r.importe > 1000' }).first().waitFor()
  })

  it('el clic derecho en una tabla del explorador copia o abre en la consola un SELECT con sus columnas', async () => {
    const tableRow = page.locator('.tree-row', { hasText: 'clientes' })
    await tableRow.click({ button: 'right' })
    const menu = page.getByRole('menu')
    await shot('16-menu-contextual-tabla')
    await menu.getByRole('menuitem', { name: 'Copiar SELECT de todas las columnas' }).click()
    await menu.getByText('SELECT copiado').waitFor()
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('SELECT\n  `id`,\n  `nombre`,\n  `email`,\n  `pais`\nFROM `gestor_e2e`.`clientes`\nLIMIT 1000')
    await expect.poll(() => menu.count()).toBe(0)
    // Escape cierra el menú sin hacer nada.
    await tableRow.click({ button: 'right' })
    await page.keyboard.press('Escape')
    await expect.poll(() => menu.count()).toBe(0)
    // Con una tabla delante y la consola abierta detrás: la consola pasa al frente con el SELECT a la vista.
    await tab('clientes').click()
    await tableRow.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Consola con SELECT de todas las columnas' }).click()
    await expect(consoleTab().getAttribute('aria-selected')).resolves.toBe('true')
    await view().locator('.view-line', { hasText: 'FROM `gestor_e2e`.`clientes`' }).waitFor()
    await shot('17-consola-desde-menu')
    await view().getByRole('button', { name: '▶ Ejecutar' }).click()
    // Las 5 de partida y la que añadió la prueba de filas nuevas.
    await view().locator('.result-tab', { hasText: 'Resultado 1 (6)' }).waitFor()
    // Con la consola cerrada: se abre con lo guardado y el SELECT nuevo al final, a la vista.
    await consoleTab().getByTitle(/^Cerrar/).click()
    await expect.poll(() => consoleTab().count()).toBe(0)
    await page.locator('.tree-row', { hasText: 'eventos' }).click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Consola con SELECT de todas las columnas' }).click()
    await view().locator('.view-line', { hasText: 'FROM `gestor_e2e`.`eventos`' }).waitFor()
    await shot('18-consola-nueva-desde-menu')
  })

  it('el campo WHERE recuerda los filtros de cada tabla', async () => {
    await tab('reservas').click()
    await view().getByRole('tab', { name: 'Datos' }).click()
    const filter = view().getByLabel('Filtro', { exact: true })
    await filter.fill('importe > 1000')
    await filter.press('Enter')
    await view().locator('.pager .range', { hasText: /1–3 de/ }).waitFor()
    await view().getByTitle('Quitar filtro').click()
    await view().locator('.pager .range', { hasText: /1–5 de/ }).waitFor()
    await view().getByLabel('Filtros recientes', { exact: true }).click()
    const menu = view().getByRole('listbox', { name: 'Filtros recientes' })
    await expect.poll(() => menu.getByRole('option').allInnerTexts()).toEqual(['importe > 1000', "estado = 'confirmada'"])
    await shot('13-historial-filtros')
    await menu.getByRole('option', { name: "estado = 'confirmada'" }).click()
    await expect(filter.inputValue()).resolves.toBe("estado = 'confirmada'")
    await view().locator('.pager .range', { hasText: /1–3 de/ }).waitFor()
    // Con el teclado: flecha abajo abre la lista (ya ordenada por uso), flechas eligen, Enter aplica.
    await filter.fill('')
    await filter.press('ArrowDown')
    await expect.poll(() => menu.getByRole('option').allInnerTexts()).toEqual(["estado = 'confirmada'", 'importe > 1000'])
    await filter.press('ArrowDown')
    await filter.press('ArrowDown')
    await filter.press('Enter')
    await expect(filter.inputValue()).resolves.toBe('importe > 1000')
    await view().locator('.pager .range', { hasText: /1–3 de/ }).waitFor()
  })

  it('el campo WHERE sugiere columnas y sintaxis, y colorea el filtro', async () => {
    const filter = view().getByLabel('Filtro', { exact: true })
    const suggestions = view().getByRole('listbox', { name: 'Sugerencias' })
    await filter.fill('')
    await filter.pressSequentially('esta')
    await expect.poll(() => suggestions.getByRole('option').allInnerTexts()).toEqual([expect.stringContaining('estado')])
    // Tab acepta y encadena los comparadores de la columna.
    await filter.press('Tab')
    await suggestions.getByRole('option', { name: /LIKE/ }).first().waitFor()
    await filter.pressSequentially('=')
    await filter.press('Escape')
    await filter.pressSequentially(" 'confirmada' and entr")
    await filter.press('Enter')
    await expect(filter.inputValue()).resolves.toBe("estado = 'confirmada' and entrada ")
    await filter.pressSequentially("< '2026-08-01'")
    await filter.press('Enter')
    await view().locator('.pager .range', { hasText: /1–1 de/ }).waitFor()
    await expect(view().locator('.filter-layer .tok-string').first().innerText()).resolves.toBe("'confirmada'")
    await expect(view().locator('.filter-layer .tok-column').first().innerText()).resolves.toBe('estado')
    await shot('14-autocompletado-filtro')
    await view().getByTitle('Quitar filtro').click()
  })

  it('edita la estructura: renombra, cambia el tipo y añade una columna; revisa el SQL y lo aplica', async () => {
    await page.locator('.tree-row', { hasText: 'eventos' }).dblclick()
    await tab('eventos').and(page.locator('.active')).waitFor()
    // Columnas desplegadas en el árbol: tienen que reflejar el cambio al aplicarlo.
    if ((await page.locator('.tree-row', { hasText: 'descripcion' }).count()) === 0) await page.locator('.tree-row', { hasText: 'eventos' }).click()
    await page.locator('.tree-row', { hasText: 'descripcion' }).waitFor()
    await view().getByRole('tab', { name: 'Estructura' }).click()
    await view().getByLabel('Nombre de la columna').nth(1).fill('texto')
    await view().getByLabel('Tipo de texto').fill('varchar(80)')
    await view().getByRole('button', { name: '+ Añadir columna' }).click()
    // La columna nueva entra con el nombre seleccionado: se escribe encima.
    await page.keyboard.type('creado')
    await view().getByLabel('Tipo de creado').fill('datetime')
    const def = view().getByLabel('Valor por defecto de creado')
    await def.fill("'sin cerrar")
    await view().locator('.edit-bar', { hasText: 'Hay comillas sin cerrar' }).waitFor()
    await shot('17a-estructura-error')
    await expect(view().getByRole('button', { name: 'Revisar SQL…' }).isDisabled()).resolves.toBe(true)
    await def.fill('CURRENT_TIMESTAMP')
    await view().locator('.edit-bar', { hasText: '1 columna modificada · 1 columna nueva' }).waitFor()
    await shot('17-estructura-editada')
    await page.keyboard.press('Alt+Enter')
    const dialog = page.getByRole('dialog', { name: 'Revisar cambios de estructura' })
    // La intercalación por defecto depende de la versión del servidor; se conserva al cambiar el tipo.
    expect(await dialog.locator('.review-sql').innerText()).toMatch(
      new RegExp(
        `^ALTER TABLE \`${DB}\`\\.\`eventos\`\\n` +
          '  CHANGE COLUMN `descripcion` `texto` varchar\\(80\\) COLLATE \\w+ NULL,\\n' +
          '  ADD COLUMN `creado` datetime NULL DEFAULT CURRENT_TIMESTAMP;$'
      )
    )
    await shot('18-estructura-sql')
    await dialog.getByRole('button', { name: 'Aplicar' }).click()
    await view().locator('.table-footer', { hasText: 'Estructura modificada: 1 sentencia aplicada' }).waitFor()
    await expect.poll(async () => view().locator('.edit-bar').count()).toBe(0)
    const [columns] = await admin.query(
      `SELECT COLUMN_NAME AS c, COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${DB}' AND TABLE_NAME = 'eventos' ORDER BY ORDINAL_POSITION`
    )
    expect(columns).toEqual([
      { c: 'id', t: 'int(11)' },
      { c: 'texto', t: 'varchar(80)' },
      { c: 'creado', t: 'datetime' }
    ])
    await page.locator('.tree-row', { hasText: 'texto' }).waitFor()
    expect(await page.locator('.tree-row', { hasText: 'descripcion' }).count()).toBe(0)
    await view().getByRole('tab', { name: 'Datos' }).click()
    await view().locator('.grid-header .grid-cell', { hasText: 'texto' }).waitFor()
  })

  it('borrar columnas y añadir índices queda pendiente hasta aplicar; «Descartar» lo deshace todo', async () => {
    await tab('clientes').click()
    await view().getByRole('tab', { name: 'Estructura' }).click()
    await view().getByRole('button', { name: 'Borrar pais' }).click()
    await view().getByRole('button', { name: '+ Añadir índice' }).click()
    await page.keyboard.type('uq_email')
    await view().getByLabel('Columnas de uq_email').fill('email, nombre')
    await view().getByLabel('Índice único: uq_email').check()
    await view().locator('.edit-bar', { hasText: '1 columna para borrar · 1 índice' }).waitFor()
    expect(await view().locator('tr.row-dropped').count()).toBe(1)
    await shot('19-estructura-borrado-indice')
    await view().getByRole('button', { name: 'Restaurar pais' }).waitFor()
    await view().locator('.edit-bar').getByRole('button', { name: 'Descartar' }).click()
    await expect.poll(async () => view().locator('.edit-bar').count()).toBe(0)
    expect(await view().locator('tr.row-dropped, tr.row-added').count()).toBe(0)
    const [columns] = await admin.query(`SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${DB}' AND TABLE_NAME = 'clientes'`)
    expect(columns).toEqual([{ n: 4 }])
    await view().getByRole('tab', { name: 'Datos' }).click()
  })

  it('cierra la pestaña activa con Ctrl+W', async () => {
    const before = await page.locator('.tab').count()
    await page.keyboard.press('Control+w')
    await expect.poll(() => page.locator('.tab').count()).toBe(before - 1)
  })
})
