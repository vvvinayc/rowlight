// MySQL driver (mysql2).
// - A small pool, always READ ONLY, for metadata (tree, autocomplete) and for KILL QUERY.
// - One dedicated connection per query tab, so USE / variables / transactions behave per tab.

import mysql from 'mysql2/promise';
import type { ColumnInfo, TableDetails, TableInfo } from '../../shared/types';
import { AppFailure, classifyDbError } from '../errors';
import { AI_TAB_PREFIX, normalizeRows, type ConnectParams, type Driver, type ExecOutput } from './driver';

interface TabConn {
  conn: mysql.Connection;
  dead: boolean;
  /** Last known database, restored if the connection has to be re-opened. */
  db?: string;
}

export async function createMysqlDriver(p: ConnectParams, where: string): Promise<Driver> {
  const base: mysql.ConnectionOptions = {
    host: p.host,
    port: p.port,
    user: p.user,
    password: p.password,
    database: p.database || undefined,
    charset: 'utf8mb4',
    dateStrings: true, // show DATE/DATETIME exactly as stored
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectTimeout: 20000,
    enableKeepAlive: true,
    multipleStatements: false, // we split scripts ourselves
  };

  const pool = mysql.createPool({ ...base, connectionLimit: 4, maxIdle: 2, idleTimeout: 60000 });
  (pool as any).pool.on('connection', (c: any) => c.query('SET SESSION TRANSACTION READ ONLY'));
  try {
    const c = await pool.getConnection();
    c.release();
  } catch (e) {
    await pool.end().catch(() => {});
    throw classifyDbError(e, where);
  }

  let readOnly = p.readOnly;
  const tabs = new Map<string, TabConn>();

  async function tabConn(tabId: string): Promise<TabConn> {
    const existing = tabs.get(tabId);
    if (existing && !existing.dead) return existing;
    if (existing) existing.conn.destroy();
    const lastDb = existing?.db;
    let conn: mysql.Connection;
    try {
      conn = await mysql.createConnection(base);
    } catch (e) {
      throw classifyDbError(e, where);
    }
    const t: TabConn = { conn, dead: false, db: lastDb };
    conn.on('error', () => { t.dead = true; });
    conn.on('end', () => { t.dead = true; });
    if (readOnly || tabId.startsWith(AI_TAB_PREFIX)) await conn.query('SET SESSION TRANSACTION READ ONLY');
    if (lastDb) await conn.query('USE ' + mysql.escapeId(lastDb)).catch(() => {});
    tabs.set(tabId, t);
    return t;
  }

  const meta = async (sql: string, params: unknown[] = []) => {
    try {
      const [rows] = await pool.query({ sql, rowsAsArray: true }, params);
      return rows as unknown[][];
    } catch (e) {
      throw classifyDbError(e, where);
    }
  };

  return {
    async serverVersion() {
      return String((await meta('SELECT VERSION()'))[0][0]);
    },
    async listDatabases() {
      return (await meta('SHOW DATABASES')).map((r) => String(r[0]));
    },
    async listTables(db) {
      const rows = await meta(
        'SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [db]);
      return rows.map((r): TableInfo => ({ name: String(r[0]), kind: String(r[1]).includes('VIEW') ? 'view' : 'table', rows: r[2] == null ? undefined : Number(r[2]) }));
    },
    async listAllTables() {
      const rows = await meta(
        "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES " +
        "WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') " +
        'ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT 50000');
      const byDb = new Map<string, TableInfo[]>();
      for (const r of rows) {
        const list = byDb.get(String(r[0])) ?? [];
        list.push({ name: String(r[1]), kind: String(r[2]).includes('VIEW') ? 'view' : 'table', rows: r[3] == null ? undefined : Number(r[3]) });
        byDb.set(String(r[0]), list);
      }
      return [...byDb].map(([db, tables]) => ({ db, tables }));
    },
    async listColumns(db, table) {
      const rows = await meta(
        'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS ' +
        'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [db, table]);
      return rows.map((r): ColumnInfo => ({ name: String(r[0]), type: String(r[1]), nullable: r[2] === 'YES', key: String(r[3] ?? '') }));
    },
    async tableDetails(db, table): Promise<TableDetails> {
      const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
      const mb = (v: unknown) => (v == null ? '' : `${(Number(v) / 1024 / 1024).toFixed(1)} MB`);
      const [t] = await meta(
        'SELECT TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, CREATE_TIME, UPDATE_TIME, TABLE_COLLATION, TABLE_COMMENT ' +
        'FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [db, table]);
      if (!t) throw new AppFailure('db-error', `Table ${db}.${table} was not found.`);
      const isView = s(t[0]).includes('VIEW');
      const info = [
        { label: 'Type', value: isView ? 'View' : 'Table' },
        { label: 'Engine', value: s(t[1]) },
        { label: 'Rows (approx.)', value: t[2] == null ? '' : Number(t[2]).toLocaleString() },
        { label: 'Data size', value: mb(t[3]) },
        { label: 'Index size', value: mb(t[4]) },
        { label: 'Created', value: s(t[5]) },
        { label: 'Last update', value: s(t[6]) },
        { label: 'Collation', value: s(t[7]) },
        { label: 'Comment', value: s(t[8]) },
      ].filter((x) => x.value);
      const cols = await meta(
        'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT FROM information_schema.COLUMNS ' +
        'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [db, table]);
      const idx = await meta(
        "SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '), NON_UNIQUE, INDEX_TYPE " +
        'FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE ORDER BY INDEX_NAME', [db, table]);
      const fkSql = (where: string) =>
        "SELECT k.CONSTRAINT_NAME, k.TABLE_NAME, GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', '), " +
        "k.REFERENCED_TABLE_NAME, GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', '), r.DELETE_RULE, r.UPDATE_RULE " +
        'FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ' +
        'ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME ' +
        `WHERE ${where} GROUP BY k.CONSTRAINT_NAME, k.TABLE_NAME, k.REFERENCED_TABLE_NAME, r.DELETE_RULE, r.UPDATE_RULE ORDER BY k.CONSTRAINT_NAME`;
      const out = await meta(fkSql('k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL'), [db, table]);
      const inc = await meta(fkSql('k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?'), [db, table]);
      const fk = (r: unknown[], direction: 'out' | 'in') => ({
        name: s(r[0]), direction, table: s(r[1]), columns: s(r[2]), refTable: s(r[3]), refColumns: s(r[4]), onDelete: s(r[5]), onUpdate: s(r[6]),
      });
      const ddlRows = await meta(`SHOW CREATE TABLE ${mysql.escapeId(db)}.${mysql.escapeId(table)}`);
      return {
        database: db,
        table,
        info,
        columns: cols.map((r) => ({ name: s(r[0]), type: s(r[1]), nullable: r[2] === 'YES', key: s(r[3]), default: r[4] == null ? null : s(r[4]), extra: s(r[5]), comment: s(r[6]) })),
        indexes: idx.map((r) => ({ name: s(r[0]), columns: s(r[1]), unique: String(r[2]) === '0', primary: r[0] === 'PRIMARY', type: s(r[3]) })),
        foreignKeys: [...out.map((r) => fk(r, 'out')), ...inc.map((r) => fk(r, 'in'))],
        ddl: s(ddlRows[0]?.[1]) + ';',
      };
    },
    async exec(tabId, sql): Promise<ExecOutput> {
      const t = await tabConn(tabId);
      try {
        const [rows, fields] = await t.conn.query({ sql, rowsAsArray: true });
        return toOutput(rows, fields);
      } catch (e) {
        throw classifyDbError(e, where);
      }
    },
    async cancel(tabId) {
      const t = tabs.get(tabId);
      const threadId = (t?.conn as any)?.connection?.threadId ?? (t?.conn as any)?.threadId;
      if (!threadId) return;
      await pool.query(`KILL QUERY ${Number(threadId)}`).catch(() => {});
    },
    async applyStatements(tabId, statements) {
      const t = await tabConn(tabId);
      if (readOnly || tabId.startsWith(AI_TAB_PREFIX)) throw new AppFailure('readonly-blocked', 'Read-only mode: changes cannot be saved.');
      let total = 0;
      try {
        await t.conn.beginTransaction();
        for (const st of statements) {
          const [r] = await t.conn.query(st.sql, st.params);
          const n = (r as any).affectedRows ?? 0;
          if (st.expectOne && n !== 1) {
            throw new AppFailure('db-error',
              `Expected to change 1 row but ${n} rows matched. The row was changed or deleted by someone else, ` +
              'or the key is not unique. Nothing was saved.', st.sql);
          }
          total += n;
        }
        await t.conn.commit();
        return total;
      } catch (e) {
        await t.conn.rollback().catch(() => { t.dead = true; });
        throw classifyDbError(e, where);
      }
    },
    async currentDatabase(tabId) {
      const t = await tabConn(tabId);
      const [rows] = await t.conn.query({ sql: 'SELECT DATABASE()', rowsAsArray: true });
      t.db = String((rows as unknown[][])[0]?.[0] ?? '');
      return t.db;
    },
    async useDatabase(tabId, db) {
      const t = await tabConn(tabId);
      try {
        await t.conn.query('USE ' + mysql.escapeId(db));
      } catch (e) {
        throw classifyDbError(e, where);
      }
      t.db = db;
    },
    async setReadOnly(ro) {
      readOnly = ro;
      for (const [id, t] of tabs) {
        if (id.startsWith(AI_TAB_PREFIX)) continue; // AI tabs stay read-only
        if (!t.dead) await t.conn.query(`SET SESSION TRANSACTION ${ro ? 'READ ONLY' : 'READ WRITE'}`).catch(() => { t.dead = true; });
      }
    },
    async closeTab(tabId) {
      for (const id of [tabId, tabId + ':edit']) {
        const t = tabs.get(id);
        tabs.delete(id);
        await t?.conn.end().catch(() => t.conn.destroy());
      }
    },
    async close() {
      for (const t of tabs.values()) t.conn.destroy();
      tabs.clear();
      await pool.end().catch(() => {});
    },
  };
}

function toOutput(rows: any, fields: any): ExecOutput {
  // Several result sets (e.g. CALL procedure)
  if (Array.isArray(fields) && Array.isArray(fields[0])) {
    const out: ExecOutput = { resultSets: [] };
    (rows as any[]).forEach((r, i) => {
      if (Array.isArray(r)) out.resultSets.push({ columns: (fields[i] ?? []).map((f: any) => f.name), rows: normalizeRows(r) });
      else if (r && typeof r.affectedRows === 'number') out.affectedRows = r.affectedRows;
    });
    return out;
  }
  if (Array.isArray(rows)) {
    return { resultSets: [{ columns: (fields ?? []).map((f: any) => f.name), rows: normalizeRows(rows), sources: (fields ?? []).map(sourceOf) }] };
  }
  return { resultSets: [], affectedRows: rows?.affectedRows };
}

/** mysql2 field metadata tells us the real table/column behind each result column. */
function sourceOf(f: any) {
  if (!f?.orgTable || !f?.orgName) return null; // expression, constant, aggregate…
  return { db: String(f.schema ?? f.db ?? ''), table: String(f.orgTable), column: String(f.orgName) };
}
