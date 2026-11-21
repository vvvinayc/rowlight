// Inline row editing: decide whether a result can be edited, and turn pending
// grid changes into parameterised UPDATE / INSERT / DELETE statements.
// Pure functions (no driver access) so they are easy to unit test.

import type { ChangeSet, ColumnInfo, EditInfo, RowValues } from '../shared/types';
import { tokenize, type Dialect } from './sqlSafety';

export interface ParamStatement {
  sql: string;
  params: unknown[];
  expectOne: boolean;
}

const unquote = (s: string) => s.replace(/^[\[`"]|[\]`"]$/g, '').replace(/\]\]/g, ']').replace(/``/g, '`');

/** Is the statement a SELECT (the only kind of result we allow editing for)? */
export function isPlainSelect(stmt: string, dialect: Dialect): boolean {
  const first = tokenize(stmt, dialect).find((t) => t.type === 'word');
  return first?.value === 'SELECT';
}

/**
 * SQL Server does not report the source table of result columns, so we read it from the SQL:
 * "SELECT ... FROM [db.][schema.]table [alias] [WHERE/ORDER BY ...]" with no joins, unions, grouping.
 */
export function simpleSelectTable(stmt: string, dialect: Dialect): { database?: string; table: string } | string {
  const tokens = tokenize(stmt, dialect);
  if (tokens[0]?.value !== 'SELECT') return 'only plain SELECT results can be edited';
  let depth = 0;
  let fromIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    else if (depth === 0 && t.type === 'word') {
      if (['JOIN', 'UNION', 'INTERSECT', 'EXCEPT', 'GROUP', 'DISTINCT', 'APPLY', 'PIVOT', 'UNPIVOT', 'INTO'].includes(t.value)) {
        return `the query uses ${t.value}, so rows cannot be mapped back to one table`;
      }
      if (t.value === 'FROM') {
        if (fromIdx >= 0) return 'the query reads from several tables';
        fromIdx = i;
      }
    }
  }
  if (fromIdx < 0) return 'the query has no FROM table';
  const parts: string[] = [];
  let i = fromIdx + 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'ident') parts.push(unquote(t.value));
    else if (t.type === 'word') parts.push(...stmt.slice(t.start, t.end).split('.').filter(Boolean)); // keep original case
    else break;
    i++;
    if (tokens[i]?.type === 'punct' && tokens[i].value === '.') { i++; continue; }
    break;
  }
  // a following comma means "FROM a, b"
  let j = i;
  while (j < tokens.length && tokens[j].type === 'word' && !['WHERE', 'ORDER', 'OPTION'].includes(tokens[j].value)) j++;
  if (tokens[j]?.type === 'punct' && tokens[j].value === ',') return 'the query reads from several tables';
  if (parts.length === 0 || parts.length > 3) return 'could not read the table name';
  if (parts.length === 3) return { database: parts[0], table: parts[1] + '.' + parts[2] };
  if (parts.length === 2) return { table: parts.join('.') };
  return { table: 'dbo.' + parts[0] };
}

/** Builds EditInfo once the table and its columns are known. */
export function buildEditInfo(
  database: string, table: string, tableColumns: ColumnInfo[], resultColumns: (string | null)[],
): EditInfo | string {
  const keyColumns = tableColumns.filter((c) => c.key === 'PRI').map((c) => c.name);
  if (tableColumns.length === 0) return `table ${table} was not found`;
  if (keyColumns.length === 0) return `table ${table} has no primary key`;
  const byLower = new Map(tableColumns.map((c) => [c.name.toLowerCase(), c.name]));
  const used = new Set<string>();
  const columnMap = resultColumns.map((rc) => {
    const real = rc ? byLower.get(rc.toLowerCase()) : undefined;
    if (!real || used.has(real)) return null; // expression, or a duplicate of an already mapped column
    used.add(real);
    return real;
  });
  const missing = keyColumns.filter((k) => !used.has(k));
  if (missing.length) return `primary key column ${missing.join(', ')} is not in the result`;
  return { database, table, columnMap, keyColumns };
}

// ---------- statement builders ----------

type Param = (v: unknown) => string;

function quoteIdent(dialect: Dialect, name: string): string {
  return dialect === 'mysql' ? '`' + name.replace(/`/g, '``') + '`' : '[' + name.replace(/]/g, ']]') + ']';
}

function quoteTable(dialect: Dialect, e: EditInfo): string {
  if (dialect === 'mysql') return (e.database ? quoteIdent(dialect, e.database) + '.' : '') + quoteIdent(dialect, e.table);
  const dot = e.table.indexOf('.');
  const schema = dot > 0 ? e.table.slice(0, dot) : 'dbo';
  const name = dot > 0 ? e.table.slice(dot + 1) : e.table;
  return (e.database ? quoteIdent(dialect, e.database) + '.' : '') + quoteIdent(dialect, schema) + '.' + quoteIdent(dialect, name);
}

function where(dialect: Dialect, key: RowValues, keyColumns: string[], p: Param): string {
  return keyColumns
    .map((k) => (key[k] === null || key[k] === undefined ? `${quoteIdent(dialect, k)} IS NULL` : `${quoteIdent(dialect, k)} = ${p(key[k])}`))
    .join(' AND ');
}

function build(dialect: Dialect, c: ChangeSet, makeParam: () => { p: Param; done: () => unknown[] }): ParamStatement[] {
  const e = c.edit;
  const t = quoteTable(dialect, e);
  const q = (n: string) => quoteIdent(dialect, n);
  const out: ParamStatement[] = [];
  const allowed = new Set(e.columnMap.filter(Boolean) as string[]);
  const check = (cols: string[]) => {
    for (const col of cols) if (!allowed.has(col)) throw new Error(`Column ${col} is not editable.`);
  };

  for (const d of c.deletes) {
    const { p, done } = makeParam();
    const sql = `DELETE FROM ${t} WHERE ${where(dialect, d.key, e.keyColumns, p)}`;
    out.push({ sql, params: done(), expectOne: true });
  }
  for (const u of c.updates) {
    const cols = Object.keys(u.set);
    if (!cols.length) continue;
    check(cols);
    const { p, done } = makeParam();
    const set = cols.map((col) => `${q(col)} = ${p(u.set[col])}`).join(', ');
    const sql = `UPDATE ${t} SET ${set} WHERE ${where(dialect, u.key, e.keyColumns, p)}`;
    out.push({ sql, params: done(), expectOne: true });
  }
  for (const row of c.inserts) {
    const cols = Object.keys(row);
    check(cols);
    const { p, done } = makeParam();
    const sql = cols.length
      ? `INSERT INTO ${t} (${cols.map(q).join(', ')}) VALUES (${cols.map((col) => p(row[col])).join(', ')})`
      : dialect === 'mysql' ? `INSERT INTO ${t} () VALUES ()` : `INSERT INTO ${t} DEFAULT VALUES`;
    out.push({ sql, params: done(), expectOne: true });
  }
  return out;
}

/** Parameterised statements for execution (MySQL "?", SQL Server "@p0, @p1…"). */
export function buildStatements(dialect: Dialect, c: ChangeSet): ParamStatement[] {
  return build(dialect, c, () => {
    const params: unknown[] = [];
    return {
      p: (v) => { params.push(v ?? null); return dialect === 'mysql' ? '?' : '@p' + (params.length - 1); },
      done: () => params,
    };
  });
}

export function sqlLiteral(dialect: Dialect, v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  let s = String(v).replace(/'/g, "''");
  if (dialect === 'mysql') s = s.replace(/\\/g, '\\\\');
  return (dialect === 'mssql' ? "N'" : "'") + s + "'";
}

/** Human readable SQL for the pending-changes panel and history (values inlined). */
export function previewStatements(dialect: Dialect, c: ChangeSet): string[] {
  return build(dialect, c, () => ({ p: (v) => sqlLiteral(dialect, v), done: () => [] })).map((s) => s.sql + ';');
}
