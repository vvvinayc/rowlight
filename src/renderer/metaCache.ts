// Caches database / table / column lists per connection. Used by the sidebar tree and autocomplete.

import type { ColumnInfo, TableInfo } from '../shared/types';
import { api, unwrap } from './api';

interface ConnCache {
  databases?: string[];
  tables: Map<string, TableInfo[]>;
  columns: Map<string, ColumnInfo[]>; // key: db + '\u0000' + table
  pending: Map<string, Promise<unknown>>;
}

const caches = new Map<string, ConnCache>();
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
    notify();
  },
  peekDatabases: (connId: string) => caches.get(connId)?.databases,
  peekTables: (connId: string, db: string) => caches.get(connId)?.tables.get(db),
  peekColumns: (connId: string, db: string, table: string) => caches.get(connId)?.columns.get(db + '\u0000' + table),

  async databases(connId: string, refresh = false): Promise<string[]> {
    const c = cache(connId);
    if (c.databases && !refresh) return c.databases;
    return once(c, 'dbs', async () => {
      c.databases = await unwrap(api.meta.databases(connId));
      notify();
      return c.databases;
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
