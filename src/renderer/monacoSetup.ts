// Monaco editor: lean feature set, SQL/MySQL highlighting and table/column autocomplete.

import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/features/register.all.js'; // all editor features (find, suggest, folding, …), no extra languages
// Core contributions that editor.main.js adds on top of register.all (suggest widget, core commands, …):
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js';
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/common/standaloneStrings.js';
import 'monaco-editor/languages/definitions/mysql/register.js';
import 'monaco-editor/languages/definitions/sql/register.js';
import { format as formatSqlText } from 'sql-formatter';
import { jsonError, looksLikeJson, minifyJson, prettyJson } from '../shared/jsonFormat';
import { metaCache } from './metaCache';
import { baseName, isTablePosition, joinOnTarget, makeAlias, parseTableRefs, statementAt, suggestJoinConditions, type TableRef } from '../shared/sqlAssist';
import type { DbType, TableInfo } from '../shared/types';
import { clauseAt, functionsFor, learnedJoinConditions, lintSql, preferredFunctionKinds, selectItems, smartStatements, bareStarFixes, snippetsFor, withSemicolons, type Clause } from '../shared/sqlSmart';
import { rankKey, smart, usageFor } from './smart';

(self as any).MonacoEnvironment = {
  getWorker: () => new Worker('app://local/editor.worker.js'),
};

monaco.editor.defineTheme('litesql-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#1e1f22' },
});

/** Which connection / database each editor model belongs to (used by autocomplete). */
export interface EditorContext {
  connectionId: string;
  type: DbType;
  getDatabase: () => string;
}
const contexts = new Map<string, EditorContext>();

export function registerEditorContext(model: monaco.editor.ITextModel, ctx: EditorContext) {
  contexts.set(model.uri.toString(), ctx);
  model.onWillDispose(() => contexts.delete(model.uri.toString()));
}

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'BETWEEN', 'EXISTS',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'ON', 'AS', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'UNION', 'UNION ALL',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE',
  'SHOW TABLES', 'SHOW CREATE TABLE', 'DESCRIBE', 'EXPLAIN', 'WITH', 'TOP', 'ASC', 'DESC', 'NULL', 'COALESCE',
  'IFNULL', 'NOW()', 'CURDATE()', 'DATE_FORMAT', 'CAST', 'CONVERT', 'USE',
];

/** Keywords that usually come next in each clause (shown before the other keywords). */
const NEXT_KEYWORDS: Partial<Record<Clause, string[]>> = {
  start: ['SELECT', 'WITH', 'UPDATE', 'DELETE FROM', 'INSERT INTO', 'SHOW TABLES', 'DESCRIBE', 'EXPLAIN', 'USE'],
  select: ['DISTINCT', 'FROM', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'],
  from: ['WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'LIMIT'],
  on: ['AND', 'OR', 'WHERE', 'JOIN', 'LEFT JOIN'],
  where: ['AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'EXISTS', 'GROUP BY', 'ORDER BY', 'LIMIT'],
  groupBy: ['HAVING', 'ORDER BY', 'LIMIT', 'WITH ROLLUP'],
  having: ['AND', 'OR', 'ORDER BY', 'LIMIT'],
  orderBy: ['DESC', 'ASC', 'LIMIT', 'OFFSET'],
  set: ['WHERE', 'NULL'],
};

/** Shown as functions (with hints) instead of plain keywords when functions are on. */
const FUNCTION_KEYWORDS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'IFNULL', 'DATE_FORMAT', 'CAST']);

const unquote = (s: string) => s.replace(/^[`\["]|[`\]"]$/g, '');

const provider: monaco.languages.CompletionItemProvider = {
  triggerCharacters: ['.', ' '],
  async provideCompletionItems(model, position, context) {
    const ctx = contexts.get(model.uri.toString());
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    const K = monaco.languages.CompletionItemKind;
    const SNIPPET = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    const suggestions: monaco.languages.CompletionItem[] = [];
    if (!ctx) return { suggestions };
    const on = smart();

    const db = ctx.getDatabase();
    const lineBefore = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, word.startColumn));
    // Only the statement under the cursor counts (other queries in the tab must not affect aliases/columns).
    const full = model.getValue();
    const wordStart = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn });
    const stmt = statementAt(full, wordStart);
    const stmtText = full.slice(stmt.start, stmt.end);
    const textBefore = full.slice(stmt.start, wordStart);
    // A space only opens suggestions at natural points (after FROM / JOIN / ON, and with clause-aware
    // suggestions also after SELECT / WHERE / AND / BY …), not while typing normally.
    if (context.triggerCharacter === ' ') {
      const opens = on.clauseAware ? /\b(FROM|JOIN|ON|SELECT|WHERE|AND|OR|BY|HAVING|SET)\s$/i : /\b(FROM|JOIN|ON)\s$/i;
      if (!opens.test(textBefore) && !/,\s$/.test(textBefore)) return { suggestions };
    }
    const clause: Clause = on.clauseAware ? clauseAt(textBefore) : 'other';
    const dotMatch = lineBefore.match(/([`\["]?[\w$]+[`\]"]?)\.$/);
    const refs = parseTableRefs(stmtText, db, ctx.type);
    const byName = new Map<string, TableRef>();
    for (const r of refs) {
      byName.set(baseName(r.table).toLowerCase(), r);
      byName.set(r.qualifier.toLowerCase(), r);
    }
    const stats = await usageFor(ctx.connectionId, db, ctx.type).catch(() => null);
    const colRank = (table: string, col: string) => rankKey(stats?.columns.get((baseName(table) + '.' + col).toLowerCase()));
    const tableRank = (d: string, t: string) => rankKey(stats?.tables.get((d + '.' + baseName(t)).toLowerCase()));
    const used = (d: string, t: string) => stats?.tables.get((d + '.' + baseName(t)).toLowerCase());

    try {
      // ---- "x." → columns of the table behind alias x (or tables of database x) ----
      if (dotMatch) {
        const qualifier = unquote(dotMatch[1]);
        const ref = byName.get(qualifier.toLowerCase());
        if (ref) {
          for (const c of await metaCache.columns(ctx.connectionId, ref.db, ref.table)) {
            suggestions.push({ label: c.name, kind: K.Field, detail: c.type, insertText: c.name, range, sortText: '0' + colRank(ref.table, c.name) + c.name });
          }
          return { suggestions };
        }
        const dbs = metaCache.peekDatabases(ctx.connectionId) ?? [];
        if (dbs.some((d) => d.toLowerCase() === qualifier.toLowerCase())) {
          const taken = refs.map((r) => r.qualifier);
          for (const t of await metaCache.tables(ctx.connectionId, qualifier)) {
            const alias = isTablePosition(textBefore.slice(0, -(qualifier.length + 1))) ? makeAlias(t.name, taken) : '';
            suggestions.push({ label: t.name, kind: K.Struct, detail: alias ? 'alias ' + alias : undefined, insertText: alias ? t.name + ' ' + alias : t.name, range, sortText: tableRank(qualifier, t.name) + t.name });
          }
          return { suggestions };
        }
        if (ctx.type === 'mssql' && db) {
          for (const t of await metaCache.tables(ctx.connectionId, db)) {
            if (t.name.toLowerCase().startsWith(qualifier.toLowerCase() + '.')) {
              const name = t.name.slice(qualifier.length + 1);
              suggestions.push({ label: name, kind: K.Struct, insertText: name, range, sortText: tableRank(db, t.name) + name });
            }
          }
        }
        return { suggestions };
      }

      // ---- after FROM / JOIN / comma: table names, inserted WITH an alias ("loan_accounts la") ----
      if (isTablePosition(textBefore)) {
        const taken = refs.map((r) => r.qualifier);
        const tableItem = (d: string, t: TableInfo, label: string, group: string): monaco.languages.CompletionItem => {
          const alias = makeAlias(t.name, taken);
          const n = used(d, t.name);
          return {
            label: { label, description: alias },
            kind: t.kind === 'view' ? K.Interface : K.Struct,
            detail: (t.kind === 'view' ? 'view' : 'table') + ' · alias ' + alias + (n ? ` · used ${n}×` : '') + (t.rows ? ` · ~${t.rows.toLocaleString()} rows` : ''),
            insertText: label + ' ' + alias,
            filterText: label === t.name ? t.name : label + ' ' + t.name,
            range,
            sortText: group + tableRank(d, t.name) + label,
          };
        };
        if (db) for (const t of await metaCache.tables(ctx.connectionId, db)) suggestions.push(tableItem(db, t, t.name, '0'));
        const dbs = await metaCache.databases(ctx.connectionId).catch(() => metaCache.peekDatabases(ctx.connectionId) ?? []);
        if (!db) {
          // No database selected for this tab: offer every database's tables, fully named
          // ("utility_stagging.upload_batch ub"), so nothing has to be run or selected first.
          await metaCache.allTables(ctx.connectionId).catch(() => {});
          for (const d of dbs) for (const t of metaCache.peekTables(ctx.connectionId, d) ?? []) suggestions.push(tableItem(d, t, d + '.' + t.name, '1'));
        }
        for (const d of dbs) suggestions.push({ label: d, kind: K.Module, detail: 'database', insertText: d, range, sortText: '0' + d });
        if (on.snippets) pushSnippets(suggestions, ctx.type, 'from', range, SNIPPET);
        return { suggestions };
      }

      // ---- "JOIN t x ON " → join conditions: the user's own (learned), foreign keys, naming conventions ----
      const before = parseTableRefs(textBefore, db, ctx.type);
      const ti = joinOnTarget(textBefore, before);
      if (ti >= 0) {
        const target = before[ti];
        const earlier = before.filter((r, i) => i !== ti && r.index < target.index);
        const learned = stats ? learnedJoinConditions(stats, target, earlier) : [];
        const colsOf = (r: TableRef) => metaCache.columns(ctx.connectionId, r.db, r.table).catch(() => []);
        const [targetCols, ...otherCols] = await Promise.all([colsOf(target), ...earlier.map(colsOf)]);
        const fkLists = await Promise.all([target, ...earlier].map((r) => metaCache.foreignKeys(ctx.connectionId, r.db, r.table).catch(() => [])));
        const conds = suggestJoinConditions(target, targetCols, earlier.map((ref, i) => ({ ref, cols: otherCols[i] })), fkLists.flat());
        const seenCond = new Set<string>();
        learned.forEach((l, i) => {
          seenCond.add(l.cond.toLowerCase());
          suggestions.push({ label: { label: l.cond, description: `you used this ${l.count}×` }, kind: K.Reference, detail: 'join from your history',
            insertText: l.cond, range, sortText: '000' + String(i).padStart(3, '0') });
        });
        conds.forEach((cond, i) => {
          if (seenCond.has(cond.toLowerCase())) return;
          suggestions.push({ label: cond, kind: K.Reference, detail: 'join condition', insertText: cond, range, sortText: '001' + String(i).padStart(3, '0') });
        });
      }

      // ---- clause helpers: GROUP BY all non-aggregated columns, ORDER BY select aliases ----
      if (clause === 'groupBy' && /\bBY\s+$/i.test(textBefore)) {
        const items = selectItems(stmtText).filter((s) => !s.aggregated && s.expr !== '*');
        if (items.length > 1) {
          const text = items.map((s) => s.expr).join(', ');
          suggestions.push({ label: { label: text, description: 'all non-aggregated columns' }, kind: K.Snippet, detail: 'GROUP BY every column that is not COUNT/SUM/…',
            insertText: text, filterText: items[0].expr, range, sortText: '0000' });
        }
      }
      if (clause === 'orderBy' || clause === 'groupBy' || clause === 'having') {
        for (const s of selectItems(stmtText)) {
          if (!s.alias) continue;
          suggestions.push({ label: { label: s.alias, description: s.expr.length > 40 ? s.expr.slice(0, 40) + '…' : s.expr }, kind: K.Variable, detail: 'alias from the SELECT list',
            insertText: clause === 'orderBy' && s.aggregated ? s.alias + ' DESC' : s.alias, filterText: s.alias, range, sortText: '0001' + s.alias });
        }
      }

      // ---- columns: "alias.column" when several tables are used, plus plain names ----
      const distinct = [...new Map(refs.map((r) => [r.qualifier.toLowerCase(), r])).values()];
      const seen = new Set<string>();
      const colGroup = clause === 'start' ? '3' : '0'; // columns first where columns are expected
      for (const ref of distinct) {
        const cols = await metaCache.columns(ctx.connectionId, ref.db, ref.table).catch(() => []);
        for (const c of cols) {
          const rank = colRank(ref.table, c.name);
          if (distinct.length > 1 || ref.alias) {
            suggestions.push({
              label: ref.qualifier + '.' + c.name, kind: K.Field, detail: baseName(ref.table) + ' · ' + c.type,
              insertText: ref.qualifier + '.' + c.name, filterText: c.name + ' ' + ref.qualifier + '.' + c.name, range, sortText: colGroup + 'a' + rank + c.name,
            });
          }
          if (seen.has(c.name)) continue;
          seen.add(c.name);
          suggestions.push({ label: c.name, kind: K.Field, detail: baseName(ref.table) + ' · ' + c.type, insertText: c.name, range, sortText: colGroup + 'b' + rank + c.name });
        }
      }
      if (clause === 'select' && refs.length) {
        suggestions.push({ label: '*', kind: K.Operator, detail: 'all columns', insertText: '*', range, sortText: '0c' });
      }
      if (db) {
        for (const t of metaCache.peekTables(ctx.connectionId, db) ?? []) {
          suggestions.push({ label: t.name, kind: t.kind === 'view' ? K.Interface : K.Struct, detail: t.kind, insertText: t.name, range, sortText: '5' + tableRank(db, t.name) + t.name });
        }
      }
      for (const d of metaCache.peekDatabases(ctx.connectionId) ?? []) {
        suggestions.push({ label: d, kind: K.Module, detail: 'database', insertText: d, range, sortText: '6' + d });
      }
    } catch {
      /* metadata unavailable: fall back to keywords */
    }

    // ---- functions with usage hints (the kinds that fit the clause first) ----
    if (on.functions && clause !== 'start' && clause !== 'from' && clause !== 'limit') {
      const pref = preferredFunctionKinds(clause);
      for (const f of functionsFor(ctx.type)) {
        const p = pref.indexOf(f.kind);
        suggestions.push({
          label: { label: f.name, detail: '()', description: f.kind },
          kind: K.Function,
          detail: f.sig,
          documentation: { value: '`' + f.sig + '`\n\n' + f.doc },
          insertText: f.snippet,
          insertTextRules: SNIPPET,
          filterText: f.name,
          range,
          sortText: (p >= 0 ? '1' + p : '4') + f.name,
        });
      }
    }
    if (on.snippets) pushSnippets(suggestions, ctx.type, clause === 'other' ? 'start' : clause, range, SNIPPET);

    const next = new Set(NEXT_KEYWORDS[clause] ?? []);
    for (const k of KEYWORDS) {
      if (on.functions && FUNCTION_KEYWORDS.has(k)) continue;
      suggestions.push({ label: k, kind: K.Keyword, insertText: k, range, sortText: (next.has(k) ? '2' : '7') + k });
    }
    for (const k of next) if (!KEYWORDS.includes(k)) suggestions.push({ label: k, kind: K.Keyword, insertText: k, range, sortText: '2' + k });
    return { suggestions };
  },
};

function pushSnippets(out: monaco.languages.CompletionItem[], type: DbType, clause: Clause, range: monaco.IRange,
  rule: monaco.languages.CompletionItemInsertTextRule) {
  const top = clause === 'start';
  for (const s of snippetsFor(type)) {
    if (!s.clauses.includes(clause)) continue;
    out.push({
      label: { label: s.prefix, description: s.label },
      kind: monaco.languages.CompletionItemKind.Snippet,
      detail: s.doc,
      documentation: { value: '```sql\n' + s.body.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}/g, '') + '\n```' },
      insertText: s.body,
      insertTextRules: rule,
      filterText: s.prefix,
      range,
      sortText: (top ? '0' : '3') + 's' + s.prefix,
    });
  }
}

monaco.languages.registerCompletionItemProvider('mysql', provider);
monaco.languages.registerCompletionItemProvider('sql', provider);

// ---------- safety hints: squiggles for UPDATE/DELETE without WHERE, JOIN without ON, SELECT * on big tables ----------
const BIG_TABLE_ROWS = 1_000_000;

export function updateHints(model: monaco.editor.ITextModel) {
  const ctx = contexts.get(model.uri.toString());
  const markers: monaco.editor.IMarkerData[] = [];
  if (ctx) markers.push(...missingSemicolonMarkers(model, ctx.type), ...bareStarMarkers(model, ctx.type));
  if (!ctx || !smart().safety) { monaco.editor.setModelMarkers(model, 'rowlight-hints', markers); return; }
  const db = ctx.getDatabase();
  for (const h of lintSql(model.getValue(), db, ctx.type)) {
    let message = h.message;
    let severity = monaco.MarkerSeverity.Warning;
    if (h.kind === 'selectStar') {
      const big = (h.refs ?? []).map((r) => ({ r, rows: metaCache.peekTables(ctx.connectionId, r.db)?.find((t) => t.name.toLowerCase() === r.table.toLowerCase())?.rows ?? 0 }))
        .filter((x) => x.rows >= BIG_TABLE_ROWS);
      if (!big.length) continue;
      message = big.map((x) => `${baseName(x.r.table)} has ~${x.rows.toLocaleString()} rows`).join(', ') +
        '. SELECT * without WHERE reads every column; with ORDER BY / GROUP BY it scans the whole table. List the columns you need and add a WHERE.';
      severity = monaco.MarkerSeverity.Info;
    }
    const s = model.getPositionAt(h.start);
    const e = model.getPositionAt(h.end);
    markers.push({ severity, message, startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column, source: 'Rowlight' });
  }
  monaco.editor.setModelMarkers(model, 'rowlight-hints', markers);
}

// ---------- statements without ";" (MySQL): a hint on the last word, with an "Add ;" quick fix ----------
const MISSING_SEMI = 'missingSemicolon';

function missingSemicolonMarkers(model: monaco.editor.ITextModel, type: DbType): monaco.editor.IMarkerData[] {
  if (type !== 'mysql') return []; // SQL Server does not need ";" between statements
  const text = model.getValue();
  const on = smart().blankLineSplit;
  return smartStatements(text, { blankLines: true, dialect: 'mysql' }).filter((r) => r.noSemicolon).map((r) => {
    const word = /\S+$/.exec(text.slice(r.start, r.end))![0];
    const a = model.getPositionAt(r.end - word.length);
    const b = model.getPositionAt(r.end);
    return {
      severity: on ? monaco.MarkerSeverity.Hint : monaco.MarkerSeverity.Warning,
      message: on
        ? 'No ";" here. The blank line ends the statement, so it runs on its own. Ctrl+. adds the ";".'
        : 'No ";" before the next statement: both are sent as one statement and fail. Ctrl+. adds the ";".',
      code: MISSING_SEMI, source: 'Rowlight',
      startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column,
    };
  });
}

// ---------- "a, b, *" (MySQL rejects it): a hint on the "*", with a "Use lads.*" quick fix ----------
const BARE_STAR = 'bareStar';

function bareStarMarkers(model: monaco.editor.ITextModel, type: DbType): monaco.editor.IMarkerData[] {
  if (type !== 'mysql') return []; // SQL Server accepts "SELECT a, *"
  const on = smart().fixStar;
  return bareStarFixes(model.getValue()).map((f) => {
    const a = model.getPositionAt(f.start);
    return {
      severity: on ? monaco.MarkerSeverity.Hint : monaco.MarkerSeverity.Warning,
      message: on
        ? `MySQL needs ${f.replacement} here (a * after other columns is an error). Rowlight sends it as ${f.replacement}. Ctrl+. writes it in.`
        : `MySQL needs ${f.replacement} here: a * after other columns is a syntax error. Ctrl+. fixes it.`,
      code: BARE_STAR, source: 'Rowlight',
      startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: a.lineNumber, endColumn: a.column + 1,
    };
  });
}

for (const lang of ['mysql', 'sql']) {
  monaco.languages.registerCodeActionProvider(lang, {
    provideCodeActions(model, _range, context) {
      const stars = context.markers.filter((m) => m.code === BARE_STAR);
      if (stars.length) {
        const fixes = bareStarFixes(model.getValue());
        const actions: monaco.languages.CodeAction[] = [];
        for (const m of stars) {
          const f = fixes.find((x) => { const p = model.getPositionAt(x.start); return p.lineNumber === m.startLineNumber && p.column === m.startColumn; });
          if (!f) continue;
          actions.push({ title: `Use ${f.replacement}`, kind: 'quickfix', diagnostics: [m], isPreferred: true,
            edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(),
              textEdit: { range: new monaco.Range(m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn), text: f.replacement } }] } });
        }
        return { actions, dispose() {} };
      }
      const hits = context.markers.filter((m) => m.code === MISSING_SEMI);
      if (!hits.length) return { actions: [], dispose() {} };
      const all = monaco.editor.getModelMarkers({ resource: model.uri, owner: 'rowlight-hints' }).filter((m) => m.code === MISSING_SEMI);
      const edit = (ms: monaco.editor.IMarkerData[]) => ({
        edits: ms.map((m) => ({ resource: model.uri, versionId: model.getVersionId(),
          textEdit: { range: new monaco.Range(m.endLineNumber, m.endColumn, m.endLineNumber, m.endColumn), text: ';' } })),
      });
      const actions: monaco.languages.CodeAction[] = [{ title: 'Add ;', kind: 'quickfix', diagnostics: hits, edit: edit(hits), isPreferred: true }];
      if (all.length > 1) actions.push({ title: `Add all missing ; (${all.length})`, kind: 'quickfix', diagnostics: all, edit: edit(all) });
      return { actions, dispose() {} };
    },
  });
}

/** UPDATE / DELETE statements in the SQL that have no WHERE (asked about before running). */
export function statementsWithoutWhere(sql: string, type: DbType): string[] {
  return lintSql(sql, '', type).filter((h) => h.kind === 'noWhere').map((h) => h.message);
}

// ---------- SQL formatter (Ctrl+Shift+F, or "Format" button / right-click → Format Document) ----------
function formatSql(text: string, languageId: string): string {
  // Pasted JSON (e.g. a column value) is laid out as JSON, keeping every value exactly as written.
  if (looksLikeJson(text)) return prettyJson(text);
  // MySQL: add the missing ";" first, otherwise statements separated only by a blank line are merged into one.
  if (languageId === 'mysql' && smart().blankLineSplit) text = withSemicolons(text, smartStatements(text, { blankLines: true, dialect: 'mysql' }));
  return formatSqlText(text, {
    language: languageId === 'mysql' ? 'mysql' : 'transactsql',
    keywordCase: 'upper',
    tabWidth: 2,
    linesBetweenQueries: 1,
  });
}

for (const lang of ['mysql', 'sql']) {
  monaco.languages.registerDocumentFormattingEditProvider(lang, {
    provideDocumentFormattingEdits(model) {
      return [{ range: model.getFullModelRange(), text: formatSql(model.getValue(), model.getLanguageId()) }];
    },
  });
  monaco.languages.registerDocumentRangeFormattingEditProvider(lang, {
    provideDocumentRangeFormattingEdits(model, range) {
      return [{ range, text: formatSql(model.getValueInRange(range), model.getLanguageId()) }];
    },
  });
}

/** Formats the selection, or the whole script if nothing is selected. Returns an error message or null. */
export function formatEditor(editor: monaco.editor.IStandaloneCodeEditor): string | null {
  const model = editor.getModel();
  if (!model) return null;
  const sel = editor.getSelection();
  const range = sel && !sel.isEmpty() ? sel : model.getFullModelRange();
  try {
    const original = model.getValueInRange(range);
    const text = formatSql(original, model.getLanguageId());
    editor.pushUndoStop();
    editor.executeEdits('format', [{ range, text, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    if (looksLikeJson(original)) {
      const err = jsonError(original.trim());
      return err ? 'Formatted as JSON, but the JSON is not valid: ' + err : null;
    }
    return null;
  } catch (e) {
    return 'Could not format: ' + String((e as Error).message ?? e).split('\n')[0];
  }
}

/** Right-click → "JSON: one line": the selection (or everything) as compact JSON. */
export function minifyJsonInEditor(editor: monaco.editor.IStandaloneCodeEditor): string | null {
  const model = editor.getModel();
  if (!model) return null;
  const sel = editor.getSelection();
  const range = sel && !sel.isEmpty() ? sel : model.getFullModelRange();
  const original = model.getValueInRange(range);
  if (!looksLikeJson(original)) return 'This is not JSON (it should start with { or [).';
  editor.pushUndoStop();
  editor.executeEdits('minify', [{ range, text: minifyJson(original), forceMoveMarkers: true }]);
  editor.pushUndoStop();
  return null;
}

export { monaco };
