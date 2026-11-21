// SQL Server driver (mssql / tedious).
// - A metadata pool for the tree and autocomplete.
// - One single-connection pool per query tab (keeps USE / #temp tables per tab).

import sql from 'mssql';
import type { ColumnInfo, TableDetails, TableInfo } from '../../shared/types';
import { AppFailure, classifyDbError } from '../errors';
import { AI_TAB_PREFIX, normalizeRows, type ConnectParams, type Driver, type ExecOutput } from './driver';

const quoteName = (name: string) => '[' + name.replace(/]/g, ']]') + ']';

export async function createMssqlDriver(p: ConnectParams, where: string): Promise<Driver> {
  const base: sql.config = {
    server: p.host,
    port: p.port,
    user: p.user,
    password: p.password,
    database: p.database || undefined,
    connectionTimeout: 20000,
    requestTimeout: 0, // no timeout for interactive queries; use Cancel
    options: {
      encrypt: p.mssqlEncrypt ?? true,
      trustServerCertificate: p.mssqlTrustCert ?? true,
      useUTC: true,
      enableArithAbort: true,
    },
  };

  const metaPool = new sql.ConnectionPool({ ...base, pool: { max: 3, min: 0, idleTimeoutMillis: 60000 } });
  try {
    await metaPool.connect();
  } catch (e) {
    throw classifyDbError(e, where);
  }

  const tabs = new Map<string, sql.ConnectionPool>();
  const running = new Map<string, sql.Request>();

  async function tabPool(tabId: string): Promise<sql.ConnectionPool> {
    let pool = tabs.get(tabId);
    if (pool && pool.connected) return pool;
    pool = new sql.ConnectionPool({ ...base, pool: { max: 1, min: 1, idleTimeoutMillis: 2_147_483_647 } });
    try {
      await pool.connect();
    } catch (e) {
      throw classifyDbError(e, where);
    }
    tabs.set(tabId, pool);
    return pool;
  }

  const meta = async (text: string, params: Record<string, string> = {}) => {
    try {
      const req = metaPool.request();
      for (const [k, v] of Object.entries(params)) req.input(k, sql.NVarChar, v);
      const r = await req.query(text);
      return r.recordset as any[];
    } catch (e) {
      throw classifyDbError(e, where);
    }
  };

  return {
    async serverVersion() {
      const r = await meta('SELECT @@VERSION AS v');
      return String(r[0].v).split('\n')[0];
    },
    async listDatabases() {
      return (await meta('SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name')).map((r) => r.name);
    },
    async listTables(db) {
      const rows = await meta(
        `SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name, TABLE_TYPE AS type FROM ${quoteName(db)}.INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME`);
      return rows.map((r): TableInfo => ({ name: r.name, kind: String(r.type).includes('VIEW') ? 'view' : 'table' }));
    },
    async tableDetails(db, table): Promise<TableDetails> {
      const dot = table.indexOf('.');
      const schema = dot > 0 ? table.slice(0, dot) : 'dbo';
      const name = dot > 0 ? table.slice(dot + 1) : table;
      const D = quoteName(db);

      const obj = await meta(
        `SELECT o.object_id AS id, o.type_desc AS type, o.create_date AS created, o.modify_date AS modified,
                (SELECT SUM(p.rows) FROM ${D}.sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS rows_count
         FROM ${D}.sys.objects o JOIN ${D}.sys.schemas s ON s.schema_id = o.schema_id
         WHERE s.name = @schema AND o.name = @name`, { schema, name });
      if (!obj[0]) throw new AppFailure('db-error', `Table ${db}.${table} was not found.`);
      const id = String(obj[0].id);
      const fmtDate = (d: unknown) => (d instanceof Date ? d.toISOString().replace('T', ' ').slice(0, 19) : String(d ?? ''));
      const info = [
        { label: 'Type', value: String(obj[0].type).includes('VIEW') ? 'View' : 'Table' },
        { label: 'Rows', value: obj[0].rows_count == null ? '' : Number(obj[0].rows_count).toLocaleString() },
        { label: 'Created', value: fmtDate(obj[0].created) },
        { label: 'Modified', value: fmtDate(obj[0].modified) },
      ].filter((x) => x.value);

      const cols = await meta(
        `SELECT c.name, t.name AS type_name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity,
                dc.definition AS default_def
         FROM ${D}.sys.columns c JOIN ${D}.sys.types t ON t.user_type_id = c.user_type_id
         LEFT JOIN ${D}.sys.default_constraints dc ON dc.object_id = c.default_object_id
         WHERE c.object_id = ${Number(id)} ORDER BY c.column_id`);
      const typeText = (c: any) => {
        const t = String(c.type_name);
        if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) return `${t}(${c.max_length === -1 ? 'max' : c.max_length})`;
        if (['nvarchar', 'nchar'].includes(t)) return `${t}(${c.max_length === -1 ? 'max' : c.max_length / 2})`;
        if (['decimal', 'numeric'].includes(t)) return `${t}(${c.precision},${c.scale})`;
        return t;
      };

      const idxRows = await meta(
        `SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc, c.name AS col, ic.key_ordinal
         FROM ${D}.sys.indexes i
         JOIN ${D}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
         JOIN ${D}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE i.object_id = ${Number(id)} AND i.name IS NOT NULL ORDER BY i.name, ic.key_ordinal`);
      const indexes = new Map<string, { name: string; columns: string[]; unique: boolean; primary: boolean; type: string }>();
      for (const r of idxRows) {
        const x = indexes.get(r.name) ?? { name: r.name, columns: [] as string[], unique: !!r.is_unique, primary: !!r.is_primary_key, type: String(r.type_desc) };
        x.columns.push(r.col);
        indexes.set(r.name, x);
      }
      const pkCols = new Set([...indexes.values()].filter((i) => i.primary).flatMap((i) => i.columns));

      const fkRows = await meta(
        `SELECT fk.name, OBJECT_SCHEMA_NAME(fk.parent_object_id, DB_ID(@db)) + '.' + OBJECT_NAME(fk.parent_object_id, DB_ID(@db)) AS tbl,
                pc.name AS col,
                OBJECT_SCHEMA_NAME(fk.referenced_object_id, DB_ID(@db)) + '.' + OBJECT_NAME(fk.referenced_object_id, DB_ID(@db)) AS ref_tbl,
                rc.name AS ref_col, fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update,
                CASE WHEN fk.parent_object_id = ${Number(id)} THEN 'out' ELSE 'in' END AS direction
         FROM ${D}.sys.foreign_keys fk
         JOIN ${D}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN ${D}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
         JOIN ${D}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
         WHERE fk.parent_object_id = ${Number(id)} OR fk.referenced_object_id = ${Number(id)}
         ORDER BY fk.name, fkc.constraint_column_id`, { db });
      const fks = new Map<string, TableDetails['foreignKeys'][number] & { cols: string[]; refs: string[] }>();
      for (const r of fkRows) {
        const key = r.name + '|' + r.direction;
        const x = fks.get(key) ?? { name: r.name, direction: r.direction, table: r.tbl, columns: '', refTable: r.ref_tbl, refColumns: '', onDelete: r.on_delete, onUpdate: r.on_update, cols: [] as string[], refs: [] as string[] };
        x.cols.push(r.col);
        x.refs.push(r.ref_col);
        fks.set(key, x);
      }

      const columns = cols.map((c: any) => ({
        name: String(c.name), type: typeText(c), nullable: !!c.is_nullable, key: pkCols.has(c.name) ? 'PRI' : '',
        default: c.default_def == null ? null : String(c.default_def), extra: c.is_identity ? 'IDENTITY' : '', comment: '',
      }));
      // SQL Server has no SHOW CREATE TABLE: build a readable CREATE statement from the catalog.
      const q = quoteName;
      const lines = columns.map((c) => `  ${q(c.name)} ${c.type}${c.extra ? ' IDENTITY' : ''}${c.nullable ? ' NULL' : ' NOT NULL'}${c.default ? ` DEFAULT ${c.default}` : ''}`);
      const pk = [...indexes.values()].find((i) => i.primary);
      if (pk) lines.push(`  CONSTRAINT ${q(pk.name)} PRIMARY KEY (${pk.columns.map(q).join(', ')})`);
      for (const f of [...fks.values()].filter((f) => f.direction === 'out')) {
        const [rs, rt] = f.refTable.split('.');
        lines.push(`  CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.cols.map(q).join(', ')}) REFERENCES ${q(rs)}.${q(rt)} (${f.refs.map(q).join(', ')})`);
      }
      let ddl = `CREATE TABLE ${q(schema)}.${q(name)} (\n${lines.join(',\n')}\n);`;
      for (const i of indexes.values()) {
        if (i.primary) continue;
        ddl += `\nCREATE ${i.unique ? 'UNIQUE ' : ''}${i.type.includes('NONCLUSTERED') ? 'NONCLUSTERED' : i.type.includes('CLUSTERED') ? 'CLUSTERED' : ''} INDEX ${q(i.name)} ON ${q(schema)}.${q(name)} (${i.columns.map(q).join(', ')});`;
      }
      return {
        database: db,
        table,
        info,
        columns,
        indexes: [...indexes.values()].map((i) => ({ ...i, columns: i.columns.join(', ') })),
        foreignKeys: [...fks.values()].map(({ cols: c, refs, ...f }) => ({ ...f, columns: c.join(', '), refColumns: refs.join(', ') })),
        ddl,
        ddlNote: 'Generated from the SQL Server catalog (columns, primary key, foreign keys, indexes). Check constraints, triggers and permissions are not included.',
      };
    },
    async listColumns(db, table) {
      const dot = table.indexOf('.');
      const schema = dot > 0 ? table.slice(0, dot) : 'dbo';
      const name = dot > 0 ? table.slice(dot + 1) : table;
      const rows = await meta(
        `SELECT c.COLUMN_NAME AS name,
                c.DATA_TYPE + ISNULL('(' + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN 'max'
                     ELSE CAST(c.CHARACTER_MAXIMUM_LENGTH AS varchar(10)) END + ')', '') AS type,
                c.IS_NULLABLE AS nullable,
                CASE WHEN k.COLUMN_NAME IS NOT NULL THEN 'PRI' ELSE '' END AS keyType
         FROM ${quoteName(db)}.INFORMATION_SCHEMA.COLUMNS c
         LEFT JOIN (
           SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
           FROM ${quoteName(db)}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
           JOIN ${quoteName(db)}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
             ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
           WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
         ) k ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME
         WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @name
         ORDER BY c.ORDINAL_POSITION`, { schema, name });
      return rows.map((r): ColumnInfo => ({ name: r.name, type: r.type, nullable: r.nullable === 'YES', key: r.keyType }));
    },
    async exec(tabId, text): Promise<ExecOutput> {
      const pool = await tabPool(tabId);
      const req = pool.request();
      req.arrayRowMode = true;
      running.set(tabId, req);
      try {
        const r: any = await req.query(text);
        const sets = (r.recordsets ?? []) as unknown[][][];
        const cols = (r.columns ?? []) as any[][];
        return {
          resultSets: sets.map((rows, i) => ({
            columns: (cols[i] ?? []).map((c: any) => c.name || `(col ${c.index + 1})`),
            rows: normalizeRows(rows),
          })),
          affectedRows: Array.isArray(r.rowsAffected) ? r.rowsAffected.reduce((a: number, b: number) => a + b, 0) : undefined,
        };
      } catch (e) {
        throw classifyDbError(e, where);
      } finally {
        running.delete(tabId);
      }
    },
    async cancel(tabId) {
      running.get(tabId)?.cancel();
    },
    async applyStatements(tabId, statements) {
      if (tabId.startsWith(AI_TAB_PREFIX)) throw new AppFailure('readonly-blocked', 'Read-only: changes cannot be saved.');
      const pool = await tabPool(tabId);
      const tx = new sql.Transaction(pool);
      let total = 0;
      try {
        await tx.begin();
        for (const st of statements) {
          const req = new sql.Request(tx);
          st.params.forEach((v, i) => (v === null ? req.input('p' + i, sql.NVarChar, null) : req.input('p' + i, v as any)));
          const r = await req.query(st.sql);
          const n = r.rowsAffected.reduce((a, b) => a + b, 0);
          if (st.expectOne && n !== 1) {
            throw new AppFailure('db-error',
              `Expected to change 1 row but ${n} rows matched. The row was changed or deleted by someone else, ` +
              'or the key is not unique. Nothing was saved.', st.sql);
          }
          total += n;
        }
        await tx.commit();
        return total;
      } catch (e) {
        await tx.rollback().catch(() => {});
        throw classifyDbError(e, where);
      }
    },
    async currentDatabase(tabId) {
      const pool = await tabPool(tabId);
      const r = await pool.request().query('SELECT DB_NAME() AS db');
      return String(r.recordset[0].db ?? '');
    },
    async useDatabase(tabId, db) {
      const pool = await tabPool(tabId);
      try {
        await pool.request().batch('USE ' + quoteName(db));
      } catch (e) {
        throw classifyDbError(e, where);
      }
    },
    async setReadOnly() {
      // SQL Server has no session-level read-only switch; statements are checked before they are sent.
    },
    async closeTab(tabId) {
      for (const id of [tabId, tabId + ':edit']) {
        const pool = tabs.get(id);
        tabs.delete(id);
        await pool?.close().catch(() => {});
      }
    },
    async close() {
      for (const pool of tabs.values()) await pool.close().catch(() => {});
      tabs.clear();
      await metaPool.close().catch(() => {});
    },
  };
}
