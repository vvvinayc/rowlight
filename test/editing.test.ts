import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEditInfo, buildStatements, previewStatements, simpleSelectTable } from '../src/main/editing';
import type { ChangeSet, ColumnInfo } from '../src/shared/types';

const cols: ColumnInfo[] = [
  { name: 'id', type: 'bigint', nullable: false, key: 'PRI' },
  { name: 'status', type: 'varchar(20)', nullable: true, key: '' },
  { name: 'amount', type: 'decimal(12,2)', nullable: true, key: '' },
];

test('simpleSelectTable (SQL Server) finds the single table', () => {
  assert.deepEqual(simpleSelectTable('SELECT * FROM dbo.loans WHERE id > 5', 'mssql'), { table: 'dbo.loans' });
  assert.deepEqual(simpleSelectTable('SELECT TOP 10 * FROM [lms].[dbo].[Loans] l ORDER BY id', 'mssql'), { database: 'lms', table: 'dbo.Loans' });
  assert.deepEqual(simpleSelectTable('select id from Loans', 'mssql'), { table: 'dbo.Loans' });
  assert.equal(typeof simpleSelectTable('SELECT * FROM a JOIN b ON a.id = b.id', 'mssql'), 'string');
  assert.equal(typeof simpleSelectTable('SELECT * FROM a, b', 'mssql'), 'string');
  assert.equal(typeof simpleSelectTable('SELECT status, COUNT(*) FROM a GROUP BY status', 'mssql'), 'string');
  assert.equal(typeof simpleSelectTable('SELECT 1', 'mssql'), 'string');
  // subquery in WHERE is fine
  assert.deepEqual(simpleSelectTable('SELECT * FROM t WHERE id IN (SELECT id FROM u)', 'mssql'), { table: 'dbo.t' });
});

test('buildEditInfo needs a primary key in the result', () => {
  const ok = buildEditInfo('lms', 'loans', cols, ['id', 'status', null, 'STATUS']);
  assert.deepEqual(ok, { database: 'lms', table: 'loans', columnMap: ['id', 'status', null, null], keyColumns: ['id'] });
  assert.match(buildEditInfo('lms', 'loans', cols, ['status']) as string, /primary key column id/);
  assert.match(buildEditInfo('lms', 'v', cols.map((c) => ({ ...c, key: '' })), ['id']) as string, /no primary key/);
});

const edit = { database: 'lms', table: 'loans', columnMap: ['id', 'status', 'amount'], keyColumns: ['id'] };
const changes: ChangeSet = {
  edit,
  deletes: [{ key: { id: '7' } }],
  updates: [{ key: { id: '1' }, set: { status: "it's", amount: null } }],
  inserts: [{ status: 'NEW' }, {}],
};

test('MySQL statements are parameterised and quoted', () => {
  const st = buildStatements('mysql', changes);
  assert.deepEqual(st.map((s) => s.sql), [
    'DELETE FROM `lms`.`loans` WHERE `id` = ?',
    'UPDATE `lms`.`loans` SET `status` = ?, `amount` = ? WHERE `id` = ?',
    'INSERT INTO `lms`.`loans` (`status`) VALUES (?)',
    'INSERT INTO `lms`.`loans` () VALUES ()',
  ]);
  assert.deepEqual(st[1].params, ["it's", null, '1']);
  assert.ok(st.every((s) => s.expectOne));
  assert.equal(previewStatements('mysql', changes)[1], "UPDATE `lms`.`loans` SET `status` = 'it''s', `amount` = NULL WHERE `id` = '1';");
});

test('SQL Server statements use @p parameters and [brackets]', () => {
  const st = buildStatements('mssql', { ...changes, edit: { ...edit, table: 'dbo.loans' } });
  assert.equal(st[1].sql, 'UPDATE [lms].[dbo].[loans] SET [status] = @p0, [amount] = @p1 WHERE [id] = @p2');
  assert.equal(st[3].sql, 'INSERT INTO [lms].[dbo].[loans] DEFAULT VALUES');
});

test('identifiers are escaped and unknown columns are rejected', () => {
  const weird = { database: 'a`b', table: 't', columnMap: ['id', 'x`y'], keyColumns: ['id'] };
  assert.equal(buildStatements('mysql', { edit: weird, updates: [{ key: { id: 1 }, set: { 'x`y': 2 } }], inserts: [], deletes: [] })[0].sql,
    'UPDATE `a``b`.`t` SET `x``y` = ? WHERE `id` = ?');
  assert.throws(() => buildStatements('mysql', { edit, updates: [{ key: { id: 1 }, set: { evil: 1 } }], inserts: [], deletes: [] }), /not editable/);
});
