import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillParams, findParams, sqlLiteral } from '../src/shared/sqlParams';
import { jsonTopLevel } from '../src/shared/jsonFormat';

test('finds :name parameters, not strings, comments, := or ::', () => {
  const sql = "select * from loan_accounts la where la.id = :loan and la.branch = :branch -- :not_this\n" +
    "and la.note <> ':nope' and @x := 1 and t::int and la.id <> :loan and la.time > '10:30'";
  assert.deepEqual(findParams(sql), ['loan', 'branch']);
});

test('fills values: numbers as is, text quoted, lists, NULL, raw', () => {
  assert.equal(fillParams('where id = :loan and b = :b', { loan: '669586', b: "O'Hara" }), "where id = 669586 and b = 'O''Hara'");
  assert.equal(sqlLiteral('1, 2,3'), '1, 2,3');
  assert.equal(sqlLiteral('null'), 'NULL');
  assert.equal(sqlLiteral("('A','B')"), "('A','B')");
  assert.equal(sqlLiteral('A2026'), "'A2026'");
  assert.equal(fillParams('where id in (:ids)', { ids: '1,2,3' }), 'where id in (1,2,3)');
  assert.equal(fillParams('a = :x', {}), 'a = :x');
});

test('JSON keys with values exactly as written', () => {
  assert.deepEqual(jsonTopLevel('{"UTR": "IDFB6324M9075648", "FEE3": null, "UDF20": 655.00, "o": {"a": [1, 2]}, "s": "a,\\"b\\"}"}'),
    { UTR: 'IDFB6324M9075648', FEE3: null, UDF20: '655.00', o: '{"a":[1,2]}', s: 'a,"b"}' });
  assert.equal(jsonTopLevel('[1,2]'), null);
  assert.deepEqual(jsonTopLevel('{}'), {});
});
