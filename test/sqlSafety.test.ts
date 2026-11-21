// Run with: npm test   (Node 22.18+ runs .ts files directly)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMssqlRowcount, applyMysqlLimit, checkReadOnly, splitStatements } from '../src/main/sqlSafety.ts';

const ro = (sql: string, d: 'mysql' | 'mssql' = 'mysql') => checkReadOnly(sql, d);

test('splits MySQL scripts on top-level semicolons only', () => {
  assert.deepEqual(splitStatements("select 1; select ';' as x; -- c;\nselect `a;b` from t", 'mysql'),
    ['select 1', "select ';' as x", '-- c;\nselect `a;b` from t']);
  assert.deepEqual(splitStatements(' ; -- only a comment\n', 'mysql'), []);
});

test('splits SQL Server scripts on GO lines', () => {
  assert.deepEqual(splitStatements('select 1\nGO\nselect 2\n go \n', 'mssql'), ['select 1', 'select 2']);
});

test('MySQL read-only allows reads', () => {
  for (const s of [
    'SELECT * FROM loans', 'select replace(name, "a", "b") from t', "select 'delete from x' as s",
    'SHOW TABLES', 'SHOW CREATE TABLE loans', 'DESCRIBE loans', 'EXPLAIN SELECT 1', 'USE lms',
    'WITH c AS (SELECT 1) SELECT * FROM c', '(SELECT 1) UNION (SELECT 2)', 'SET @x = 5',
    'select * from t for update', 'select insert("abc", 1, 1, "x")', 'select * from t -- update later',
  ]) assert.equal(ro(s), null, s);
});

test('MySQL read-only blocks writes / DDL / tricks', () => {
  for (const s of [
    'INSERT INTO t VALUES (1)', 'update t set a=1', 'DELETE FROM t', 'REPLACE INTO t VALUES (1)',
    'DROP TABLE t', 'CREATE TABLE x (a int)', 'ALTER TABLE t ADD c int', 'TRUNCATE t', 'CALL p()',
    'GRANT ALL ON *.* TO x', 'LOAD DATA INFILE "x" INTO TABLE t', 'START TRANSACTION READ WRITE',
    'SET SESSION TRANSACTION READ WRITE', 'SET GLOBAL read_only = 0', 'SET @@session.transaction_read_only = 0',
    'WITH c AS (SELECT 1) DELETE FROM t', "SELECT * FROM t INTO OUTFILE '/tmp/x'", '/*!50000 DELETE FROM t */',
    'LOCK TABLES t WRITE', 'RENAME TABLE a TO b',
  ]) assert.notEqual(ro(s), null, s);
});

test('SQL Server read-only', () => {
  assert.equal(ro('SELECT TOP 10 * FROM dbo.loans WHERE x = 1', 'mssql'), null);
  assert.equal(ro("DECLARE @d date = GETDATE(); SELECT @d", 'mssql'), null);
  for (const s of ['SELECT 1 DELETE FROM t', 'SELECT * INTO newt FROM t', 'EXEC sp_who', 'sp_configure', 'UPDATE t SET a = 1', 'MERGE t USING s ON 1=1 WHEN MATCHED THEN DELETE;'])
    assert.notEqual(ro(s, 'mssql'), null, s);
});

test('auto LIMIT for MySQL', () => {
  assert.equal(applyMysqlLimit('SELECT * FROM t', 1000).sql, 'SELECT * FROM t LIMIT 1000');
  assert.equal(applyMysqlLimit('SELECT * FROM t -- note', 1000).sql, 'SELECT * FROM t LIMIT 1000 -- note');
  assert.equal(applyMysqlLimit('SELECT * FROM t LIMIT 5', 1000).applied, false);
  assert.equal(applyMysqlLimit('SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 3)', 1000).applied, true);
  assert.equal(applyMysqlLimit('SELECT * FROM t FOR UPDATE', 1000).applied, false);
  assert.equal(applyMysqlLimit('SELECT 1 INTO @x', 1000).applied, false);
  assert.equal(applyMysqlLimit('SHOW TABLES', 1000).applied, false);
  assert.equal(applyMysqlLimit('UPDATE t SET a = 1', 1000).applied, false);
  assert.equal(applyMysqlLimit('WITH c AS (SELECT 1) SELECT * FROM c', 50).sql, 'WITH c AS (SELECT 1) SELECT * FROM c LIMIT 50');
  assert.equal(applyMysqlLimit('SELECT * FROM t', 0).applied, false);
});

test('SQL Server row cap only on pure reads without TOP', () => {
  assert.deepEqual(applyMssqlRowcount('SELECT * FROM t', 1000), { sql: 'SET ROWCOUNT 1000; SELECT * FROM t', applied: true });
  assert.equal(applyMssqlRowcount('SELECT TOP 5 * FROM t', 1000).applied, false);
  assert.equal(applyMssqlRowcount('UPDATE t SET a = 1', 1000).sql, 'SET ROWCOUNT 0; UPDATE t SET a = 1');
});
