import { describe, expect, it } from 'vitest'
import { isReadOnlyStatement, splitStatements, statementAt } from '@shared/sql'

const texts = (sql: string, engine: 'mysql' | 'mssql'): string[] => splitStatements(sql, engine).map((s) => s.text)

describe('splitStatements · MySQL', () => {
  it('separa por punto y coma e ignora sentencias vacías', () => {
    expect(texts('SELECT 1;  ;\nSELECT 2;\n', 'mysql')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('no corta dentro de cadenas, backticks ni comentarios', () => {
    const sql = "SELECT 'a;b', `c;d` FROM t; -- x;y\nSELECT \"e\\\";f\"; /* g; */ SELECT 3 # h;\n"
    expect(texts(sql, 'mysql')).toEqual([
      "SELECT 'a;b', `c;d` FROM t",
      'SELECT "e\\";f"',
      'SELECT 3 # h;'
    ])
  })

  it('los comentarios previos no forman parte de la sentencia', () => {
    const sql = '-- cabecera\n/* bloque */\nSELECT 1 -- final\n;'
    expect(splitStatements(sql, 'mysql')).toEqual([
      { text: 'SELECT 1 -- final', start: sql.indexOf('SELECT'), end: sql.indexOf('SELECT') + 17, words: ['SELECT', '1'] }
    ])
  })

  it('los comentarios ejecutables /*! */ de mysqldump son código', () => {
    expect(texts('/*!40101 SET NAMES utf8mb4 */;\n/*+ hint */ SELECT 1;', 'mysql')).toEqual([
      '/*!40101 SET NAMES utf8mb4 */',
      '/*+ hint */ SELECT 1'
    ])
  })

  it('trata "--" sin espacio como operador, no como comentario', () => {
    expect(texts('SELECT 5--1; SELECT 2', 'mysql')).toEqual(['SELECT 5--1', 'SELECT 2'])
  })

  it('respeta DELIMITER para procedimientos', () => {
    const sql = [
      'DELIMITER $$',
      'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$',
      'DELIMITER ;',
      'CALL p();'
    ].join('\n')
    expect(texts(sql, 'mysql')).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'CALL p()'])
  })

  it('omite sentencias que solo tienen comentarios', () => {
    expect(texts('-- nada\n/* tampoco */;SELECT 1', 'mysql')).toEqual(['SELECT 1'])
  })

  it('devuelve offsets que apuntan al texto original', () => {
    const sql = '  SELECT 1;\n\n  SELECT 2  ;'
    for (const s of splitStatements(sql, 'mysql')) expect(sql.slice(s.start, s.end)).toBe(s.text)
  })
})

describe('splitStatements · SQL Server', () => {
  it('separa por GO en línea propia', () => {
    expect(texts('SELECT 1\nGO\nSELECT 2\n  go  \nSELECT 3', 'mssql')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
  })

  it('no confunde GO dentro de una línea o en un identificador', () => {
    expect(texts('SELECT go FROM t\nSELECT [GO]', 'mssql')).toEqual(['SELECT go FROM t\nSELECT [GO]'])
  })

  it('no corta dentro de BEGIN…END ni de CASE…END', () => {
    const sql = "IF 1=1 BEGIN SELECT 1; SELECT CASE WHEN 1=1 THEN 'a;' END; END; SELECT 2;"
    expect(texts(sql, 'mssql')).toEqual(["IF 1=1 BEGIN SELECT 1; SELECT CASE WHEN 1=1 THEN 'a;' END; END", 'SELECT 2'])
  })

  it('BEGIN TRAN no abre bloque', () => {
    expect(texts('BEGIN TRAN; UPDATE t SET a = 1; COMMIT;', 'mssql')).toEqual(['BEGIN TRAN', 'UPDATE t SET a = 1', 'COMMIT'])
  })

  it('un CREATE PROCEDURE ocupa todo el lote', () => {
    const sql = 'CREATE OR ALTER PROCEDURE p AS SELECT 1; SELECT 2;\nGO\nEXEC p;'
    expect(texts(sql, 'mssql')).toEqual(['CREATE OR ALTER PROCEDURE p AS SELECT 1; SELECT 2;', 'EXEC p'])
  })

  it('admite corchetes con ]] escapado y comentarios anidados', () => {
    expect(texts('SELECT [a]];b] /* x /* y; */ z; */; SELECT 2', 'mssql')).toEqual([
      'SELECT [a]];b] /* x /* y; */ z; */',
      'SELECT 2'
    ])
  })

  it('las comillas simples no usan barra invertida como escape', () => {
    expect(texts("SELECT 'C:\\'; SELECT 2", 'mssql')).toEqual(["SELECT 'C:\\'", 'SELECT 2'])
  })
})

describe('statementAt', () => {
  const sql = 'SELECT 1;\n\nSELECT 2;\nSELECT 3'
  const stmts = splitStatements(sql, 'mysql')

  it('elige la sentencia que contiene el cursor', () => {
    expect(statementAt(stmts, sql.indexOf('2'))?.text).toBe('SELECT 2')
  })

  it('entre sentencias elige la anterior', () => {
    expect(statementAt(stmts, sql.indexOf('\n\n') + 1)?.text).toBe('SELECT 1')
  })

  it('antes de la primera elige la primera', () => {
    expect(statementAt(splitStatements('  SELECT 1', 'mysql'), 0)?.text).toBe('SELECT 1')
  })
})

describe('isReadOnlyStatement', () => {
  const ro = (sql: string, engine: 'mysql' | 'mssql' = 'mysql'): boolean =>
    isReadOnlyStatement(splitStatements(sql, engine)[0]!.words)

  it.each([
    'SELECT * FROM t',
    'show tables',
    'DESCRIBE t',
    'EXPLAIN SELECT 1',
    "SELECT 'DROP TABLE x' AS s",
    'WITH c AS (SELECT 1) SELECT * FROM c',
    '/* DELETE */ SELECT 1',
    'SELECT REPLACE(nombre, "a", "b") FROM t'
  ])('lectura: %s', (sql) => expect(ro(sql)).toBe(true))

  it.each([
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'INSERT t VALUES (1)',
    'DROP TABLE t',
    'SELECT * INTO copia FROM t',
    'SELECT * FROM t FOR UPDATE',
    'WITH c AS (SELECT 1) DELETE FROM t',
    'CALL p()',
    'SET GLOBAL max_connections = 10',
    'TRUNCATE t'
  ])('escritura: %s', (sql) => expect(ro(sql)).toBe(false))

  it('EXEC en SQL Server es escritura', () => expect(ro('EXEC sp_who', 'mssql')).toBe(false))
})
