// Query parameters: write "where loan_id = :loan" and Rowlight asks for the value before running.
// Strings and comments are ignored, and so are MySQL "@x := 1" assignments and "::" casts.

import { maskSql } from './sqlSmart';

const PARAM_RE = /(^|[^:\w@$])(:([A-Za-z_][A-Za-z0-9_]*))(?![\w:=])/g;

interface Found { name: string; start: number; end: number }

function scan(sql: string): Found[] {
  const masked = maskSql(sql);
  const out: Found[] = [];
  for (const m of masked.matchAll(PARAM_RE)) {
    const start = m.index! + m[1].length;
    out.push({ name: m[3], start, end: start + m[2].length });
  }
  return out;
}

/** Parameter names in order of first use, without duplicates. */
export function findParams(sql: string): string[] {
  return [...new Set(scan(sql).map((f) => f.name))];
}

/**
 * The SQL text for a typed value: numbers, NULL and number lists (1,2,3) as they are; text quoted.
 * A value that starts with ' or ( is used exactly as typed (e.g. ('A','B') for IN).
 */
export function sqlLiteral(value: string): string {
  const v = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^-?\d+(\.\d+)?(\s*,\s*-?\d+(\.\d+)?)+$/.test(v)) return v;
  if (/^null$/i.test(v)) return 'NULL';
  if (v.startsWith("'") || v.startsWith('(')) return v;
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}

/** Replaces every :name with its value (see sqlLiteral). Names without a value are left as they are. */
export function fillParams(sql: string, values: Record<string, string>): string {
  let out = sql;
  for (const f of scan(sql).reverse()) {
    if (values[f.name] === undefined) continue;
    out = out.slice(0, f.start) + sqlLiteral(values[f.name]) + out.slice(f.end);
  }
  return out;
}
