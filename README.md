# Gestor BBDD

Gestor de bases de datos de escritorio para **MySQL/MariaDB** y **SQL Server**, inspirado en DataGrip. Admite conexión
directa por IP, TLS y **túnel SSH**. Está hecho con Electron, TypeScript y React.

Es un proyecto de código abierto con [licencia MIT](LICENSE). Los instaladores para Linux (AppImage), Windows y macOS están en
[Releases](https://github.com/JesusLizAlles/gestor-bbdd/releases). Desde la versión 0.3.0, la app se actualiza sola.

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
    Recuerda los últimos 30 filtros que han funcionado en cada tabla. Para recuperarlos: botón ▾, o <kbd>↓</kbd> en el campo y luego flechas y <kbd>Enter</kbd>.
    Se colorea como código (columnas, palabras clave, cadenas, números, funciones) y sugiere mientras se escribe, o con
    <kbd>Ctrl</kbd>+<kbd>Espacio</kbd>: columnas de la tabla, comparadores tras una columna (`LIKE '%…%'`, `IN (…)`,
    `BETWEEN`, `IS NULL`…), valores según el tipo (en fechas, hoy, `CURDATE()`/`GETDATE()`, hace 7 días…), funciones
    del motor y `AND`/`OR`. <kbd>Tab</kbd> o <kbd>Enter</kbd> aceptan la sugerencia marcada; <kbd>Esc</kbd> cierra la lista.
  - Columnas redimensionables y navegación con teclado: flechas, RePág/AvPág, Inicio/Fin, Ctrl+Inicio/Fin.
  - **Selección de bloques**: arrastrando sobre las celdas (la rejilla se desplaza sola al llegar al borde), sobre los
    números de fila (filas enteras) o sobre las cabeceras (columnas enteras; también <kbd>Ctrl</kbd>+clic). También con
    <kbd>Shift</kbd>+clic, <kbd>Shift</kbd>+flechas y <kbd>Ctrl</kbd>+<kbd>A</kbd>. Un clic simple en la cabecera sigue ordenando.
  - <kbd>Ctrl</kbd>+<kbd>C</kbd> copia el bloque como texto separado por tabuladores (se pega tal cual en Excel);
    <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> incluye las cabeceras. NULL se copia como `NULL`.
  - **Navegación por claves foráneas**: botón ↗, Ctrl+clic o Ctrl+B en una celda abren la fila referenciada.
  - Exportar la página a CSV, CSV para Excel, JSON o `INSERT`.
- **Edición en la rejilla**, al estilo JetBrains:
  - Para editar: <kbd>Enter</kbd>, <kbd>F2</kbd>, doble clic o empezar a escribir sobre la celda. <kbd>Shift</kbd>+<kbd>Enter</kbd> inserta un salto de línea; <kbd>Esc</kbd> cancela.
  - **Pegar** (<kbd>Ctrl</kbd>+<kbd>V</kbd>): un bloque copiado (de la propia rejilla o de Excel) se pega desde la celda
    seleccionada; un único valor rellena todo el bloque seleccionado. Si sobran filas se crean filas nuevas, sin copiar las
    columnas autoincrementales: para duplicar filas, cópialas, añade una fila con <kbd>Alt</kbd>+<kbd>Insert</kbd> y pega.
  - Los cambios quedan pendientes y resaltados. **<kbd>Alt</kbd>+<kbd>Enter</kbd>** los guarda; «Descartar» los deshace. «NULL» pone la celda a NULL.
  - **Filas nuevas**: <kbd>Alt</kbd>+<kbd>Insert</kbd> o el botón +. La fila aparece al final y empieza a editarse. Las celdas vacías muestran qué recibirán: `(auto)`, `(valor por defecto)`, `NULL` u `(obligatorio)`.
  - **Borrar filas**: <kbd>Ctrl</kbd>+<kbd>Supr</kbd> o el botón − sobre las filas de la selección; con filas enteras
    seleccionadas por su número basta <kbd>Supr</kbd>. Quedan tachadas hasta guardar; repetir el atajo las restaura. Una fila nueva sin guardar simplemente se quita.
  - Todo se guarda con sentencias con parámetros en una sola transacción: primero los borrados, luego los cambios y por último las altas. Así se puede borrar una fila y volver a crearla con la misma clave.
  - Las filas se localizan por su clave primaria.
  - Si alguna fila ya no existe o cambió su clave, no se guarda nada y se indica cuál.
  - En producción se pide confirmación mostrando las sentencias.
  - No se puede editar en vistas, tablas sin clave primaria ni conexiones de solo lectura.
  - Si hay cambios sin guardar, se avisa antes de cambiar de página, orden o filtro.
- **Estructura** de cada tabla: columnas, índices, claves foráneas (con enlace a la tabla referenciada) y DDL.
- **Consola SQL** (botón ⌨ junto a la conexión o a una base de datos, o «Consola» desde una tabla):
  - Una consola por conexión y base de datos. Lo escrito se guarda solo, con el cursor, la selección, el desplazamiento y la base elegida. Al volver a abrirla, también tras reiniciar la app, sigue donde se dejó. «Consola» desde una tabla añade su `SELECT` al final.
  - Selector de base de datos. El autocompletado ofrece las tablas y columnas de la base elegida.
  - Entiende alias: tras `r.` en `FROM reservas r` solo sugiere columnas de `reservas`. Prioriza las columnas de las tablas que ya están en la consulta.
  - <kbd>Ctrl</kbd>+<kbd>Enter</kbd> ejecuta la sentencia bajo el cursor (o la selección); <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> ejecuta todo. Respeta `DELIMITER` (MySQL) y `GO` (SQL Server).
  - Resultados en pestañas, límite de filas aplicado en el servidor, cancelar y exportar.
  - En conexiones de solo lectura bloquea las escrituras; en producción pide confirmación.
  - Tras un `CREATE`, `ALTER` o `DROP`, el autocompletado se recarga.
  - **Historial** (botón «Historial» o <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd>, como en DataGrip):
    - Guarda las últimas 500 ejecuciones de cada conexión, con base de datos, fecha, duración, filas y error, si lo hubo.
    - Tiene buscador. <kbd>Enter</kbd> o doble clic insertan la consulta en el cursor, terminada en `;`.
    - Las consultas bloqueadas por solo lectura, o pendientes de confirmar, no se guardan.
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
npm run dist:linux   # dist/gestor-bbdd-<versión>-linux-x86_64.AppImage
npm run dist:win     # dist/gestor-bbdd-<versión>-setup.exe (mejor en Windows o en GitHub Actions)
npm run dist:mac     # dist/gestor-bbdd-<versión>-mac-{arm64,x64}.dmg (solo en macOS o en GitHub Actions)
npm run icons        # regenera resources/icon.png e icon.ico desde icon.svg (rsvg-convert + ImageMagick)
```

Requiere Node.js 22.12 o superior. La primera ejecución descarga el binario de Electron.

## Integración continua y versiones

El flujo `.github/workflows/ci.yml` se ejecuta en GitHub Actions:

| Cuándo | Qué hace |
| --- | --- |
| Push a `main` o pull request | Tipos, tests unitarios, integración contra una MariaDB 11.4 en contenedor y E2E con pantalla virtual (`xvfb`). |
| «Run workflow» a mano (pestaña Actions) | Lo anterior y, además, el AppImage, el `.exe` y los `.dmg`. Quedan como artefactos 7 días. |
| Etiqueta `vX.Y.Z` | Lo anterior y una **Release en borrador** con los instaladores y `SHA256SUMS.txt`. |

Para sacar una versión:

```bash
npm version 0.2.0 -m "Versión %s"   # cambia package.json, hace commit y crea la etiqueta v0.2.0
git push --follow-tags
```

Cuando termine el flujo, la Release aparece en borrador en GitHub → Releases. Se revisa y se pulsa «Publish»: en ese momento las apps instaladas empiezan a detectarla. El flujo falla a propósito si la etiqueta no coincide con la `version` de `package.json`.

Los instaladores de Windows **no van firmados**: Windows SmartScreen avisará al instalarlos hasta que se configure un certificado de firma de código.

La app de macOS tampoco va firmada con un certificado Developer ID ni notarizada (solo firma ad-hoc). Hay un `.dmg` para Apple Silicon (`arm64`) y otro para Intel (`x64`). Para instalarla:

1. Abre el `.dmg` y arrastra Gestor BBDD a Aplicaciones.
2. Ábrela. macOS la bloqueará la primera vez.
3. Ve a **Ajustes del Sistema → Privacidad y seguridad** y pulsa **«Abrir igualmente»**. Otra opción es ejecutar `xattr -cr "/Applications/Gestor BBDD.app"` en el Terminal.

## Actualizaciones automáticas

La app usa [electron-updater](https://www.electron.build/auto-update) y busca versiones nuevas en las Releases **publicadas** de este repositorio. Los borradores no cuentan.

- **Cuándo busca**: a los 10 segundos de arrancar, cada 6 horas y al pulsar el número de versión en la barra de estado.
- **Si encuentra una versión mayor**:
  1. Avisa sin interrumpir.
  2. Muestra las notas de la versión.
  3. La descarga cuando el usuario lo pide; solo baja lo que ha cambiado y comprueba la huella SHA-512.
  4. Se instala al pulsar «Reiniciar ahora», o al cerrar la app.
- **Windows**: el instalador se ejecuta en silencio, conserva la carpeta de instalación y vuelve a abrir la app.
- **Linux**: funciona con el **AppImage**, que se sustituye a sí mismo. Tiene que estar en una carpeta donde el usuario pueda escribir.
- **macOS**: solo avisa. Sin firma Developer ID, Squirrel.Mac rechaza instalar la versión nueva, así que «Descargar en el navegador» abre el `.dmg` de la arquitectura del equipo. Se instala como la primera vez, incluida la autorización en Privacidad y seguridad.
- **Sin firma de código**: la integridad de la descarga se comprueba con la huella SHA-512 de `latest.yml`. Si en el futuro se firma el instalador de Windows, electron-updater exigirá además que la versión nueva esté firmada por el mismo editor.
- **Registro**: lo que hace el actualizador queda en `logs/updater.log`, dentro de la carpeta de datos de la app.

Para publicar una actualización basta con sacar una versión, como se explica en el apartado anterior, y **publicar la Release**. El flujo sube junto a los instaladores `latest.yml`, `latest-linux.yml`, `latest-mac.yml` y el `.blockmap`, que son los ficheros que leen las apps instaladas.

La versión 0.2.0 no incluye el actualizador: hay que instalar a mano una vez la 0.3.0 o posterior.

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

Los datos de la app se guardan en `~/.config/Gestor BBDD/`: `connections.json`, `secrets.json`, `known_hosts.json`, `history.json` y `consoles.json`, todos con permisos 0600.

El historial guarda el texto de las consultas tal cual: si escribes datos sensibles en una consulta, quedan en `history.json`. Se puede borrar desde el panel de historial y se borra junto con la conexión. Los scripts de más de 100.000 caracteres no se guardan. Lo mismo vale para lo escrito en las consolas (`consoles.json`): se borra al vaciar la consola o al borrar la conexión.

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

## Limitaciones conocidas

- **SQL Server:**
  - Solo usuario y contraseña de SQL. Sin autenticación de Windows, Kerberos ni Azure AD.
  - Las instancias con nombre no funcionan por SSH: SQL Browser usa UDP. Hay que indicar el puerto.
  - En la rejilla, los `DECIMAL` se muestran como número de JavaScript: se pierde precisión por encima de 15–16 cifras.
  - El modo solo lectura se aplica solo en la app. Para una garantía total, usa un usuario de solo lectura.
  - Si un SELECT supera el límite de filas dentro de un bloque `BEGIN…END`, se cancela el resto del bloque.
- **SSH:**
  - Sin saltos encadenados (*jump hosts*) y sin leer `~/.ssh/config`.
  - La primera conexión acepta la huella automáticamente. Se muestra en «Probar conexión» y en la barra de estado.
- **Funciones aún no disponibles:** importar CSV.
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

## Licencia

[MIT](LICENSE) © 2026 Jesús Liz Alles.
