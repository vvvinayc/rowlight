// SQL text utilities: tokenising, splitting scripts, read-only checks and auto-LIMIT.
// Pure functions with no dependencies so they are easy to unit test (see test/sqlSafety.test.ts).
//
// This is deliberately conservative: in read-only mode, anything we are not sure about is blocked.
// On MySQL the session is ALSO put into READ ONLY transaction mode, so the server is a second line of defence.

export type Dialect = 'mysql' | 'mssql';

export interface Token {
  type: 'word' | 'string' | 'ident' | 'punct';
  /** Upper-cased for words, raw text otherwise. */
  value: string;
  start: number;
  end: number;
}

const WORD_START = /[A-Za-z_@#$]/;
const WORD_CHAR = /[A-Za-z0-9_@#$.]/;

/** Splits SQL into tokens, skipping whitespace and comments. */
export function tokenize(sql: string, dialect: Dialect): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    // Comments
    if (c === '-' && next === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '#' && dialect === 'mysql') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    // Strings
    if (c === "'" || (c === '"' && dialect === 'mysql')) {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === '\\' && dialect === 'mysql') { i += 2; continue; }
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; } // doubled quote
          i++;
          break;
        }
        i++;
      }
      tokens.push({ type: 'string', value: sql.slice(start, i), start, end: i });
      continue;
    }
    // Quoted identifiers
    if (c === '`' || (c === '"' && dialect === 'mssql') || (c === '[' && dialect === 'mssql')) {
      const close = c === '[' ? ']' : c;
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ type: 'ident', value: sql.slice(start, i), start, end: i });
      continue;
    }
    if (WORD_START.test(c) || /[0-9]/.test(c)) {
      const start = i;
      while (i < n && WORD_CHAR.test(sql[i])) i++;
      tokens.push({ type: 'word', value: sql.slice(start, i).toUpperCase(), start, end: i });
      continue;
    }
    tokens.push({ type: 'punct', value: c, start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

/**
 * Splits a script into statements.
 * MySQL: on top-level ";" (DELIMITER is not supported).
 * SQL Server: on "GO" lines (each batch is sent as a whole, like SSMS).
 */
export function splitStatements(sql: string, dialect: Dialect): string[] {
  if (dialect === 'mssql') {
    return sql
      .split(/^\s*GO\s*;?\s*$/gim)
      .map((s) => s.trim())
      .filter((s) => tokenize(s, dialect).length > 0);
  }
  const out: string[] = [];
  let last = 0;
  for (const t of tokenize(sql, dialect)) {
    if (t.type === 'punct' && t.value === ';') {
      out.push(sql.slice(last, t.start));
      last = t.end;
    }
  }
  out.push(sql.slice(last));
  // Keep MySQL /*! ... */ statements: the server executes them, so they must reach the read-only check.
  return out.map((s) => s.trim()).filter((s) => tokenize(s, dialect).length > 0 || s.includes('/*!'));
}

function firstWord(tokens: Token[]): Token | undefined {
  return tokens.find((t) => !(t.type === 'punct' && t.value === '('));
}

const MYSQL_ALLOWED_FIRST = new Set([
  'SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'USE', 'SET', 'HELP', 'TABLE', 'VALUES',
]);

/** Words that modify data, checked inside SELECT/WITH/EXPLAIN on MySQL. */
const MYSQL_WRITE_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'OUTFILE', 'DUMPFILE']);

/** On SQL Server we scan the whole batch, because T-SQL does not need ";" between statements. */
const MSSQL_BLOCKED_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'EXEC', 'EXECUTE',
  'GRANT', 'REVOKE', 'DENY', 'BULK', 'INTO', 'BACKUP', 'RESTORE', 'DBCC', 'KILL', 'SHUTDOWN',
  'RECONFIGURE', 'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'WRITETEXT', 'UPDATETEXT', 'ENABLE', 'DISABLE',
]);

/** Returns null if the statement is allowed in read-only mode, otherwise a human readable reason. */
export function checkReadOnly(stmt: string, dialect: Dialect): string | null {
  if (dialect === 'mysql' && stmt.includes('/*!')) return 'MySQL executable comments (/*! ... */) are not allowed in read-only mode';
  const tokens = tokenize(stmt, dialect);
  if (tokens.length === 0) return null;
  const words = tokens.filter((t) => t.type === 'word');

  if (dialect === 'mssql') {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'word') continue;
      if (MSSQL_BLOCKED_WORDS.has(t.value)) return `"${t.value}" is not allowed in read-only mode`;
      if (/^(SP|XP)_/.test(t.value)) return `Stored procedures (${t.value.toLowerCase()}) are not allowed in read-only mode`;
    }
    return null;
  }

  // MySQL
  const first = firstWord(tokens);
  if (!first || first.type !== 'word' || !MYSQL_ALLOWED_FIRST.has(first.value)) {
    return `"${first?.value ?? stmt.slice(0, 20)}" statements are not allowed in read-only mode`;
  }
  if (first.value === 'SET') {
    for (const w of words) {
      const v = w.value;
      if (['TRANSACTION', 'GLOBAL', 'PERSIST', 'PERSIST_ONLY', 'PASSWORD', 'ROLE', 'DEFAULT'].includes(v) ||
          /GLOBAL|READ_ONLY|TRANSACTION|SQL_LOG_BIN|AUTOCOMMIT/.test(v)) {
        return `"SET ${v}" is not allowed in read-only mode`;
      }
    }
    return null;
  }
  if (['SELECT', 'WITH', 'EXPLAIN', 'TABLE', 'VALUES'].includes(first.value)) {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'word' || !MYSQL_WRITE_WORDS.has(t.value)) continue;
      const nextTok = tokens[i + 1];
      if (nextTok && nextTok.type === 'punct' && nextTok.value === '(') continue; // REPLACE(), INSERT() functions
      const prev = tokens[i - 1];
      if (t.value === 'UPDATE' && prev && prev.value === 'FOR') continue; // SELECT ... FOR UPDATE
      return `"${t.value}" is not allowed in read-only mode`;
    }
  }
  return null;
}

/** Top-level (paren depth 0) word tokens. */
function topLevelWords(tokens: Token[]): Token[] {
  let depth = 0;
  const out: Token[] = [];
  for (const t of tokens) {
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    else if (depth === 0 && t.type === 'word') out.push(t);
  }
  return out;
}

/** True if this MySQL statement is a plain SELECT that we may append "LIMIT n" to. */
export function needsAutoLimit(stmt: string): boolean {
  const tokens = tokenize(stmt, 'mysql');
  const first = firstWord(tokens);
  if (!first || (first.value !== 'SELECT' && first.value !== 'WITH')) return false;
  const top = topLevelWords(tokens).map((t) => t.value);
  if (top.includes('LIMIT') || top.includes('INTO') || top.includes('FOR') || top.includes('LOCK')) return false;
  if (first.value === 'WITH' && top.some((w) => ['UPDATE', 'DELETE', 'INSERT', 'REPLACE'].includes(w))) return false;
  if (!top.includes('SELECT') && !(tokens[0]?.value === '(')) return false;
  return true;
}

/** Appends " LIMIT n" after the last real token (so a trailing "-- comment" does not swallow it). */
export function applyMysqlLimit(stmt: string, limit: number): { sql: string; applied: boolean } {
  if (limit <= 0 || !needsAutoLimit(stmt)) return { sql: stmt, applied: false };
  const tokens = tokenize(stmt, 'mysql');
  const last = tokens[tokens.length - 1];
  return { sql: stmt.slice(0, last.end) + ` LIMIT ${limit}` + stmt.slice(last.end), applied: true };
}

/**
 * SQL Server has no LIMIT, so for pure read batches without TOP we prefix "SET ROWCOUNT n;".
 * Always prefixing "SET ROWCOUNT 0;" otherwise keeps the connection from carrying over an old cap.
 * Kept on the same line so error line numbers still match the editor.
 */
export function applyMssqlRowcount(batch: string, limit: number): { sql: string; applied: boolean } {
  const tokens = tokenize(batch, 'mssql');
  const words = tokens.filter((t) => t.type === 'word').map((t) => t.value);
  const isPureRead = checkReadOnly(batch, 'mssql') === null;
  const apply = limit > 0 && isPureRead && words.includes('SELECT') && !words.includes('TOP');
  return { sql: `SET ROWCOUNT ${apply ? limit : 0}; ${batch}`, applied: apply };
}
