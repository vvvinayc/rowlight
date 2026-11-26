// JSON pretty-print / minify that keeps every value exactly as written: 655.00 stays 655.00 and long numbers keep
// all their digits (JSON.parse + stringify would turn them into 655 / 1.2345678901234568e+21). Works token by token,
// so it also lays out JSON that is cut off or slightly broken; jsonError() says where the problem is.

/** True when the text is clearly meant as JSON: starts with "{", or is a valid JSON array. */
export function looksLikeJson(text: string): boolean {
  const t = text.trim();
  if (t.startsWith('{')) return true;
  if (t.startsWith('[')) { try { JSON.parse(t); return true; } catch { return false; } }
  return false;
}

/** null when valid; otherwise a short message with the line and column of the problem. */
export function jsonError(text: string): string | null {
  try { JSON.parse(text); return null; } catch (e) {
    const msg = String((e as Error).message ?? e);
    const m = /position (\d+)/.exec(msg);
    if (!m) return msg;
    const pos = Number(m[1]);
    const before = text.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    return `${msg.replace(/\s*\(line \d+ column \d+\)/, '').replace(/ in JSON at position \d+/, '')} (line ${line}, column ${col})`;
  }
}

function layout(text: string, indent: string | null): string {
  const out: string[] = [];
  let depth = 0;
  const nl = () => { if (indent !== null) out.push('\n' + indent.repeat(depth)); };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out.push(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '{' || ch === '[') {
      // Empty {} / [] stay on one line.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === (ch === '{' ? '}' : ']')) { out.push(ch + text[j]); i = j + 1; continue; }
      out.push(ch); depth++; nl(); i++; continue;
    }
    if (ch === '}' || ch === ']') { depth = Math.max(0, depth - 1); nl(); out.push(ch); i++; continue; }
    if (ch === ',') { out.push(','); nl(); i++; continue; }
    if (ch === ':') { out.push(indent !== null ? ': ' : ':'); i++; continue; }
    // number, true, false, null (or anything else): copy as written up to the next delimiter
    let j = i;
    while (j < text.length && !/[\s,:{}\[\]"]/.test(text[j])) j++;
    out.push(text.slice(i, Math.max(j, i + 1)));
    i = Math.max(j, i + 1);
  }
  return out.join('').replace(/\s+$/, '');
}

export function prettyJson(text: string, indent = '  '): string { return layout(text.trim(), indent); }
export function minifyJson(text: string): string { return layout(text.trim(), null); }

/**
 * Top-level keys of a JSON object with their values as text, exactly as written (655.00 stays "655.00").
 * Strings are unquoted, null is null, nested objects / arrays stay as compact JSON. Not an object: null.
 */
export function jsonTopLevel(text: string): Record<string, string | null> | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  const out: Record<string, string | null> = {};
  let i = 1;
  const ws = () => { while (i < t.length && /\s/.test(t[i])) i++; };
  const str = () => { const s = i; i++; while (i < t.length && t[i] !== '"') i += t[i] === '\\' ? 2 : 1; i++; return t.slice(s, i); };
  for (;;) {
    ws();
    if (i >= t.length || t[i] === '}') return out;
    if (t[i] !== '"') return null;
    let key: string;
    try { key = JSON.parse(str()); } catch { return null; }
    ws();
    if (t[i] !== ':') return null;
    i++; ws();
    const s = i;
    let depth = 0;
    while (i < t.length) {
      const ch = t[i];
      if (ch === '"') { str(); continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) break;
      i++;
    }
    const raw = t.slice(s, i).trim();
    if (raw === 'null') out[key] = null;
    else if (raw.startsWith('"')) { try { out[key] = JSON.parse(raw); } catch { out[key] = raw; } }
    else if (raw.startsWith('{') || raw.startsWith('[')) out[key] = minifyJson(raw);
    else out[key] = raw;
    if (t[i] === ',') i++;
  }
}
