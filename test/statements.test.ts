import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSql, smartStatements, statementAt, withSemicolons } from '../src/shared/sqlSmart';

const split = (t: string, blankLines = true, dialect: 'mysql' | 'mssql' = 'mysql') =>
  smartStatements(t, { blankLines, dialect }).map((r) => t.slice(r.start, r.end));

test('blank line between two statements splits them', () => {
  const t = "select * from financialForms.loan_accounts la\nWHERE la.account_number = '2026'\n\nselect * from financialForms.loan_accounts la\nWHERE la.account_number = '2026'\n";
  assert.equal(split(t).length, 2);
  assert.equal(split(t, false).length, 1);
  const fixed = withSemicolons(t, smartStatements(t, { blankLines: true, dialect: 'mysql' }));
  assert.equal(fixed, "select * from financialForms.loan_accounts la\nWHERE la.account_number = '2026';\n\nselect * from financialForms.loan_accounts la\nWHERE la.account_number = '2026'\n");
  assert.equal(fixed.split('\n').length, t.split('\n').length, 'line numbers unchanged');
});

test('";" still splits; ";" plus a blank line is not doubled', () => {
  assert.deepEqual(split('select 1;\n\nselect 2;\nselect 3'), ['select 1', 'select 2', 'select 3']);
  const t = 'select 1;\n\nselect 2';
  assert.equal(withSemicolons(t, smartStatements(t, { blankLines: true, dialect: 'mysql' })), t);
});

test('a blank line inside one statement does not split it', () => {
  const cases = [
    'select *\n\nfrom t\n\nwhere a = 1',                        // next line is FROM / WHERE
    'select * from t where id in (\n\nselect id from u)',           // inside brackets
    'select a from t\nunion all\n\nselect a from u',                // after UNION ALL
    'insert into t (a, b)\n\nselect a, b from u',                   // INSERT waiting for SELECT
    'create view v as\n\nselect * from t',                          // after AS
    'update t\n\nset a = 1 where id = 2',                           // UPDATE waiting for SET
    'with x as (select 1)\n\nselect * from x',                      // WITH waiting for SELECT
    "select 'a\n\nselect b' from t",                                // inside a string
    'select 1 -- note\n/* \n\nselect 2 */ from dual',               // inside a comment
    'select a,\n\nb from t',                                        // after a comma
    'select * from t where a =\n\n(select 1)',                     // after =
  ];
  for (const c of cases) assert.equal(split(c).length, 1, c);
});

test('mixed statements split at blank lines', () => {
  assert.deepEqual(split('update t set a = 1 where id = 2\n\nselect * from t\n\n\n  show tables'),
    ['update t set a = 1 where id = 2', 'select * from t', 'show tables']);
  assert.deepEqual(split('insert into t (a) values (1)\n\ninsert into t (a) values (2)'),
    ['insert into t (a) values (1)', 'insert into t (a) values (2)']);
});

test('BEGIN … END blocks are only split on ";"', () => {
  assert.equal(split('create procedure p() begin\nselect 1\n\nselect 2\nend').length, 1);
  // but a transaction BEGIN does not turn the feature off
  assert.equal(split('begin;\nselect 1\n\nselect 2').length, 3);
});

test('SQL Server: GO lines and blank lines split', () => {
  assert.deepEqual(split('select 1\nGO\nselect 2\n\nselect 3', true, 'mssql'), ['select 1', 'select 2', 'select 3']);
});

test('statementAt: statement under the cursor, or the one above it', () => {
  const t = 'select 1\nfrom dual\n\n\nselect 2;\nselect 3';
  const rs = smartStatements(t, { blankLines: true, dialect: 'mysql' });
  const at = (o: number) => { const r = statementAt(rs, o)!; return t.slice(r.start, r.end); };
  assert.equal(at(0), 'select 1\nfrom dual');
  assert.equal(at(t.indexOf('dual') + 2), 'select 1\nfrom dual');
  assert.equal(at(t.indexOf('dual') + 6), 'select 1\nfrom dual'); // on the blank line below
  assert.equal(at(t.indexOf('select 2') + 3), 'select 2');
  assert.equal(at(t.indexOf('select 2') + 9), 'select 2');        // just after the ";"
  assert.equal(at(t.length), 'select 3');
  assert.equal(statementAt([], 0), undefined);
});

test('lintSql sees blank-line statements as separate', () => {
  const hints = lintSql('update t set a = 1\n\nselect * from t where id = 1', '', 'mysql');
  assert.ok(hints.some((h) => h.kind === 'noWhere'));
});
