// Editor assistance for joins: automatic table aliases, reading FROM/JOIN references, and
// suggesting JOIN ... ON conditions. Pure functions (no Monaco, no I/O) so they are unit tested.

import type { ColumnInfo, DbType } from './types';

export interface TableRef {
  /** Alias written in the query, or undefined. */
  alias?: string;
  /** Name to qualify columns with: the alias, or the table name as written. */
  qualifier: string;
  db: string;
  /** Table name; SQL Server: "schema.table". */
  table: string;
  /** Character offset of the reference in the text. */
  index: number;
}

const RESERVED = new Set([
  'as', 'on', 'in', 'is', 'or', 'by', 'to', 'if', 'do', 'at', 'of', 'no', 'go', 'all', 'and', 'any', 'asc', 'desc', 'end',
  'for', 'key', 'not', 'set', 'use', 'top', 'add', 'div', 'mod', 'xor', 'row', 'int', 'use', 'from', 'join', 'left', 'right',
  'inner', 'outer', 'cross', 'where', 'group', 'order', 'limit', 'select', 'union', 'having', 'using', 'values', 'into',
  'case', 'when', 'then', 'else', 'with', 'like', 'null', 'over', 'full', 'natural', 'straight_join', 'update', 'delete',
]);

const unquote = (s: string) => s.replace(/^[`\["]|[`\]"]$/g, '');

/** Table part without schema / database: "dbo.loan_accounts" → "loan_accounts". */
export function baseName(table: string): string {
  return unquote(table.split('.').pop() ?? table);
}

/** "loan_accounts" → "la", "CustomerAddress" → "ca", "orders" → "o". Never a reserved word, never taken. */
export function makeAlias(table: string, taken: Iterable<string>): string {
  const base = baseName(table);
  const words = base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_\-\s]+/).filter(Boolean);
  let alias = words.map((w) => w[0]).join('').toLowerCase().replace(/[^a-z0-9]/g, '') || 't';
  if (!/^[a-z]/.test(alias)) alias = 't' + alias;
  const used = new Set([...taken].map((x) => x.toLowerCase()));
  if (RESERVED.has(alias)) alias = (base.slice(0, 3) || 'tbl').toLowerCase();
  let candidate = alias;
  for (let i = 2; used.has(candidate) || RESERVED.has(candidate); i++) candidate = alias + i;
  return candidate;
}

/** FROM / JOIN / UPDATE / INTO references (with their aliases), in order of appearance. */
export function parseTableRefs(text: string, defaultDb: string, type: DbType): TableRef[] {
  const out: TableRef[] = [];
  const ident = '[`\\["]?[\\w$]+[`\\]"]?';
  // "FROM a x, b AS y JOIN c z": the comma list after FROM is handled by a second pass below.
  const re = new RegExp(`\\b(FROM|JOIN|UPDATE|INTO)\\s+((?:${ident}\\.){0,2}${ident})(?:\\s+(?:AS\\s+)?([\\w$]+))?`, 'gi');
  const push = (raw: string, aliasRaw: string | undefined, index: number) => {
    const parts = raw.split('.').map(unquote);
    let db = defaultDb;
    let table: string;
    if (type === 'mysql') {
      table = parts[parts.length - 1];
      if (parts.length > 1) db = parts[0];
    } else if (parts.length === 3) { db = parts[0]; table = parts[1] + '.' + parts[2]; }
    else if (parts.length === 2) table = parts.join('.');
    else table = 'dbo.' + parts[0];
    const alias = aliasRaw && !RESERVED.has(aliasRaw.toLowerCase()) ? aliasRaw : undefined;
    out.push({ alias, qualifier: alias ?? parts[parts.length - 1], db, table, index });
  };
  for (const m of text.matchAll(re)) {
    if (/^SELECT$/i.test(m[2])) continue; // "FROM (SELECT ..." / "INTO" variables etc.
    push(m[2], m[3], m.index ?? 0);
    if (/^FROM$/i.test(m[1])) {
      // comma-separated tables after FROM
      let rest = text.slice((m.index ?? 0) + m[0].length);
      const comma = new RegExp(`^\\s*,\\s*((?:${ident}\\.){0,2}${ident})(?:\\s+(?:AS\\s+)?([\\w$]+))?`, 'i');
      let offset = (m.index ?? 0) + m[0].length;
      for (let c = rest.match(comma); c; c = rest.match(comma)) {
        push(c[1], c[2], offset);
        offset += c[0].length;
        rest = rest.slice(c[0].length);
      }
    }
  }
  return out;
}

/** Is the cursor where a table name is expected (after FROM, JOIN, or a comma in the FROM list)? */
export function isTablePosition(textBeforeWord: string): boolean {
  if (/\b(FROM|JOIN)\s+$/i.test(textBeforeWord)) return true;
  if (!/,\s*$/.test(textBeforeWord)) return false;
  const lastFrom = textBeforeWord.search(/\bFROM\b(?![\s\S]*\bFROM\b)/i);
  if (lastFrom < 0) return false;
  return !/\b(WHERE|GROUP|ORDER|HAVING|LIMIT|ON|SELECT|SET|VALUES|UNION)\b/i.test(textBeforeWord.slice(lastFrom + 4));
}

/** "... JOIN customer c ON |" → the table just joined (its reference index in `refs`), else -1. */
export function joinOnTarget(textBeforeWord: string, refs: TableRef[]): number {
  const m = textBeforeWord.match(/\bJOIN\s+[^\s]+(?:\s+(?:AS\s+)?[\w$]+)?\s+ON\s+$/i);
  if (!m) return -1;
  const joinPos = textBeforeWord.length - m[0].length;
  let best = -1;
  refs.forEach((r, i) => { if (r.index >= joinPos - 1 && r.index <= joinPos + 5) best = i; });
  return best;
}

export interface ForeignKey {
  /** Table that has the FK column(s) ("schema.table" on SQL Server). */
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

/** Possible singular forms: "branches" → branch / branche, "categories" → category, "loans" → loan. */
function singulars(s: string): string[] {
  const l = s.toLowerCase();
  const out = new Set<string>([l]);
  if (/ies$/.test(l)) out.add(l.slice(0, -3) + 'y');
  if (/es$/.test(l)) out.add(l.slice(0, -2));
  if (/s$/.test(l)) out.add(l.slice(0, -1));
  return [...out];
}

/**
 * Suggested ON conditions between the newly joined table and the tables before it:
 * 1. declared foreign keys (either direction), 2. naming: a.customer_id = c.id,
 * 3. same "…_id" column in both tables.
 */
export function suggestJoinConditions(
  target: TableRef, targetCols: ColumnInfo[], others: { ref: TableRef; cols: ColumnInfo[] }[], fks: ForeignKey[],
): string[] {
  const out: string[] = [];
  const add = (s: string) => { if (!out.includes(s)) out.push(s); };
  const t = target.qualifier;
  const same = (a: string, b: string) => baseName(a).toLowerCase() === baseName(b).toLowerCase();
  for (const o of others) {
    const q = o.ref.qualifier;
    // 1. declared foreign keys
    for (const fk of fks) {
      const pairs = (a: string, ac: string[], b: string, bc: string[]) => ac.map((c, i) => `${a}.${c} = ${b}.${bc[i]}`).join(' AND ');
      if (same(fk.table, target.table) && same(fk.refTable, o.ref.table)) add(pairs(t, fk.columns, q, fk.refColumns));
      if (same(fk.table, o.ref.table) && same(fk.refTable, target.table)) add(pairs(q, fk.columns, t, fk.refColumns));
    }
    // 2. naming conventions: <table>_id → <table>.id
    const tNames = new Set(targetCols.map((c) => c.name.toLowerCase()));
    const oNames = new Set(o.cols.map((c) => c.name.toLowerCase()));
    const colOf = (cols: ColumnInfo[], lower: string) => cols.find((c) => c.name.toLowerCase() === lower)?.name ?? lower;
    const tBase = baseName(target.table).toLowerCase();
    const oBase = baseName(o.ref.table).toLowerCase();
    const tPk = targetCols.find((c) => c.key === 'PRI')?.name ?? (tNames.has('id') ? colOf(targetCols, 'id') : undefined);
    const oPk = o.cols.find((c) => c.key === 'PRI')?.name ?? (oNames.has('id') ? colOf(o.cols, 'id') : undefined);
    for (const cand of singulars(tBase).flatMap((x) => [`${x}_id`, `${x}id`])) {
      if (oNames.has(cand) && tPk) add(`${q}.${colOf(o.cols, cand)} = ${t}.${tPk}`);
    }
    for (const cand of singulars(oBase).flatMap((x) => [`${x}_id`, `${x}id`])) {
      if (tNames.has(cand) && oPk) add(`${t}.${colOf(targetCols, cand)} = ${q}.${oPk}`);
    }
    // 3. the same "…_id" column on both sides (e.g. both have customer_id)
    for (const c of targetCols) {
      const l = c.name.toLowerCase();
      if (l !== 'id' && /_?id$/.test(l) && oNames.has(l)) add(`${t}.${c.name} = ${q}.${colOf(o.cols, l)}`);
    }
  }
  return out;
}
