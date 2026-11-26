import { getPrivate, setPrivate } from './privateStore';

// Saved (favourite) queries, kept on this PC (encrypted). Shared by all connections; each remembers where it was saved.

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  /** Connection it was saved from (shown as a hint; the query can run anywhere). */
  connName?: string;
  created: number;
  used: number;
  uses: number;
}

const KEY = 'rowlight.savedQueries';
const listeners = new Set<() => void>();

export function listSaved(): SavedQuery[] {
  try { const v = JSON.parse(getPrivate(KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

function write(list: SavedQuery[]) {
  setPrivate(KEY, JSON.stringify(list));
  listeners.forEach((f) => f());
}

export function onSavedChange(f: () => void): () => void { listeners.add(f); return () => listeners.delete(f); }

/** Saves a new query, or replaces the SQL of the one with the same name. */
export function saveQuery(name: string, sql: string, connName?: string): SavedQuery {
  const list = listSaved();
  const now = Date.now();
  const same = list.find((q) => q.name.toLowerCase() === name.toLowerCase());
  if (same) { Object.assign(same, { sql, connName, used: now }); write(list); return same; }
  const q: SavedQuery = { id: 'q' + now.toString(36) + Math.random().toString(36).slice(2, 6), name, sql, connName, created: now, used: now, uses: 0 };
  write([...list, q]);
  return q;
}

export function updateSaved(id: string, patch: Partial<SavedQuery>) {
  write(listSaved().map((q) => (q.id === id ? { ...q, ...patch } : q)));
}

export function deleteSaved(id: string) { write(listSaved().filter((q) => q.id !== id)); }

export function markUsed(id: string) {
  const q = listSaved().find((x) => x.id === id);
  if (q) updateSaved(id, { used: Date.now(), uses: q.uses + 1 });
}

/** Every word must appear in the name or the SQL; most used and most recent first. */
export function searchSaved(query: string): SavedQuery[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return listSaved()
    .filter((q) => { const hay = (q.name + ' ' + q.sql).toLowerCase(); return words.every((w) => hay.includes(w)); })
    .sort((a, b) => {
      const an = words.length && words.every((w) => a.name.toLowerCase().includes(w)) ? 1 : 0;
      const bn = words.length && words.every((w) => b.name.toLowerCase().includes(w)) ? 1 : 0;
      return bn - an || b.uses - a.uses || b.used - a.used;
    });
}

/** A short default name: the main table, or the first line. */
export function suggestName(sql: string): string {
  const t = /\bfrom\s+[`\[]?(?:\w+[`\]]?\.)?[`\[]?(\w+)/i.exec(sql)?.[1];
  const first = sql.trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 50);
  return t ? `${t}` : first;
}
