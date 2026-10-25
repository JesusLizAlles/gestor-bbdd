# Gestor BBDD · prototipo

Gestor de bases de datos de escritorio para **MySQL/MariaDB** y **SQL Server**, con conexión directa por IP,
TLS y **túnel SSH**. Es el prototipo de la *Fase 0* del documento de viabilidad (Electron + TypeScript).

## Qué hace ya

La pantalla principal es el **visor de tablas**, como en DataGrip: al abrir una tabla se ven sus datos y la SQL
se genera por detrás.

- **Conexiones** guardadas con entorno (desarrollo, pruebas, producción) y prueba de conexión antes de guardar.
- **Contraseñas** cifradas con el llavero del sistema (KWallet/libsecret, Keychain, DPAPI). Sin llavero, solo en memoria.
- **Túnel SSH** con contraseña, clave privada o agente. La huella del servidor se guarda la primera vez y, si cambia, se rechaza la conexión.
- **TLS** opcional, con verificación de certificado y CA propia.
- **Explorador**: bases de datos → tablas y vistas → columnas, con filtro. Doble clic en una tabla para abrirla en una pestaña.
- **Visor de datos**:
  - Paginación de 100 a 5000 filas. El total se cuenta solo al pulsar «?»: contar tablas enormes es caro.
  - Orden al pulsar la cabecera (▲, ▼, sin orden). Sin orden, se pagina por clave primaria para que las páginas sean estables.
  - Filtro `WHERE` opcional: solo admite una condición de lectura; se rechaza cualquier escritura o segunda sentencia.
  - Columnas redimensionables y navegación con teclado: flechas, RePág/AvPág, Inicio/Fin, Ctrl+Inicio/Fin y Ctrl+C para copiar.
  - **Navegación por claves foráneas**: botón ↗, Ctrl+clic o Ctrl+B en una celda abren la fila referenciada.
  - Exportar la página a CSV, CSV para Excel, JSON o `INSERT`.
- **Edición en la rejilla**, al estilo JetBrains:
  - Para editar: <kbd>Enter</kbd>, <kbd>F2</kbd>, doble clic o empezar a escribir sobre la celda. <kbd>Shift</kbd>+<kbd>Enter</kbd> inserta un salto de línea; <kbd>Esc</kbd> cancela.
  - Los cambios quedan pendientes y resaltados. **<kbd>Alt</kbd>+<kbd>Enter</kbd>** los guarda; «Descartar» los deshace. «NULL» pone la celda a NULL.
  - **Filas nuevas**: <kbd>Alt</kbd>+<kbd>Insert</kbd> o «＋ Fila». La fila aparece al final y empieza a editarse. Las celdas vacías muestran qué recibirán: `(auto)`, `(valor por defecto)`, `NULL` u `(obligatorio)`.
  - **Borrar filas**: <kbd>Ctrl</kbd>+<kbd>Supr</kbd> o «－ Fila» sobre la selección (<kbd>Shift</kbd>+clic o <kbd>Shift</kbd>+flechas para varias). Quedan tachadas hasta guardar; repetir el atajo las restaura. Una fila nueva sin guardar simplemente se quita.
  - Todo se guarda con sentencias con parámetros en una sola transacción: primero los borrados, luego los cambios y por último las altas. Así se puede borrar una fila y volver a crearla con la misma clave.
  - Las filas se localizan por su clave primaria.
  - Si alguna fila ya no existe o cambió su clave, no se guarda nada y se indica cuál.
  - En producción se pide confirmación mostrando las sentencias.
  - No se puede editar en vistas, tablas sin clave primaria ni conexiones de solo lectura.
  - Si hay cambios sin guardar, se avisa antes de cambiar de página, orden o filtro.
- **Estructura** de cada tabla: columnas, índices, claves foráneas (con enlace a la tabla referenciada) y DDL.
- **Consola SQL** (botón ⌨ junto a la conexión o a una base de datos, o «Consola» desde una tabla):
  - Selector de base de datos. El autocompletado ofrece las tablas y columnas de la base elegida.
  - Entiende alias: tras `r.` en `FROM reservas r` solo sugiere columnas de `reservas`. Prioriza las columnas de las tablas que ya están en la consulta.
  - <kbd>Ctrl</kbd>+<kbd>Enter</kbd> ejecuta la sentencia bajo el cursor (o la selección); <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> ejecuta todo. Respeta `DELIMITER` (MySQL) y `GO` (SQL Server).
  - Resultados en pestañas, límite de filas aplicado en el servidor, cancelar y exportar.
  - En conexiones de solo lectura bloquea las escrituras; en producción pide confirmación.
  - Tras un `CREATE`, `ALTER` o `DROP`, el autocompletado se recarga.
- **Atajos**:

  | Atajo | Acción |
  | --- | --- |
  | <kbd>F5</kbd> | Recargar |
  | <kbd>Ctrl</kbd>+<kbd>W</kbd> o clic central | Cerrar pestaña |
  | <kbd>Ctrl</kbd>+<kbd>Tab</kbd> o <kbd>Ctrl</kbd>+<kbd>RePág</kbd>/<kbd>AvPág</kbd> | Cambiar de pestaña |
- **Varias pestañas y consolas de una misma conexión** comparten su conexión de consultas y esperan turno, sin errores.

## Puesta en marcha

```bash
npm install
npm run dev          # desarrollo con recarga en caliente
npm run build        # compila a out/
npm start            # ejecuta lo compilado
npm run dist:linux   # AppImage en dist/
npm run dist:win     # instalador NSIS (mejor generarlo en Windows)
```

Requiere Node.js 22.12 o superior. La primera ejecución descarga el binario de Electron.

## Arquitectura

```
┌──────────────── Proceso principal (Node) ────────────────┐      ┌──── Renderer (sandbox) ────┐
│ ipc.ts       valida cada llamada con zod                 │ IPC  │ React + Monaco             │
│ sessions.ts  túnel + driver, solo lectura, producción    │◀────▶│ Sin acceso a Node ni red   │
│ drivers/     mysql2 · mssql (tedious)                    │      │ CSP: solo recursos propios │
│ ssh/         ssh2: reenvío local + huellas conocidas     │      └────────────────────────────┘
│ store/       connections.json · secrets.json (cifrado)   │
└──────────────────────────────────────────────────────────┘
```

| Carpeta | Contenido |
| --- | --- |
| `src/shared` | Tipos, separador de sentencias SQL, clasificación lectura/escritura, SQL del visor (`table-query.ts`) y exportadores. Lo usan los dos procesos. |
| `src/main` | Proceso principal: drivers, túnel SSH, sesiones, almacenamiento e IPC. |
| `src/preload` | Puente mínimo que expone `window.api` al renderer. |
| `src/renderer` | Interfaz React. |
| `tests` | Tests unitarios y de integración (Vitest). |
| `e2e` | Prueba de humo de la app completa con Playwright. |

Cada conexión abierta usa **dos conexiones al servidor**:
- Una para las consultas del usuario, que conserva la sesión: `USE`, variables, `#temporales` y transacciones.
- Otra para metadatos y para cancelar sin esperar a que termine la consulta en curso.

Con SSH, el driver conecta a `127.0.0.1:<puerto local>` y el túnel reenvía el tráfico al servidor.

Los datos de la app se guardan en `~/.config/Gestor BBDD/`: `connections.json`, `secrets.json` y `known_hosts.json`, todos con permisos 0600.

## Tests

```bash
npm test             # unitarios + integración (los de BBDD se saltan sin variables de entorno)
npm run typecheck
```

**Integración con MySQL/MariaDB.** Crea y borra la base de datos `gestor_bbdd_test`, así que **no lo lances contra producción**:

```bash
TEST_MYSQL_HOST=127.0.0.1 TEST_MYSQL_PORT=3407 TEST_MYSQL_USER=gestor TEST_MYSQL_PASSWORD=… \
TEST_MYSQL_RO_USER=lector TEST_MYSQL_RO_PASSWORD=… npm test
```

Se puede levantar una MariaDB desechable, sin tocar la del sistema:

```bash
D=/tmp/mariadb-pruebas
mariadb-install-db --no-defaults --datadir=$D/data --auth-root-authentication-method=normal --skip-test-db
mariadbd --no-defaults --datadir=$D/data --port=3407 --bind-address=127.0.0.1 --socket=$D/sock &
mariadb --no-defaults -S $D/sock -u root -e "CREATE USER 'gestor'@'127.0.0.1' IDENTIFIED BY 'gestor-pass'; GRANT ALL ON *.* TO 'gestor'@'127.0.0.1';"
```

**Integración con SQL Server.** Solo usa tablas `#temporales` y vistas del sistema, pero mejor contra un servidor de desarrollo:
`TEST_MSSQL_HOST`, `TEST_MSSQL_PORT`, `TEST_MSSQL_USER`, `TEST_MSSQL_PASSWORD` y, opcionalmente, `TEST_MSSQL_DATABASE` y `TEST_MSSQL_TLS=1`.

**E2E.** Crea su propia base de datos `gestor_e2e` (y la borra al acabar), así que tampoco va contra producción:

```bash
TEST_MYSQL_HOST=… TEST_MYSQL_PORT=… TEST_MYSQL_USER=… TEST_MYSQL_PASSWORD=… E2E_SCREENSHOTS=/tmp/capturas npm run test:e2e
```

Ayuda de desarrollo: con `GESTOR_SCREENSHOT=/ruta.png npm start` la app guarda una captura y se cierra. En la app empaquetada está desactivado.

## Seguridad

- Renderer con `sandbox`, `contextIsolation`, sin `nodeIntegration`, sin navegación externa y con CSP estricta sin CDN.
- Todo lo que llega por IPC se valida con zod. El renderer nunca recibe contraseñas descifradas.
- Contraseñas con `safeStorage`. En Linux, si el sistema solo ofrece `basic_text` (clave fija), no se escriben en disco.
- Solo lectura en dos capas:
  - En la app: clasificación conservadora de cada sentencia.
  - En MySQL/MariaDB, además, `SET SESSION TRANSACTION READ ONLY` en el servidor.

## Limitaciones conocidas del prototipo

- **SQL Server:**
  - Solo usuario y contraseña de SQL. Sin autenticación de Windows, Kerberos ni Azure AD.
  - Las instancias con nombre no funcionan por SSH: SQL Browser usa UDP. Hay que indicar el puerto.
  - En la rejilla, los `DECIMAL` se muestran como número de JavaScript: se pierde precisión por encima de 15–16 cifras.
  - El modo solo lectura se aplica solo en la app. Para una garantía total, usa un usuario de solo lectura.
  - Si un SELECT supera el límite de filas dentro de un bloque `BEGIN…END`, se cancela el resto del bloque.
- **SSH:**
  - Sin saltos encadenados (*jump hosts*) y sin leer `~/.ssh/config`.
  - La primera conexión acepta la huella automáticamente. Se muestra en «Probar conexión» y en la barra de estado.
- **Funciones aún no disponibles:** importar CSV, historial de consultas.
- **Edición:**
  - Los valores se envían como texto y los convierte el servidor (`'25.5'` → DECIMAL).
  - No se pueden editar binarios: se muestran abreviados en `0x…`.
  - En DataGrip, guardar es <kbd>Ctrl</kbd>+<kbd>Enter</kbd>; aquí es <kbd>Alt</kbd>+<kbd>Enter</kbd>.
  - Las filas nuevas van a la página actual hasta guardar. Después, la tabla se recarga y la fila aparece donde le corresponda por orden (puede ser otra página).
  - En tablas sin clave primaria no se puede añadir, modificar ni borrar desde la rejilla; para eso está la consola.
- **Visor:**
  - Ordena por una sola columna a la vez.
  - El filtro admite subconsultas de lectura.
  - La exportación es de la página visible, no de la tabla entera.
  - En SQL Server, paginar exige 2012 o posterior (OFFSET/FETCH).
- **Configuración:** al editar una conexión abierta, los cambios se aplican al reconectar.
- **Dependencias:** `npm audit` avisa de `@azure/msal-node`, que llega por `tedious` → `@azure/identity`. Solo se usa en los flujos de login de Azure AD, que esta app no activa. Se revisará cuando `@azure/identity` admita la versión corregida.
