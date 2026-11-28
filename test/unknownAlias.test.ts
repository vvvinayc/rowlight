import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unknownQualifiers } from '../src/shared/sqlSmart';

const names = (sql: string, dbs: string[] = []) => unknownQualifiers(sql, 'financialForms', dbs).map((u) => u.name);

test('alias copied from another query is reported', () => {
  assert.deepEqual(names('update financialForms.putb_disbursement_confirmation_upload_details_v3\nset la.account_number = 1'), ['la']);
  assert.deepEqual(names('select la.id from loan_accounts l'), ['la']);
});

test('known names are not reported', () => {
  assert.deepEqual(names('select la.id, la.* from financialForms.loan_accounts la where la.id = 1'), []);
  assert.deepEqual(names('select loan_accounts.id from loan_accounts'), []); // table name as qualifier
  assert.deepEqual(names('select d.x from (select 1 x) d'), []); // derived table
  assert.deepEqual(names('with recent as (select 1 id) select recent.id from recent'), []); // CTE
  assert.deepEqual(names("select * from t where t.note = 'la.x' -- la.y"), []); // strings / comments
  assert.deepEqual(names('select encoredb.loan.id from encoredb.loan'), []); // db.table.column
  assert.deepEqual(names('select bi.report_master.id from loan_accounts', ['bi']), []); // known database
  assert.deepEqual(names('select a.id from x a join y b on b.a_id = a.id'), []);
  assert.deepEqual(names('select 1.5, x.y'), []); // no FROM: nothing to check
});

test('each statement on its own', () => {
  assert.deepEqual(names('select la.id from loan_accounts la;\n\nselect la.id from customer c'), ['la']);
});
