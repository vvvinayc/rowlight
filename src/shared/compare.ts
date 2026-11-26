// Compares the result of the same query on two connections (e.g. LP Production and DR): which rows are the same,
// which differ (and in which columns), and which exist on one side only. Pure, unit tested.

export interface Table { columns: string[]; rows: unknown[][] }

export type RowStatus = 'same' | 'changed' | 'onlyA' | 'onlyB';

export interface DiffRow {
  status: RowStatus;
  /** Values per column of `columns` (null when that side has no such column or no row). */
  a: unknown[] | null;
  b: unknown[] | null;
  /** Indexes (into `columns`) of the cells that differ. */
  diff: number[];
}

export interface Diff {
  columns: string[];
  onlyAColumns: string[];
  onlyBColumns: string[];
  /** Column used to match rows, or null = matched by row order. */
  key: string | null;
  rows: DiffRow[];
  counts: Record<RowStatus, number>;
}

const norm = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
};

function sameValue(x: unknown, y: unknown): boolean {
  const a = norm(x), b = norm(y);
  if (a === b) return true;
  if (a === null || b === null) return false;
  // 655.00 and 655.0 (different column definitions) are the same number
  const num = /^-?\d+(\.\d+)?$/;
  return num.test(a) && num.test(b) && Number(a) === Number(b);
}

function uniqueIn(t: Table, col: number): boolean {
  if (col < 0) return false;
  const seen = new Set<string>();
  for (const r of t.rows) {
    const k = norm(r[col]);
    if (k === null || seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

/** Best column to match rows by: "id", else a column ending in "id", else the first column; unique on both sides. */
export function defaultKey(a: Table, b: Table): string | null {
  const shared = a.columns.filter((c) => b.columns.includes(c));
  const ordered = [
    ...shared.filter((c) => c.toLowerCase() === 'id'),
    ...shared.filter((c) => /_?id$/i.test(c) && c.toLowerCase() !== 'id'),
    ...shared.slice(0, 1),
  ];
  for (const c of ordered) if (uniqueIn(a, a.columns.indexOf(c)) && uniqueIn(b, b.columns.indexOf(c))) return c;
  return null;
}

export function compareTables(a: Table, b: Table, key: string | null = defaultKey(a, b)): Diff {
  const columns = [...a.columns, ...b.columns.filter((c) => !a.columns.includes(c))];
  const ai = columns.map((c) => a.columns.indexOf(c));
  const bi = columns.map((c) => b.columns.indexOf(c));
  const pick = (row: unknown[] | undefined, idx: number[]) => (row ? idx.map((i) => (i < 0 ? null : row[i] ?? null)) : null);
  const rows: DiffRow[] = [];
  const counts: Record<RowStatus, number> = { same: 0, changed: 0, onlyA: 0, onlyB: 0 };

  const pair = (ra: unknown[] | undefined, rb: unknown[] | undefined) => {
    const va = pick(ra, ai), vb = pick(rb, bi);
    let status: RowStatus;
    const diff: number[] = [];
    if (!va) status = 'onlyB';
    else if (!vb) status = 'onlyA';
    else {
      columns.forEach((_, c) => { if (ai[c] >= 0 && bi[c] >= 0 && !sameValue(va[c], vb[c])) diff.push(c); });
      status = diff.length ? 'changed' : 'same';
    }
    counts[status]++;
    rows.push({ status, a: va, b: vb, diff });
  };

  const ka = key ? a.columns.indexOf(key) : -1;
  const kb = key ? b.columns.indexOf(key) : -1;
  if (ka < 0 || kb < 0) {
    for (let i = 0; i < Math.max(a.rows.length, b.rows.length); i++) pair(a.rows[i], b.rows[i]);
    return { columns, onlyAColumns: a.columns.filter((c) => !b.columns.includes(c)), onlyBColumns: b.columns.filter((c) => !a.columns.includes(c)), key: null, rows, counts };
  }
  // Match by key; repeated keys are paired in order of appearance.
  const byKey = new Map<string, unknown[][]>();
  for (const r of b.rows) { const k = String(norm(r[kb])); (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r); }
  for (const r of a.rows) {
    const list = byKey.get(String(norm(r[ka])));
    pair(r, list?.shift());
  }
  for (const list of byKey.values()) for (const r of list) pair(undefined, r);
  return { columns, onlyAColumns: a.columns.filter((c) => !b.columns.includes(c)), onlyBColumns: b.columns.filter((c) => !a.columns.includes(c)), key, rows, counts };
}

/** Only SELECT-like statements are sent to two connections at once. */
export function isReadOnlyQuery(sql: string): boolean {
  const s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(--|#)[^\n]*/g, ' ').trim();
  if (!/^(select|with|show|describe|desc|explain|\()/i.test(s)) return false;
  return !/\b(insert|update|delete|replace|merge|drop|alter|create|truncate|grant|revoke|call|exec|execute)\b\s/i.test(s.replace(/'(?:[^'\\]|\\.)*'/g, "''"))
    && !/\binto\s+(outfile|dumpfile|@)/i.test(s);
}
