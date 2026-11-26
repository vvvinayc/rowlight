import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTables, defaultKey, isReadOnlyQuery } from '../src/shared/compare';

const lp = { columns: ['id', 'current_stage', 'amount'], rows: [[1, 'Disbursed', '100.50'], [2, 'Approved', '200.00'], [3, 'Closed', '5']] };
const dr = { columns: ['id', 'current_stage', 'amount'], rows: [[2, 'Approved', '200.0'], [1, 'Approved', '100.50'], [4, 'New', '1']] };

test('matches by id, finds changed cells and rows on one side only', () => {
  const d = compareTables(lp, dr);
  assert.equal(d.key, 'id');
  assert.deepEqual(d.counts, { same: 1, changed: 1, onlyA: 1, onlyB: 1 });
  const changed = d.rows.find((r) => r.status === 'changed')!;
  assert.deepEqual(changed.diff, [1]);
  assert.equal(changed.a![1], 'Disbursed');
  assert.equal(changed.b![1], 'Approved');
});

test('identical results', () => {
  assert.deepEqual(compareTables(lp, { ...lp, rows: [...lp.rows].reverse() }).counts, { same: 3, changed: 0, onlyA: 0, onlyB: 0 });
});

test('no unique key: matched by row order; count(*) style results', () => {
  const a = { columns: ['c', 'm'], rows: [[10, '2026-11-25']] };
  const b = { columns: ['c', 'm'], rows: [[9, '2026-11-24']] };
  const d = compareTables(a, b);
  assert.equal(d.key, 'c'); // first column, unique
  assert.deepEqual(d.counts, { same: 0, changed: 0, onlyA: 1, onlyB: 1 });
  const byOrder = compareTables(a, b, null);
  assert.deepEqual(byOrder.counts, { same: 0, changed: 1, onlyA: 0, onlyB: 0 });
  assert.equal(defaultKey({ columns: ['x'], rows: [[1], [1]] }, { columns: ['x'], rows: [[1]] }), null);
});

test('different columns are reported', () => {
  const d = compareTables({ columns: ['id', 'a'], rows: [[1, 'x']] }, { columns: ['id', 'b'], rows: [[1, 'y']] });
  assert.deepEqual([d.onlyAColumns, d.onlyBColumns, d.counts.same], [['a'], ['b'], 1]);
});

test('only SELECT-like queries are allowed', () => {
  assert.ok(isReadOnlyQuery('select * from loan_accounts where note = \'update me\''));
  assert.ok(isReadOnlyQuery('-- check\nWITH x AS (select 1) select * from x'));
  assert.ok(isReadOnlyQuery('select last_update, created_by from t'));
  assert.ok(!isReadOnlyQuery('update t set a = 1'));
  assert.ok(!isReadOnlyQuery('select 1; delete from t'));
  assert.ok(!isReadOnlyQuery("select * into outfile '/tmp/x' from t"));
});
