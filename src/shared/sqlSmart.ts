// "Smart" editor features that work offline, without AI: which clause the cursor is in, SQL functions
// with usage hints, snippets, learning tables / columns / joins from the query history, did-you-mean
// for misspelled names in errors, and safety hints. Pure functions (no Monaco, no I/O), unit tested.

import type { DbType } from './types';
import { baseName, parseTableRefs, type TableRef } from './sqlAssist';

// ---------------------------------------------------------------- masking

/** Same text with strings, quoted names' contents and comments replaced by spaces (offsets unchanged). */
export function maskSql(text: string): string {
  const out = text.split('');
  const blank = (a: number, b: number) => { for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if ((c === '-' && next === '-') || c === '#') { const s = i; while (i < n && text[i] !== '\n') i++; blank(s, i); continue; }
    if (c === '/' && next === '*') { const s = i; const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; blank(s, i); continue; }
    if (c === "'" || c === '"') {
      const s = i; i++;
      while (i < n && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
      i++;
      blank(s + 1, i - 1);
      out[s] = "'"; if (i - 1 < n) out[i - 1] = "'";
      continue;
    }
    i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------- clause under the cursor

export type Clause = 'start' | 'select' | 'from' | 'on' | 'where' | 'groupBy' | 'having' | 'orderBy' | 'limit' | 'set' | 'values' | 'other';

const CLAUSE_RE = /\b(SELECT|FROM|JOIN|ON|USING|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|TOP|SET|VALUES|UPDATE|INTO|DELETE|INSERT|UNION)\b|[()]/gi;

function clauseOf(kw: string): Clause {
  const k = kw.toUpperCase().replace(/\s+/g, ' ');
  switch (k) {
    case 'SELECT': return 'select';
    case 'FROM': case 'JOIN': case 'UPDATE': case 'INTO': return 'from';
    case 'ON': case 'USING': return 'on';
    case 'WHERE': return 'where';
    case 'GROUP BY': return 'groupBy';
    case 'HAVING': return 'having';
    case 'ORDER BY': return 'orderBy';
    case 'LIMIT': case 'OFFSET': case 'TOP': return 'limit';
    case 'SET': return 'set';
    case 'VALUES': return 'values';
    case 'UNION': return 'start';
    default: return 'other';
  }
}

/** The clause the cursor is in, given the statement text before the cursor. Sub-queries count on their own. */
export function clauseAt(textBefore: string): Clause {
  const masked = maskSql(textBefore);
  const stack: Clause[] = ['start'];
  for (const m of masked.matchAll(CLAUSE_RE)) {
    const t = m[0];
    if (t === '(') stack.push(stack[stack.length - 1]); // "COUNT(" in SELECT is still SELECT; "(SELECT" overrides below
    else if (t === ')') { if (stack.length > 1) stack.pop(); }
    else stack[stack.length - 1] = clauseOf(t);
  }
  return stack[stack.length - 1];
}

// ---------------------------------------------------------------- SELECT list

export interface SelectItem { expr: string; alias?: string; aggregated: boolean }

const AGG_RE = /\b(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|STRING_AGG|STDDEV|VARIANCE|BIT_AND|BIT_OR|JSON_ARRAYAGG|JSON_OBJECTAGG)\s*\(/i;

/** Items of the top-level SELECT list of a statement (used for GROUP BY / ORDER BY suggestions). */
export function selectItems(stmt: string): SelectItem[] {
  const masked = maskSql(stmt);
  const sel = /\bSELECT\b(?:\s+(?:DISTINCT|ALL)\b)?(?:\s+TOP\s+\d+)?/i.exec(masked);
  if (!sel) return [];
  const parts: [number, number][] = [];
  let depth = 0;
  let partStart = sel.index + sel[0].length;
  let i = partStart;
  for (; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) break; depth--; }
    else if (c === ';') break;
    else if (depth === 0 && c === ',') { parts.push([partStart, i]); partStart = i + 1; }
    else if (depth === 0 && /\W/.test(masked[i - 1] ?? ' ') && /^(FROM|WHERE|GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|UNION|INTO)\b/i.test(masked.slice(i, i + 12))) break;
  }
  parts.push([partStart, i]);
  const KW = /^(END|ASC|DESC|AND|OR|NOT|NULL|THEN|ELSE)$/i;
  return parts.map(([a, b]) => {
    const expr = stmt.slice(a, b).trim();
    let m = /^(.*\S)\s+AS\s+([`"[]?[\w$ ]+?[`"\]]?)$/is.exec(expr);
    if (!m) { m = /^(.*[)\w`"\]])\s+([\w$]+)$/s.exec(expr); if (m && (KW.test(m[2]) || /\b(CASE|WHEN)\b/i.test(m[1]) && !/\bEND$/i.test(m[1]))) m = null; }
    const body = m ? m[1].trim() : expr;
    const alias = m ? m[2].replace(/^[`"[]|[`"\]]$/g, '') : undefined;
    return { expr: body, alias, aggregated: AGG_RE.test(body) };
  }).filter((p) => p.expr);
}

// ---------------------------------------------------------------- functions

export interface SqlFunction {
  name: string;
  /** Usage, e.g. "DATE_FORMAT(date, format)". */
  sig: string;
  doc: string;
  /** Monaco snippet inserted on accept. */
  snippet: string;
  kind: 'aggregate' | 'string' | 'date' | 'number' | 'logic' | 'json' | 'other';
  only?: DbType;
}

const F = (name: string, sig: string, doc: string, snippet: string, kind: SqlFunction['kind'], only?: DbType): SqlFunction => ({ name, sig, doc, snippet, kind, only });

export const SQL_FUNCTIONS: SqlFunction[] = [
  F('COUNT', 'COUNT(*) | COUNT(DISTINCT col)', 'Number of rows (or of non-NULL / distinct values).', 'COUNT(${1:*})', 'aggregate'),
  F('SUM', 'SUM(col)', 'Total of a numeric column (NULLs ignored).', 'SUM(${1:col})', 'aggregate'),
  F('AVG', 'AVG(col)', 'Average of a numeric column.', 'AVG(${1:col})', 'aggregate'),
  F('MIN', 'MIN(col)', 'Smallest value.', 'MIN(${1:col})', 'aggregate'),
  F('MAX', 'MAX(col)', 'Largest value.', 'MAX(${1:col})', 'aggregate'),
  F('GROUP_CONCAT', "GROUP_CONCAT(col ORDER BY col SEPARATOR ', ')", 'Joins the group\'s values into one string.', "GROUP_CONCAT(${1:col} SEPARATOR '${2:, }')", 'aggregate', 'mysql'),
  F('STRING_AGG', "STRING_AGG(col, ', ')", 'Joins the group\'s values into one string.', "STRING_AGG(${1:col}, '${2:, }')", 'aggregate', 'mssql'),
  F('COALESCE', 'COALESCE(a, b, …)', 'First value that is not NULL.', 'COALESCE(${1:col}, ${2:0})', 'logic'),
  F('IFNULL', 'IFNULL(col, fallback)', 'fallback when col is NULL.', 'IFNULL(${1:col}, ${2:0})', 'logic', 'mysql'),
  F('ISNULL', 'ISNULL(col, fallback)', 'fallback when col is NULL.', 'ISNULL(${1:col}, ${2:0})', 'logic', 'mssql'),
  F('NULLIF', 'NULLIF(a, b)', 'NULL when a = b, else a (avoids division by zero).', 'NULLIF(${1:col}, ${2:0})', 'logic'),
  F('IF', 'IF(condition, then, else)', 'Value depending on a condition.', 'IF(${1:condition}, ${2:1}, ${3:0})', 'logic', 'mysql'),
  F('IIF', 'IIF(condition, then, else)', 'Value depending on a condition.', 'IIF(${1:condition}, ${2:1}, ${3:0})', 'logic', 'mssql'),
  F('CAST', 'CAST(expr AS type)', 'Converts to another type, e.g. CAST(x AS DECIMAL(12,2)).', 'CAST(${1:col} AS ${2:CHAR})', 'other'),
  F('CONCAT', 'CONCAT(a, b, …)', 'Joins strings.', 'CONCAT(${1:a}, ${2:b})', 'string'),
  F('CONCAT_WS', "CONCAT_WS(', ', a, b, …)", 'Joins strings with a separator (skips NULLs).', "CONCAT_WS('${1: }', ${2:a}, ${3:b})", 'string'),
  F('LOWER', 'LOWER(str)', 'Lower case.', 'LOWER(${1:col})', 'string'),
  F('UPPER', 'UPPER(str)', 'Upper case.', 'UPPER(${1:col})', 'string'),
  F('TRIM', 'TRIM(str)', 'Removes leading and trailing spaces.', 'TRIM(${1:col})', 'string'),
  F('LENGTH', 'LENGTH(str)', 'Length in bytes (CHAR_LENGTH for characters).', 'LENGTH(${1:col})', 'string', 'mysql'),
  F('LEN', 'LEN(str)', 'Length in characters.', 'LEN(${1:col})', 'string', 'mssql'),
  F('SUBSTRING', 'SUBSTRING(str, start, length)', 'Part of a string (start at 1).', 'SUBSTRING(${1:col}, ${2:1}, ${3:10})', 'string'),
  F('LEFT', 'LEFT(str, n)', 'First n characters.', 'LEFT(${1:col}, ${2:5})', 'string'),
  F('RIGHT', 'RIGHT(str, n)', 'Last n characters.', 'RIGHT(${1:col}, ${2:5})', 'string'),
  F('REPLACE', 'REPLACE(str, from, to)', 'Replaces every occurrence.', "REPLACE(${1:col}, '${2:from}', '${3:to}')", 'string'),
  F('ROUND', 'ROUND(num, decimals)', 'Rounds a number.', 'ROUND(${1:col}, ${2:2})', 'number'),
  F('ABS', 'ABS(num)', 'Absolute value.', 'ABS(${1:col})', 'number'),
  F('NOW', 'NOW()', 'Current date and time.', 'NOW()', 'date', 'mysql'),
  F('CURDATE', 'CURDATE()', 'Today\'s date.', 'CURDATE()', 'date', 'mysql'),
  F('GETDATE', 'GETDATE()', 'Current date and time.', 'GETDATE()', 'date', 'mssql'),
  F('DATE', 'DATE(datetime)', 'Date part only (drops the time).', 'DATE(${1:col})', 'date', 'mysql'),
  F('DATE_FORMAT', "DATE_FORMAT(date, '%Y-%m-%d')", 'Formats a date: %Y year, %m month, %d day, %H:%i time.', "DATE_FORMAT(${1:col}, '${2:%Y-%m}')", 'date', 'mysql'),
  F('FORMAT', "FORMAT(date, 'yyyy-MM-dd')", 'Formats a date or number.', "FORMAT(${1:col}, '${2:yyyy-MM}')", 'date', 'mssql'),
  F('DATE_SUB', 'DATE_SUB(date, INTERVAL n DAY)', 'Date minus an interval.', 'DATE_SUB(${1:CURDATE()}, INTERVAL ${2:7} ${3:DAY})', 'date', 'mysql'),
  F('DATE_ADD', 'DATE_ADD(date, INTERVAL n DAY)', 'Date plus an interval.', 'DATE_ADD(${1:CURDATE()}, INTERVAL ${2:7} ${3:DAY})', 'date', 'mysql'),
  F('DATEADD', 'DATEADD(day, n, date)', 'Date plus an interval.', 'DATEADD(${1:day}, ${2:-7}, ${3:GETDATE()})', 'date', 'mssql'),
  F('DATEDIFF', 'DATEDIFF(end, start)', 'Days between two dates (SQL Server: DATEDIFF(day, start, end)).', 'DATEDIFF(${1:end}, ${2:start})', 'date'),
  F('TIMESTAMPDIFF', 'TIMESTAMPDIFF(MONTH, start, end)', 'Difference in a unit (DAY, MONTH, YEAR, HOUR…).', 'TIMESTAMPDIFF(${1:DAY}, ${2:start}, ${3:end})', 'date', 'mysql'),
  F('YEAR', 'YEAR(date)', 'Year of a date.', 'YEAR(${1:col})', 'date'),
  F('MONTH', 'MONTH(date)', 'Month of a date (1-12).', 'MONTH(${1:col})', 'date'),
  F('LAST_DAY', 'LAST_DAY(date)', 'Last day of that month.', 'LAST_DAY(${1:col})', 'date', 'mysql'),
  F('STR_TO_DATE', "STR_TO_DATE(str, '%d-%m-%Y')", 'Parses a string into a date.', "STR_TO_DATE(${1:col}, '${2:%d-%m-%Y}')", 'date', 'mysql'),
  F('JSON_EXTRACT', "JSON_EXTRACT(json, '$.key')", 'Value from a JSON document (col->>\'$.key\' gives text).', "JSON_EXTRACT(${1:col}, '\\$.${2:key}')", 'json', 'mysql'),
  F('JSON_VALUE', "JSON_VALUE(json, '$.key')", 'Scalar value from a JSON document.', "JSON_VALUE(${1:col}, '\\$.${2:key}')", 'json', 'mssql'),
  F('ROW_NUMBER', 'ROW_NUMBER() OVER (PARTITION BY a ORDER BY b)', 'Row number within each group (latest row per customer, …).', 'ROW_NUMBER() OVER (PARTITION BY ${1:col} ORDER BY ${2:col} DESC)', 'other'),
];

export function functionsFor(type: DbType): SqlFunction[] {
  return SQL_FUNCTIONS.filter((f) => !f.only || f.only === type);
}

/** Which kinds of functions fit a clause best (shown first). */
export function preferredFunctionKinds(clause: Clause): SqlFunction['kind'][] {
  switch (clause) {
    case 'select': return ['aggregate', 'logic', 'string', 'date'];
    case 'having': return ['aggregate'];
    case 'where': case 'on': return ['date', 'string', 'logic'];
    case 'groupBy': case 'orderBy': return ['date', 'string'];
    default: return [];
  }
}

// ---------------------------------------------------------------- snippets

export interface SqlSnippet { prefix: string; label: string; body: string; doc: string; clauses: Clause[] }

export function snippetsFor(type: DbType): SqlSnippet[] {
  const lim = (n: string, body: string) => (type === 'mssql' ? body.replace('SELECT ', `SELECT TOP ${n} `) : body + `\nLIMIT ${n}`);
  const S = (prefix: string, label: string, body: string, doc: string, clauses: Clause[] = ['start']): SqlSnippet => ({ prefix, label, body, doc, clauses });
  return [
    S('sel', 'SELECT … FROM … WHERE', lim('${4:100}', 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:1 = 1}'), 'Basic query'),
    S('cnt', 'COUNT rows', 'SELECT COUNT(*)\nFROM ${1:table}\nWHERE ${2:1 = 1}', 'How many rows match'),
    S('dup', 'Find duplicates', 'SELECT ${2:col}, COUNT(*) AS cnt\nFROM ${1:table}\nGROUP BY ${2:col}\nHAVING COUNT(*) > 1\nORDER BY cnt DESC', 'Values that appear more than once'),
    S('grp', 'GROUP BY with count', 'SELECT ${2:col}, COUNT(*) AS cnt\nFROM ${1:table}\nGROUP BY ${2:col}\nORDER BY cnt DESC', 'Count per value'),
    S('top', 'Latest rows', lim('${3:20}', 'SELECT *\nFROM ${1:table}\nORDER BY ${2:id} DESC'), 'Newest rows first'),
    S('today', 'Rows created today', type === 'mssql'
      ? 'SELECT *\nFROM ${1:table}\nWHERE ${2:created_at} >= CAST(GETDATE() AS DATE)'
      : 'SELECT *\nFROM ${1:table}\nWHERE ${2:created_at} >= CURDATE()', 'Filter on today\'s date'),
    S('month', 'Count per month', type === 'mssql'
      ? "SELECT FORMAT(${2:created_at}, 'yyyy-MM') AS month, COUNT(*) AS cnt\nFROM ${1:table}\nGROUP BY FORMAT(${2:created_at}, 'yyyy-MM')\nORDER BY month"
      : "SELECT DATE_FORMAT(${2:created_at}, '%Y-%m') AS month, COUNT(*) AS cnt\nFROM ${1:table}\nGROUP BY month\nORDER BY month", 'Monthly trend'),
    S('latestper', 'Latest row per group', 'SELECT *\nFROM (\n  SELECT t.*, ROW_NUMBER() OVER (PARTITION BY ${2:customer_id} ORDER BY ${3:id} DESC) AS rn\n  FROM ${1:table} t\n) x\nWHERE rn = 1', 'One (newest) row per key'),
    S('miss', 'Rows without a match', 'SELECT a.*\nFROM ${1:table_a} a\nLEFT JOIN ${2:table_b} b ON b.${3:a_id} = a.${4:id}\nWHERE b.${3:a_id} IS NULL', 'Rows in A that have no row in B'),
    S('upd', 'UPDATE … WHERE', 'UPDATE ${1:table}\nSET ${2:col} = ${3:value}\nWHERE ${4:id} = ${5:0}', 'Update with a WHERE (safe)'),
    S('del', 'DELETE … WHERE', 'DELETE FROM ${1:table}\nWHERE ${2:id} = ${3:0}', 'Delete with a WHERE (safe)'),
    S('ins', 'INSERT row', 'INSERT INTO ${1:table} (${2:col1}, ${3:col2})\nVALUES (${4:v1}, ${5:v2})', 'Insert one row'),
    S('lj', 'LEFT JOIN … ON', 'LEFT JOIN ${1:table} ${2:t} ON ${2:t}.${3:id} = ${4}', 'Join that keeps rows without a match', ['from', 'on', 'where']),
    S('case', 'CASE WHEN … END', 'CASE WHEN ${1:condition} THEN ${2:a} ELSE ${3:b} END', 'Conditional value', ['select', 'where', 'orderBy', 'groupBy']),
    S('exists', 'EXISTS (sub-query)', 'EXISTS (SELECT 1 FROM ${1:table} x WHERE x.${2:id} = ${3})', 'Has at least one matching row', ['where', 'on']),
    S('between', 'BETWEEN dates', "${1:created_at} BETWEEN '${2:2025-01-01}' AND '${3:2025-01-31}'", 'Date range (inclusive)', ['where', 'on']),
  ];
}

// ---------------------------------------------------------------- learning from history

export interface LearnedJoin { a: string; colA: string; b: string; colB: string }

export interface UsageStats {
  /** "db.table" (lower case) → times used */
  tables: Map<string, number>;
  /** "table.column" (lower case, table without db) → times used */
  columns: Map<string, number>;
  /** "tableA|tableB" (sorted, lower case) → condition key → count */
  joins: Map<string, Map<string, { join: LearnedJoin; count: number }>>;
}

export const emptyStats = (): UsageStats => ({ tables: new Map(), columns: new Map(), joins: new Map() });

const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

/** Learns from one query that ran successfully. */
export function learnFromSql(stats: UsageStats, sql: string, defaultDb: string, type: DbType): void {
  const masked = maskSql(sql);
  const refs = parseTableRefs(masked, defaultDb, type);
  if (!refs.length) return;
  const byQ = new Map<string, TableRef>();
  for (const r of refs) {
    byQ.set(r.qualifier.toLowerCase(), r);
    bump(stats.tables, (r.db + '.' + baseName(r.table)).toLowerCase());
  }
  const tableOf = (q: string) => byQ.get(q.toLowerCase());
  // qualified columns: la.customer_id
  for (const m of masked.matchAll(/\b([\w$]+)\.([\w$]+)\b(?!\s*\()/g)) {
    const r = tableOf(m[1]);
    if (r) bump(stats.columns, (baseName(r.table) + '.' + m[2]).toLowerCase());
  }
  // bare columns in single-table queries
  if (refs.length === 1) {
    const t = baseName(refs[0].table).toLowerCase();
    const sel = selectItems(sql);
    for (const s of sel) if (/^[\w$]+$/.test(s.expr) && s.expr !== '*') bump(stats.columns, t + '.' + s.expr.toLowerCase());
    for (const m of masked.matchAll(/\b(?:WHERE|AND|OR|BY|,)\s+([\w$]+)\s*(?:=|<|>|!|\bIN\b|\bLIKE\b|\bIS\b|\bBETWEEN\b|,|$|\s+(?:ASC|DESC)\b)/gi)) {
      bump(stats.columns, t + '.' + m[1].toLowerCase());
    }
  }
  // join conditions: a.x = b.y anywhere in ON / WHERE
  for (const m of masked.matchAll(/\b([\w$]+)\.([\w$]+)\s*=\s*([\w$]+)\.([\w$]+)\b/g)) {
    const ra = tableOf(m[1]);
    const rb = tableOf(m[3]);
    if (!ra || !rb || ra === rb) continue;
    const ta = baseName(ra.table).toLowerCase();
    const tb = baseName(rb.table).toLowerCase();
    let join: LearnedJoin = { a: ta, colA: m[2], b: tb, colB: m[4] };
    if (tb < ta || (ta === tb && m[4] < m[2])) join = { a: tb, colA: m[4], b: ta, colB: m[2] };
    const pair = join.a + '|' + join.b;
    const key = (join.colA + '=' + join.colB).toLowerCase();
    const map = stats.joins.get(pair) ?? new Map();
    const hit = map.get(key);
    if (hit) hit.count++;
    else map.set(key, { join, count: 1 });
    stats.joins.set(pair, map);
  }
}

/**
 * Join conditions the user wrote before between the table just joined and the earlier tables,
 * rewritten with the aliases of this query, most used first.
 */
export function learnedJoinConditions(stats: UsageStats, target: TableRef, earlier: TableRef[]): { cond: string; count: number }[] {
  const out: { cond: string; count: number }[] = [];
  const tt = baseName(target.table).toLowerCase();
  for (const e of earlier) {
    const te = baseName(e.table).toLowerCase();
    const pair = tt < te ? tt + '|' + te : te + '|' + tt;
    for (const { join, count } of stats.joins.get(pair)?.values() ?? []) {
      // orient: target column first ("c.id = la.customer_id")
      const [ct, ce] = join.a === tt ? [join.colA, join.colB] : [join.colB, join.colA];
      if (tt === te) {
        // self join: both orientations are possible
        out.push({ cond: `${target.qualifier}.${join.colA} = ${e.qualifier}.${join.colB}`, count });
        continue;
      }
      out.push({ cond: `${target.qualifier}.${ct} = ${e.qualifier}.${ce}`, count });
    }
  }
  const seen = new Set<string>();
  return out.sort((x, y) => y.count - x.count).filter((x) => (seen.has(x.cond) ? false : (seen.add(x.cond), true)));
}

// ---------------------------------------------------------------- did you mean

export interface MissingName { kind: 'column' | 'table'; name: string; qualifier?: string }

/** The misspelled name in a database error, if it is an unknown column / table error. */
export function parseMissingName(message: string): MissingName | null {
  let m = /Unknown column '([^']+)'/i.exec(message) ?? /Invalid column name '([^']+)'/i.exec(message);
  if (m) {
    const parts = m[1].split('.');
    return { kind: 'column', name: parts[parts.length - 1], qualifier: parts.length > 1 ? parts[parts.length - 2] : undefined };
  }
  m = /Table '([^']+)' doesn't exist/i.exec(message) ?? /Invalid object name '([^']+)'/i.exec(message);
  if (m) {
    const parts = m[1].split('.');
    return { kind: 'table', name: parts[parts.length - 1], qualifier: parts.length > 1 ? parts.slice(0, -1).join('.') : undefined };
  }
  return null;
}

/** Optimal string alignment distance (Levenshtein with adjacent swaps), case-insensitive. */
export function editDistance(a: string, b: string): number {
  a = a.toLowerCase(); b = b.toLowerCase();
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The closest names (best first), only if they are close enough to be a likely typo. */
export function closestNames(name: string, candidates: Iterable<string>, max = 3): string[] {
  const n = name.toLowerCase();
  const norm = (s: string) => s.toLowerCase().replace(/_/g, '');
  const scored: { c: string; s: number }[] = [];
  for (const c of new Set(candidates)) {
    if (c.toLowerCase() === n) continue;
    let s = editDistance(name, c);
    if (norm(c) === norm(name)) s = 0.5; // only underscores differ: customerid vs customer_id
    else if ((c.toLowerCase().includes(n) || n.includes(c.toLowerCase())) && Math.min(c.length, n.length) >= 0.6 * Math.max(c.length, n.length)) s = Math.min(s, 1.5);
    const limit = Math.max(2, Math.floor(Math.max(name.length, c.length) / 3));
    if (s <= limit) scored.push({ c, s });
  }
  return scored.sort((a, b) => a.s - b.s || a.c.localeCompare(b.c)).slice(0, max).map((x) => x.c);
}

/** Replaces the whole-word name (optionally "qualifier.name") in the statement text. */
export function replaceName(sql: string, missing: MissingName, replacement: string): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const q = missing.qualifier ? `(${esc(missing.qualifier)}\\s*\\.\\s*)` : '()';
  const re = new RegExp(`(^|[^\\w$.])${q}[\`"\\[]?${esc(missing.name)}[\`"\\]]?(?![\\w$])`, 'gi');
  return sql.replace(re, (_m, pre: string, qual: string) => pre + qual + replacement);
}

// ---------------------------------------------------------------- safety hints

export interface SqlHint {
  kind: 'noWhere' | 'joinNoOn' | 'selectStar';
  /** Offsets within the text given to lintSql. */
  start: number;
  end: number;
  message: string;
  /** For selectStar: the tables of the statement, so the caller can check their size. */
  refs?: TableRef[];
}

/** Statements of a script, as [start, end) ranges (split on ; outside strings / comments). */
export function statementRanges(text: string): [number, number][] {
  const masked = maskSql(text);
  const out: [number, number][] = [];
  let s = 0;
  for (let i = 0; i < masked.length; i++) if (masked[i] === ';') { out.push([s, i]); s = i + 1; }
  if (masked.slice(s).trim()) out.push([s, masked.length]);
  return out.filter(([a, b]) => masked.slice(a, b).trim());
}

// ---------------------------------------------------------------- statements without ";"

/** One statement of a script. `noSemicolon`: it ends at a blank line (the next line starts a new statement). */
export interface StatementRange {
  start: number;
  /** Exclusive; trailing spaces trimmed. */
  end: number;
  noSemicolon: boolean;
}

/** Words that start a statement. Ambiguous ones (SET, VALUES, WITH, SELECT after INSERT…) are checked below. */
const STATEMENT_START = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'CREATE',
  'ALTER', 'DROP', 'TRUNCATE', 'USE', 'CALL', 'GRANT', 'REVOKE', 'RENAME', 'LOCK', 'UNLOCK', 'START', 'COMMIT',
  'ROLLBACK', 'ANALYZE', 'OPTIMIZE', 'DECLARE', 'EXEC', 'EXECUTE', 'MERGE', 'PRINT', 'TABLE', 'KILL', 'FLUSH',
  'SET',
]);
/** The previous text ends with one of these, so the next line continues the same statement. */
const CONTINUES = new Set([
  'UNION', 'ALL', 'DISTINCT', 'AS', 'AND', 'OR', 'NOT', 'ON', 'WHERE', 'FROM', 'JOIN', 'SELECT', 'BY', 'IN', 'EXISTS',
  'THEN', 'ELSE', 'WHEN', 'INTO', 'SET', 'VALUES', 'WITH', 'HAVING', 'LIMIT', 'EXCEPT', 'INTERSECT', 'CASE', 'IS',
  'LIKE', 'BETWEEN', 'RETURN', 'BEGIN',
]);

/**
 * Statements of a script: split on ";" (and on GO lines for SQL Server), and, when `blankLines` is on, also at
 * a blank line when the next line starts a new statement (SELECT, INSERT, UPDATE…) and the text before it is
 * complete: not inside brackets, strings or comments, not after UNION / AND / a comma…, not an INSERT that
 * still waits for its SELECT / VALUES, and not an UPDATE that still waits for its SET. Scripts with
 * BEGIN … END blocks are only split on ";".
 */
export function smartStatements(text: string, opts: { blankLines: boolean; dialect: 'mysql' | 'mssql' }): StatementRange[] {
  const masked = maskSql(text);
  const out: StatementRange[] = [];
  const push = (a: number, b: number, noSemicolon: boolean) => {
    while (a < b && /\s/.test(masked[a])) a++;
    while (b > a && /\s/.test(masked[b - 1])) b--;
    if (b > a) out.push({ start: a, end: b, noSemicolon });
  };
  // Hard separators: ";" at the top level, and GO lines on SQL Server.
  const hard: [number, number][] = [];
  let s = 0;
  const goRe = /^[ \t]*GO[ \t]*;?[ \t]*$/gim;
  const gos = opts.dialect === 'mssql' ? [...masked.matchAll(goRe)].map((m) => [m.index!, m.index! + m[0].length]) : [];
  let g = 0;
  for (let i = 0; i < masked.length; i++) {
    if (g < gos.length && i === gos[g][0]) { hard.push([s, i]); i = gos[g][1] - 1; s = gos[g][1]; g++; continue; }
    if (masked[i] === ';') { hard.push([s, i]); s = i + 1; }
  }
  hard.push([s, masked.length]);
  const blocks = /\bBEGIN\b(?![ \t]*(;|WORK\b|TRAN|TRANSACTION\b|DISTRIBUTED\b))/i.test(masked) || /\bDELIMITER\b/i.test(masked);
  for (const [a, b] of hard) {
    if (!opts.blankLines || blocks) { push(a, b, false); continue; }
    let segStart = a;
    let depth = 0;
    for (let i = a; i < b; i++) {
      const c = masked[i];
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === '\n' && depth === 0) {
        // blank line(s) after this newline?
        const m = /^[ \t\r]*\n[\s]*/.exec(masked.slice(i + 1, b));
        if (!m) continue;
        const next = i + 1 + m[0].length;
        if (next >= b) break;
        const word = /^[A-Za-z_]+/.exec(masked.slice(next, next + 20))?.[0]?.toUpperCase();
        if (!word || !STATEMENT_START.has(word)) continue;
        const before = masked.slice(segStart, i);
        if (!before.trim()) continue;
        if (!isComplete(before, word)) continue;
        push(segStart, i, true);
        segStart = next;
        i = next - 1;
      }
    }
    push(segStart, b, false);
  }
  return out;
}

/** True when `before` (masked) is a whole statement, so a statement starting with `nextWord` can follow. */
function isComplete(before: string, nextWord: string): boolean {
  const trimmed = before.trimEnd();
  if (/[,(=<>+\-*/|.!]$/.test(trimmed)) return false;
  const lastWord = /([A-Za-z_]+)\W*$/.exec(trimmed)?.[1]?.toUpperCase();
  if (lastWord && CONTINUES.has(lastWord) && /[A-Za-z_]$/.test(trimmed)) return false;
  // top-level words of the statement so far
  let top = '';
  let depth = 0;
  for (const c of before) { if (c === '(') depth++; if (depth === 0) top += c; else top += ' '; if (c === ')') depth = Math.max(0, depth - 1); }
  const first = /^\s*([A-Za-z_]+)/.exec(top)?.[1]?.toUpperCase();
  const has = (w: string) => new RegExp(`\\b${w}\\b`, 'i').test(top);
  if (first === 'INSERT' || first === 'REPLACE') {
    if (!has('SELECT') && !has('VALUES') && !has('VALUE') && !has('SET') && !has('TABLE')) return false; // INSERT INTO t (…) ⏎⏎ SELECT …
  }
  if (first === 'CREATE' && ['SELECT', 'WITH', 'TABLE'].includes(nextWord) && !has('SELECT')) return false; // CREATE VIEW v AS ⏎⏎ SELECT
  if (first === 'UPDATE' && nextWord === 'SET' && !has('SET')) return false; // UPDATE t ⏎⏎ SET …
  if (first === 'WITH' && !has('SELECT') && !has('UPDATE') && !has('DELETE') && !has('INSERT')) return false; // WITH x AS (…) ⏎⏎ SELECT
  if (first === 'EXPLAIN' && !/^\s*EXPLAIN\s+(FORMAT\s*=\s*\w+\s+)?(ANALYZE\s+)?\w+\s+\S/i.test(top)) return false;
  return true;
}

/**
 * The script to send to the server: a ";" is added after every statement that ends at a blank line, so the
 * server gets them as separate statements. Line numbers stay the same.
 */
export function withSemicolons(text: string, ranges: StatementRange[]): string {
  let out = '';
  let last = 0;
  for (const r of ranges) {
    if (!r.noSemicolon) continue;
    out += text.slice(last, r.end) + ';';
    last = r.end;
  }
  return out + text.slice(last);
}

/** The statement the cursor is in; between statements, the one just above (or the next one at the top). */
export function statementAt(ranges: StatementRange[], offset: number): StatementRange | undefined {
  let best: StatementRange | undefined;
  for (const r of ranges) {
    if (offset >= r.start && offset <= r.end) return r;
    if (r.end <= offset) best = r; // ranges are in order: the last one that ends before the cursor
  }
  if (best) {
    // the cursor is on the ";" line or the blank lines right after the statement: use it, unless the next
    // statement starts on the same line as the cursor
    return best;
  }
  return ranges[0];
}

/** UPDATE / DELETE without WHERE, JOIN without ON, and SELECT * (size checked by the caller). */
export function lintSql(text: string, defaultDb: string, type: DbType): SqlHint[] {
  const masked = maskSql(text);
  const hints: SqlHint[] = [];
  // blank-line statements count as separate ones here too, so "UPDATE t SET …⏎⏎SELECT … WHERE" still warns
  for (const { start: a, end: b } of smartStatements(text, { blankLines: true, dialect: type === 'mssql' ? 'mssql' : 'mysql' })) {
    const stmt = masked.slice(a, b);
    const lead = stmt.search(/\S/);
    const first = /^\s*(\w+)/.exec(stmt)?.[1]?.toUpperCase();
    // top-level text only (sub-queries removed) for WHERE detection
    let top = '';
    let depth = 0;
    for (const c of stmt) { if (c === '(') depth++; if (depth === 0) top += c; else top += ' '; if (c === ')') depth = Math.max(0, depth - 1); }
    if ((first === 'UPDATE' || first === 'DELETE') && !/\bWHERE\b/i.test(top)) {
      const kw = first === 'UPDATE' ? 'UPDATE' : 'DELETE';
      hints.push({ kind: 'noWhere', start: a + lead, end: a + lead + kw.length,
        message: `${kw} without WHERE changes every row of the table.` });
    }
    // JOIN without ON / USING (CROSS / NATURAL joins are fine)
    const joinRe = /\b((?:CROSS|NATURAL)\s+)?JOIN\b/gi;
    const joins = [...stmt.matchAll(joinRe)];
    joins.forEach((j, idx) => {
      if (j[1]) return;
      const from = (j.index ?? 0) + j[0].length;
      const nextJoin = joins[idx + 1]?.index ?? stmt.length;
      const segment = stmt.slice(from, nextJoin);
      const stop = segment.search(/\b(WHERE|GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|UNION)\b/i);
      const part = stop >= 0 ? segment.slice(0, stop) : segment;
      if (!/\b(ON|USING)\b/i.test(part) && /\w/.test(part)) {
        hints.push({ kind: 'joinNoOn', start: a + (j.index ?? 0), end: a + from,
          message: 'JOIN without ON: every row is combined with every row of the other table (can be huge). Add ON a.id = b.a_id.' });
      }
    });
    const star = /\bSELECT\s+(?:DISTINCT\s+)?(?:TOP\s+\d+\s+)?\*/i.exec(top);
    if (star && first === 'SELECT' && !/\bWHERE\b/i.test(top)) {
      hints.push({ kind: 'selectStar', start: a + star.index, end: a + star.index + star[0].length, message: '',
        refs: parseTableRefs(stmt, defaultDb, type) });
    }
  }
  return hints;
}
