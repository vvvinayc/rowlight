// Caches database / table / column lists per connection. Used by the sidebar tree and autocomplete.

import type { ColumnInfo, TableInfo } from '../shared/types';
import type { ForeignKey } from '../shared/sqlAssist';
import { api, unwrap } from './api';

interface ConnCache {
  databases?: string[];
  /** Every database's tables were loaded in one go. */
  allTablesLoaded?: boolean;
  /** Last error while loading the database list (shown in the DB dropdown). */
  dbError?: string;
  tables: Map<string, TableInfo[]>;
  columns: Map<string, ColumnInfo[]>; // key: db + '\u0000' + table
  pending: Map<string, Promise<unknown>>;
}

const caches = new Map<string, ConnCache>();
const fkCache = new Map<string, ForeignKey[]>();
const listeners = new Set<() => void>();

function cache(connId: string): ConnCache {
  let c = caches.get(connId);
  if (!c) {
    c = { tables: new Map(), columns: new Map(), pending: new Map() };
    caches.set(connId, c);
  }
  return c;
}

function notify() {
  for (const l of listeners) l();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function once<T>(c: ConnCache, key: string, load: () => Promise<T>): Promise<T> {
  const existing = c.pending.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = load().finally(() => c.pending.delete(key));
  c.pending.set(key, p);
  return p;
}

export const metaCache = {
  clear(connId: string) {
    caches.delete(connId);
    for (const k of [...fkCache.keys()]) if (k.startsWith(connId)) fkCache.delete(k);
    notify();
  },
  peekDatabases: (connId: string) => caches.get(connId)?.databases,
  peekDbError: (connId: string) => caches.get(connId)?.dbError,
  isLoadingDatabases: (connId: string) => !!caches.get(connId)?.pending.has('dbs'),

  /** Tables of all databases (one metadata query on MySQL); also fills each database's table list. */
  async allTables(connId: string): Promise<void> {
    const c = cache(connId);
    if (c.allTablesLoaded) return;
    await once(c, 'all', async () => {
      for (const { db, tables } of await unwrap(api.meta.allTables(connId))) c.tables.set(db, tables);
      c.allTablesLoaded = true;
      notify();
    });
  },
  peekTables: (connId: string, db: string) => caches.get(connId)?.tables.get(db),
  peekColumns: (connId: string, db: string, table: string) => caches.get(connId)?.columns.get(db + '\u0000' + table),

  async databases(connId: string, refresh = false): Promise<string[]> {
    const c = cache(connId);
    if (c.databases && !refresh) return c.databases;
    notify(); // shows "Loading databases…"
    return once(c, 'dbs', async () => {
      try {
        c.databases = await unwrap(api.meta.databases(connId));
        c.dbError = undefined;
        return c.databases;
      } catch (e) {
        c.dbError = String((e as Error)?.message ?? e);
        throw e;
      } finally {
        setTimeout(notify, 0);
      }
    });
  },

  async tables(connId: string, db: string, refresh = false): Promise<TableInfo[]> {
    const c = cache(connId);
    const hit = c.tables.get(db);
    if (hit && !refresh) return hit;
    return once(c, 't:' + db, async () => {
      const list = await unwrap(api.meta.tables(connId, db));
      c.tables.set(db, list);
      notify();
      return list;
    });
  },

  /** Foreign keys of a table, both directions (used for JOIN ... ON suggestions). */
  async foreignKeys(connId: string, db: string, table: string): Promise<ForeignKey[]> {
    const c = cache(connId);
    const key = 'fk:' + db + '\u0000' + table;
    const hit = fkCache.get(connId + key);
    if (hit) return hit;
    return once(c, key, async () => {
      const d = await unwrap(api.meta.tableDetails(connId, db, table));
      const split = (x: string) => x.split(',').map((y) => y.trim()).filter(Boolean);
      const list = d.foreignKeys.map((k) => ({ table: k.table, columns: split(k.columns), refTable: k.refTable, refColumns: split(k.refColumns) }));
      fkCache.set(connId + key, list);
      return list;
    });
  },

  async columns(connId: string, db: string, table: string): Promise<ColumnInfo[]> {
    const c = cache(connId);
    const key = db + '\u0000' + table;
    const hit = c.columns.get(key);
    if (hit) return hit;
    return once(c, 'c:' + key, async () => {
      const list = await unwrap(api.meta.columns(connId, db, table));
      c.columns.set(key, list);
      notify();
      return list;
    });
  },
};
