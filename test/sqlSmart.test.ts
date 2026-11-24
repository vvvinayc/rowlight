import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clauseAt, closestNames, emptyStats, learnFromSql, learnedJoinConditions, lintSql, parseMissingName, replaceName, selectItems,
} from '../src/shared/sqlSmart';
import { parseTableRefs } from '../src/shared/sqlAssist';

test('clauseAt: the clause under the cursor', () => {
  assert.equal(clauseAt(''), 'start');
  assert.equal(clauseAt('SELECT '), 'select');
  assert.equal(clauseAt('SELECT a, COUNT('), 'select');
  assert.equal(clauseAt('SELECT * FROM t WHERE '), 'where');
  assert.equal(clauseAt('SELECT * FROM t WHERE a = 1 AND '), 'where');
  assert.equal(clauseAt('SELECT a FROM t GROUP BY '), 'groupBy');
  assert.equal(clauseAt('SELECT a FROM t GROUP BY a ORDER BY '), 'orderBy');
  assert.equal(clauseAt('SELECT a FROM t GROUP BY a HAVING '), 'having');
  assert.equal(clauseAt('SELECT * FROM t WHERE id IN (SELECT x FROM y WHERE '), 'where');
  assert.equal(clauseAt('SELECT * FROM t WHERE id IN (SELECT '), 'select');
  assert.equal(clauseAt('SELECT * FROM t WHERE id IN (SELECT x FROM y) ORDER BY '), 'orderBy');
  assert.equal(clauseAt("SELECT * FROM t WHERE name = 'group by x' AND "), 'where');
  assert.equal(clauseAt('UPDATE t SET '), 'set');
});

test('selectItems: expressions, aliases, aggregates', () => {
  const items = selectItems("SELECT la.branch_id, DATE_FORMAT(la.created_at, '%Y-%m') AS month, COUNT(*) cnt, SUM(amount) total, name FROM loan_accounts la GROUP BY 1");
  assert.deepEqual(items.map((i) => [i.expr, i.alias ?? '', i.aggregated]), [
    ['la.branch_id', '', false],
    ["DATE_FORMAT(la.created_at, '%Y-%m')", 'month', false],
    ['COUNT(*)', 'cnt', true],
    ['SUM(amount)', 'total', true],
    ['name', '', false],
  ]);
  assert.deepEqual(selectItems('SELECT CASE WHEN a > 1 THEN 1 ELSE 0 END flag FROM t').map((i) => i.alias), ['flag']);
});

test('learn from history: tables, columns and the user\'s own joins (no foreign keys needed)', () => {
  const s = emptyStats();
  learnFromSql(s, 'SELECT * FROM loan_accounts la JOIN customer c ON c.id = la.customer_id WHERE la.status = 1', 'lms', 'mysql');
  learnFromSql(s, 'SELECT * FROM customer x JOIN loan_accounts y ON y.customer_id = x.id', 'lms', 'mysql');
  learnFromSql(s, 'SELECT * FROM customer WHERE urn_no = 5', 'lms', 'mysql');
  assert.equal(s.tables.get('lms.customer'), 3);
  assert.equal(s.columns.get('loan_accounts.status'), 1);
  assert.equal(s.columns.get('customer.urn_no'), 1);
  // a new query with different aliases gets the learned condition, written with ITS aliases
  const text = 'SELECT * FROM customer cu JOIN loan_accounts l ON ';
  const refs = parseTableRefs(text, 'lms', 'mysql');
  const conds = learnedJoinConditions(s, refs[1], [refs[0]]);
  assert.equal(conds[0].cond, 'l.customer_id = cu.id');
  assert.equal(conds[0].count, 2);
});

test('did you mean: misspelled columns and tables', () => {
  assert.deepEqual(parseMissingName("Unknown column 'la.custmer_id' in 'where clause'"), { kind: 'column', name: 'custmer_id', qualifier: 'la' });
  assert.deepEqual(parseMissingName("Table 'lms.loan_acounts' doesn't exist"), { kind: 'table', name: 'loan_acounts', qualifier: 'lms' });
  assert.deepEqual(parseMissingName("Invalid column name 'amout'."), { kind: 'column', name: 'amout', qualifier: undefined });
  assert.equal(parseMissingName('Syntax error near x'), null);
  assert.deepEqual(closestNames('custmer_id', ['customer_id', 'branch_id', 'id', 'customer_name']), ['customer_id']);
  assert.deepEqual(closestNames('customerid', ['customer_id', 'created_at']), ['customer_id']);
  assert.deepEqual(closestNames('zzz', ['customer_id']), []);
  assert.equal(replaceName('SELECT la.custmer_id FROM t la WHERE la.custmer_id = 1', { kind: 'column', name: 'custmer_id', qualifier: 'la' }, 'customer_id'),
    'SELECT la.customer_id FROM t la WHERE la.customer_id = 1');
  assert.equal(replaceName('SELECT amout, x.amout2 FROM t', { kind: 'column', name: 'amout' }, 'amount'), 'SELECT amount, x.amout2 FROM t');
});

test('safety hints: UPDATE/DELETE without WHERE, JOIN without ON, SELECT *', () => {
  const kinds = (sql: string) => lintSql(sql, 'lms', 'mysql').map((h) => h.kind);
  assert.deepEqual(kinds('UPDATE t SET a = 1'), ['noWhere']);
  assert.deepEqual(kinds('UPDATE t SET a = 1 WHERE id = 2'), []);
  assert.deepEqual(kinds('DELETE FROM t'), ['noWhere']);
  assert.deepEqual(kinds("DELETE FROM t WHERE id IN (SELECT id FROM x)"), []);
  assert.deepEqual(kinds("UPDATE t SET a = 'where'"), ['noWhere']);
  assert.deepEqual(kinds('SELECT a.x FROM a JOIN b WHERE a.id = 1'), ['joinNoOn']);
  assert.deepEqual(kinds('SELECT a.x FROM a JOIN b ON b.a_id = a.id JOIN c USING (id) WHERE 1'), []);
  assert.deepEqual(kinds('SELECT a.x FROM a CROSS JOIN b WHERE 1'), []);
  const star = lintSql('SELECT * FROM loan_accounts;\nSELECT * FROM x WHERE id = 1', 'lms', 'mysql');
  assert.deepEqual(star.map((h) => h.kind), ['selectStar']);
  assert.equal(star[0].refs?.[0].table, 'loan_accounts');
});
