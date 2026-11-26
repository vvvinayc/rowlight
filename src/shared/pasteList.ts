// Pasting a column of values (from Excel, a result grid, a chat…) where SQL needs a list:
//   where loan_id in (|      + paste 3 lines  ->  where loan_id in ('6af45…', '6af5b…', '6afbe…')
//   where loan_id = |        + paste 3 lines  ->  where loan_id in ('6af45…', '6af5b…', '6afbe…')
// Numbers stay unquoted, text gets quotes. Pure, unit tested.

import { maskSql } from './sqlSmart';

const ITEM = /^[\w.\-:@/+#$]+$/u;
const SQL_WORD = /^(select|from|where|and|or|in|not|null|update|delete|insert|set|join|on|union|order|group|by)$/i;

/** The values when the text is a list of 2+ simple values (one per line, or separated by tabs / commas); else null. */
export function pastedList(text: string): string[] | null {
  const raw = text.replace(/\r/g, '').trim();
  if (!raw) return null;
  const multiLine = raw.includes('\n');
  const parts = (multiLine ? raw.split('\n') : raw.split(/[\t,]/))
    .map((s) => s.trim().replace(/,$/, '').trim().replace(/^(['"`])(.*)\1$/, '$2'))
    .filter((s) => s !== '');
  if (parts.length < 2) return null;
  if (!parts.every((p) => ITEM.test(p) && !SQL_WORD.test(p))) return null;
  return parts;
}

const isNum = (s: string) => /^-?\d+(\.\d+)?$/.test(s) && !/^0\d/.test(s); // 007 is a code, not a number

/** 'a', 'b', 'c' (numbers without quotes). More than 10 values: one per line. */
export function toSqlList(items: string[], indent = '  '): string {
  const allNum = items.every(isNum);
  const vals = items.map((v) => (allNum ? v : "'" + v.replace(/'/g, "''") + "'"));
  return vals.length > 10 ? '\n' + indent + vals.join(',\n' + indent) + '\n' : vals.join(', ');
}

/** True when the end of the text is inside a '…' / "…" / `…` string or a comment. */
export function insideStringOrComment(text: string): boolean {
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q === '--') { if (c === '\n') q = null; continue; }
    if (q === '/*') { if (c === '*' && text[i + 1] === '/') { q = null; i++; } continue; }
    if (q) { if (c === '\\' && q !== '`') i++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') q = c;
    else if ((c === '-' && text[i + 1] === '-') || c === '#') q = '--';
    else if (c === '/' && text[i + 1] === '*') { q = '/*'; i++; }
  }
  return q !== null;
}

export interface ListPaste {
  /** How many characters before the pasted text are replaced too (e.g. the "=" in "id = "). */
  replaceBefore: number;
  text: string;
  /** Short description for the status bar. */
  note: string;
}

/**
 * What to write instead of the pasted list, given the text before the paste (same statement is enough).
 * Only where SQL clearly expects a list: after "IN (", after "IN", or after "=" / "<>" / "!=" (turned into IN / NOT IN).
 * Elsewhere, and inside strings or comments: null (the paste stays as it is).
 */
export function listPaste(before: string, pasted: string): ListPaste | null {
  const items = pastedList(pasted);
  if (!items) return null;
  if (insideStringOrComment(before)) return null;
  const tail = maskSql(before.slice(-400));
  const n = items.length;
  let m: RegExpMatchArray | null;
  if ((m = /\bin\s*\(\s*$/i.exec(tail))) return { replaceBefore: 0, text: toSqlList(items), note: `${n} values pasted as a list` };
  if ((m = /\bin\s*$/i.exec(tail))) return { replaceBefore: 0, text: '(' + toSqlList(items) + ')', note: `${n} values pasted as a list` };
  if ((m = /(<>|!=|=)\s*$/.exec(tail))) {
    const op = m[1] === '=' ? 'in' : 'not in';
    const prefix = /\s$/.test(tail.slice(0, tail.length - m[0].length)) ? '' : ' ';
    return { replaceBefore: m[0].length, text: `${prefix}${op} (${toSqlList(items)})`, note: `${n} values pasted: "${m[1]}" became ${op.toUpperCase()} (…)` };
  }
  return null;
}
