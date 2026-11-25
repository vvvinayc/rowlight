import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixBareStars } from '../src/shared/sqlSmart';

const fix = (s: string) => fixBareStars(s).sql;

test('bare * after columns gets the alias', () => {
  assert.equal(
    fix('select lads.current_stage, lads.last_edited_at, * from financialForms.loan_account_disbursement_schedule lads\nwhere loan_id = 669586'),
    'select lads.current_stage, lads.last_edited_at, lads.* from financialForms.loan_account_disbursement_schedule lads\nwhere loan_id = 669586');
  assert.equal(fix('select id, * from loan_accounts'), 'select id, loan_accounts.* from loan_accounts');
  assert.equal(fix('select id, * from fin.loan_accounts as la'), 'select id, la.* from fin.loan_accounts as la');
});

test('several tables: every table, like * means', () => {
  assert.equal(fix('select la.id, * from loan_accounts la join customer c on c.id = la.customer_id where 1'),
    'select la.id, la.*, c.* from loan_accounts la join customer c on c.id = la.customer_id where 1');
  assert.equal(fix('select a.x, * from a, b y'), 'select a.x, a.*, y.* from a, b y');
  assert.equal(fix('select x.n, * from (select 1 n) x'), 'select x.n, x.* from (select 1 n) x');
});

test('left alone: * first, COUNT(*), qualified *, no FROM, strings, comments', () => {
  for (const s of [
    'select * from t',
    'select *, id from t',
    'select count(*), id from t',
    'select id, t.* from t',
    'select 1, 2',
    "select id, '*' from t",
    'select id -- , *\nfrom t',
    'select a * b, c from t',
  ]) assert.equal(fix(s), s, s);
});

test('sub-queries and several statements', () => {
  assert.equal(fix('select id from t where id in (select u.id, * from u)'), 'select id from t where id in (select u.id, u.* from u)');
  assert.equal(fix('select a, * from t;\nselect b, * from u v'), 'select a, t.* from t;\nselect b, v.* from u v');
  assert.equal(fix('select a, * from t\n\nselect b, * from u v'), 'select a, t.* from t\n\nselect b, v.* from u v');
});
