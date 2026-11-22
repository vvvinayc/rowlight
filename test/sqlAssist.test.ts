import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTablePosition, joinOnTarget, makeAlias, parseTableRefs, suggestJoinConditions } from '../src/shared/sqlAssist';
import type { ColumnInfo } from '../src/shared/types';

test('makeAlias: initials, unique, never a keyword', () => {
  assert.equal(makeAlias('loan_accounts', []), 'la');
  assert.equal(makeAlias('customer', []), 'c');
  assert.equal(makeAlias('CustomerAddress', []), 'ca');
  assert.equal(makeAlias('dbo.loan_repayment_schedule', []), 'lrs');
  assert.equal(makeAlias('customer', ['c']), 'c2');
  assert.equal(makeAlias('order_status', []), 'os');
  assert.equal(makeAlias('order_numbers', []), 'ord'); // initials would be the keyword ON
  assert.equal(makeAlias('in_transit', []), 'it');
  assert.equal(makeAlias('ab', ['a']), 'a2');
});

test('parseTableRefs reads FROM, comma lists and JOINs with aliases', () => {
  const sql = 'SELECT * FROM loans l, customer AS c JOIN lms.branch b ON b.id = l.branch_id LEFT JOIN payments WHERE 1';
  const refs = parseTableRefs(sql, 'lms', 'mysql').map((r) => `${r.db}.${r.table}:${r.qualifier}`);
  assert.deepEqual(refs, ['lms.loans:l', 'lms.customer:c', 'lms.branch:b', 'lms.payments:payments']);
});

test('isTablePosition', () => {
  assert.equal(isTablePosition('SELECT * FROM '), true);
  assert.equal(isTablePosition('SELECT * FROM loans l JOIN '), true);
  assert.equal(isTablePosition('SELECT * FROM loans l, '), true);
  assert.equal(isTablePosition('SELECT a, '), false);
  assert.equal(isTablePosition('SELECT * FROM loans l WHERE a IN (1, '), false);
});

test('joinOnTarget finds the table just joined', () => {
  const before = 'SELECT * FROM loans l JOIN customer c ON ';
  const refs = parseTableRefs(before, 'lms', 'mysql');
  assert.equal(refs[joinOnTarget(before, refs)].qualifier, 'c');
  assert.equal(joinOnTarget('SELECT * FROM loans l WHERE ', refs), -1);
});

const cols = (...names: string[]): ColumnInfo[] => names.map((n, i) => ({ name: n, type: 'bigint', nullable: false, key: i === 0 ? 'PRI' : '' }));

test('suggestJoinConditions: foreign keys, naming conventions, shared *_id columns', () => {
  const before = 'SELECT * FROM loan_accounts la JOIN customers c ON ';
  const refs = parseTableRefs(before, 'lms', 'mysql');
  const target = refs[joinOnTarget(before, refs)];
  const out = suggestJoinConditions(
    target, cols('id', 'branch_id'),
    [{ ref: refs[0], cols: cols('id', 'customer_id', 'branch_id', 'amount') }],
    [{ table: 'loan_accounts', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }],
  );
  assert.equal(out[0], 'la.customer_id = c.id'); // from the FK
  assert.ok(out.includes('c.branch_id = la.branch_id')); // shared *_id column
  // without any FK, the naming convention still finds it (customers → customer_id)
  const noFk = suggestJoinConditions(target, cols('id'), [{ ref: refs[0], cols: cols('id', 'customer_id') }], []);
  assert.deepEqual(noFk, ['la.customer_id = c.id']);
});

test('plural table names: branches → branch_id, categories → category_id', () => {
  const before = 'SELECT * FROM loan_accounts la JOIN customers c ON la.customer_id = c.id JOIN branches b ON ';
  const refs = parseTableRefs(before, 'lms', 'mysql');
  const ti = joinOnTarget(before, refs);
  const out = suggestJoinConditions(refs[ti], cols('id', 'branch_name'), [
    { ref: refs[0], cols: cols('id', 'customer_id', 'branch_id') },
    { ref: refs[1], cols: cols('id', 'branch_id') },
  ], []);
  assert.deepEqual(out, ['la.branch_id = b.id', 'c.branch_id = b.id']);
  const cat = parseTableRefs('SELECT * FROM products p JOIN categories k ON ', 'x', 'mysql');
  assert.deepEqual(suggestJoinConditions(cat[1], cols('id'), [{ ref: cat[0], cols: cols('id', 'category_id') }], []), ['p.category_id = k.id']);
});
