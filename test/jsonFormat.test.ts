import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonError, looksLikeJson, minifyJson, prettyJson } from '../src/shared/jsonFormat';

const cell = '{"UTR": "IDFB6324M9075648", "FEE3": null, "UDF4": 99.915254237, "UDF20": 655.00, "big": 12345678901234567890, "list": [1, "a,b", {}], "e": []}';

test('pretty keeps values exactly as written', () => {
  const p = prettyJson(cell);
  assert.equal(p, [
    '{',
    '  "UTR": "IDFB6324M9075648",',
    '  "FEE3": null,',
    '  "UDF4": 99.915254237,',
    '  "UDF20": 655.00,',
    '  "big": 12345678901234567890,',
    '  "list": [',
    '    1,',
    '    "a,b",',
    '    {}',
    '  ],',
    '  "e": []',
    '}',
  ].join('\n'));
  assert.deepEqual(JSON.parse(p), JSON.parse(cell));
});

test('strings with quotes, braces and colons are untouched', () => {
  const s = '{"a":"x\\"{y}:[z]","b":"c\\\\"}';
  assert.equal(minifyJson(prettyJson(s)), s);
});

test('minify', () => {
  assert.equal(minifyJson('{\n  "a": 1,\n  "b": [ 2, 3 ]\n}'), '{"a":1,"b":[2,3]}');
});

test('detection', () => {
  assert.ok(looksLikeJson('  {"a":1}'));
  assert.ok(looksLikeJson('[1,2]'));
  assert.ok(!looksLikeJson('[dbo].[loan] select 1'));
  assert.ok(!looksLikeJson('select * from t'));
});

test('cut-off JSON is still laid out, and the error says where', () => {
  const cut = '{"UTR": "X", "UDF20": 655.00, ';
  assert.equal(prettyJson(cut), '{\n  "UTR": "X",\n  "UDF20": 655.00,');
  assert.match(jsonError(cut) ?? '', /line 1/);
  assert.equal(jsonError('{"a":1}'), null);
});
