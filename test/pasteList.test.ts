import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listPaste, pastedList, toSqlList } from '../src/shared/pasteList';

const IDS = '6af45bf6ae299d226bcec41f\r\n6af5b5b9c99e75044eeeaad5\r\n6afbe3c2414e75185d853211\r\n';
const Q = "'6af45bf6ae299d226bcec41f', '6af5b5b9c99e75044eeeaad5', '6afbe3c2414e75185d853211'";

test('detects a pasted column of values', () => {
  assert.deepEqual(pastedList(IDS), ['6af45bf6ae299d226bcec41f', '6af5b5b9c99e75044eeeaad5', '6afbe3c2414e75185d853211']);
  assert.deepEqual(pastedList("'a',\n'b',\n"), ['a', 'b']);
  assert.deepEqual(pastedList('1\t2\t3'), ['1', '2', '3']);
  assert.equal(pastedList('single'), null);
  assert.equal(pastedList('select *\nfrom t'), null);
  assert.equal(pastedList('where\nand'), null);
});

test('quotes text, keeps numbers, codes with leading 0 are text', () => {
  assert.equal(toSqlList(['1', '22', '3.5']), '1, 22, 3.5');
  assert.equal(toSqlList(['007', '8']), "'007', '8'");
  assert.equal(toSqlList(["o'x", 'y']), "'o''x', 'y'");
  assert.equal(toSqlList(Array.from({ length: 12 }, (_, i) => String(i + 1))).split('\n').length, 14);
});

test('after IN ( / IN / = / <>', () => {
  assert.deepEqual(listPaste('select * from loan_accounts where loan_id in (', IDS), { replaceBefore: 0, text: Q, note: '3 values pasted as a list' });
  assert.equal(listPaste('where loan_id in ', IDS)!.text, `(${Q})`);
  const eq = listPaste('update t set a = 1 where loan_id = ', IDS)!;
  assert.equal(eq.replaceBefore, 2);
  assert.equal(eq.text, `in (${Q})`); // "loan_id = " -> "loan_id in (…)"
  assert.equal(listPaste('where loan_id<>', '1\n2')!.text, ' not in (1, 2)');
});

test('left alone: inside strings / comments, or where no list is expected', () => {
  assert.equal(listPaste("where note = '", IDS), null);
  assert.equal(listPaste('-- where id in (', IDS), null);
  assert.equal(listPaste('select * from t where ', IDS), null);
  assert.equal(listPaste('', IDS), null);
  assert.equal(listPaste("where a = 'x' and id in (", IDS)!.text, Q);
});
