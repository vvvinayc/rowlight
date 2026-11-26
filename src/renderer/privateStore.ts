// Private data of the window (open tab text, saved queries, :param values), kept encrypted by the main process
// (Windows DPAPI) instead of in the browser storage. Loaded once at start; reads are synchronous from memory.

import { api, unwrap } from './api';

/** Keys that used to be in localStorage (plain text on disk) before 0.15; moved on first start. */
const MOVED = ['app.openTabs', 'rowlight.savedQueries', 'rowlight.paramValues'];

let cache: Record<string, string> = {};
let encrypted = false;

export async function initPrivate(): Promise<void> {
  try {
    const r = await unwrap(api.private.load());
    cache = r.data ?? {};
    encrypted = r.encrypted;
  } catch { /* start empty */ }
  for (const k of MOVED) {
    try {
      const v = localStorage.getItem(k);
      if (v === null) continue;
      if (cache[k] === undefined) { cache[k] = v; api.private.set(k, v); }
      localStorage.removeItem(k);
    } catch { /* ignore */ }
  }
}

export function getPrivate(key: string): string | null {
  return cache[key] ?? null;
}

export function setPrivate(key: string, value: string | null): void {
  if (value === null) delete cache[key];
  else if (cache[key] === value) return;
  else cache[key] = value;
  api.private.set(key, value).catch(() => {});
}

export const privateIsEncrypted = () => encrypted;
