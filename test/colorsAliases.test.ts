import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorOf, defaultColorForName } from '../src/shared/defaults';
import { emptyStats, learnFromSql, learnedAlias } from '../src/shared/sqlSmart';

test('automatic colours from the connection name', () => {
  assert.equal(defaultColorForName('KGFS LP Production'), 'red');
  assert.equal(defaultColorForName('KGFS DR'), 'orange');
  assert.equal(defaultColorForName('Prod UAT KGFS'), 'yellow'); // UAT wins over "prod"
  assert.equal(defaultColorForName('Staging'), 'yellow');
  assert.equal(defaultColorForName('local dev'), 'green');
  assert.equal(defaultColorForName('Address book'), undefined); // "dr" only as a word
  assert.equal(colorOf({ name: 'KGFS DR' }), '#f08c2e');
  assert.equal(colorOf({ name: 'KGFS DR', color: 'none' }), undefined);
  assert.equal(colorOf({ name: 'KGFS DR', color: 'blue' }), '#3e7bfa');
});

test('learns the alias you use for a table', () => {
  const s = emptyStats();
  learnFromSql(s, 'select * from financialForms.loan_accounts lac where lac.id = 1', 'financialForms', 'mysql');
  learnFromSql(s, 'select * from loan_accounts lac join customer c on c.id = lac.customer_id', 'financialForms', 'mysql');
  learnFromSql(s, 'select * from loan_accounts l2', 'financialForms', 'mysql');
  assert.equal(learnedAlias(s, 'loan_accounts', []), 'lac');
  assert.equal(learnedAlias(s, 'financialForms.loan_accounts', ['lac']), 'l2'); // most used is taken
  assert.equal(learnedAlias(s, 'customer', []), 'c');
  assert.equal(learnedAlias(s, 'unknown_table', []), undefined);
});
