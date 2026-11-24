// Renderer state for the smart editor features: which ones are on, and what was learned from each
// connection's query history (tables / columns / joins the user really uses).

import type { DbType, Settings, SmartSettings } from '../shared/types';
import { SMART_KEYS } from '../shared/defaults';
import { emptyStats, learnFromSql, type UsageStats } from '../shared/sqlSmart';
import { api, unwrap } from './api';

let current: SmartSettings = Object.fromEntries(SMART_KEYS.map((k) => [k, true])) as unknown as SmartSettings;

export function smartFrom(s: Settings | undefined): SmartSettings {
  return Object.fromEntries(SMART_KEYS.map((k) => [k, s?.smart?.[k] !== false])) as unknown as SmartSettings;
}

export function setSmartSettings(s: Settings) { current = smartFrom(s); }
export const smart = () => current;

// ---- usage learned from history ----

interface Entry { stats: UsageStats; loading?: Promise<void>; stale: boolean }
const usage = new Map<string, Entry>();

/** Re-learn on the next use (called when the history changes). */
export function invalidateUsage(connId?: string) {
  for (const [id, e] of usage) if (!connId || id === connId) e.stale = true;
}

/** Stats for a connection, learned from its successful queries (loaded once, refreshed when history changes). */
export async function usageFor(connId: string, defaultDb: string, type: DbType): Promise<UsageStats | null> {
  if (!current.history) return null;
  let e = usage.get(connId);
  if (!e) { e = { stats: emptyStats(), stale: true }; usage.set(connId, e); }
  if (e.stale && !e.loading) {
    const entry = e;
    entry.loading = (async () => {
      try {
        const list = await unwrap(api.history.get(connId));
        const stats = emptyStats();
        for (const h of list) if (h.ok && h.source === 'user') { try { learnFromSql(stats, h.sql, defaultDb, type); } catch { /* skip odd SQL */ } }
        entry.stats = stats;
        entry.stale = false;
      } catch { /* keep the old stats */ } finally { entry.loading = undefined; }
    })();
  }
  if (e.loading) await Promise.race([e.loading, new Promise((r) => setTimeout(r, 400))]); // never slow the suggest list down
  return e.stats;
}

/** Sort-key fragment: more used → sorts earlier. */
export function rankKey(count: number | undefined): string {
  return String(99999 - Math.min(99999, count ?? 0)).padStart(5, '0');
}
