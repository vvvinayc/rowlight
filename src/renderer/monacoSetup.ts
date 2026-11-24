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
import { metaCache } from './metaCache';
import { baseName, isTablePosition, joinOnTarget, makeAlias, parseTableRefs, statementAt, suggestJoinConditions, type TableRef } from '../shared/sqlAssist';
import type { DbType } from '../shared/types';

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

const unquote = (s: string) => s.replace(/^[`\["]|[`\]"]$/g, '');

const provider: monaco.languages.CompletionItemProvider = {
  triggerCharacters: ['.', ' '],
  async provideCompletionItems(model, position, context) {
    const ctx = contexts.get(model.uri.toString());
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    const K = monaco.languages.CompletionItemKind;
    const suggestions: monaco.languages.CompletionItem[] = [];
    if (!ctx) return { suggestions };

    const db = ctx.getDatabase();
    const lineBefore = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, word.startColumn));
    // Only the statement under the cursor counts (other queries in the tab must not affect aliases/columns).
    const full = model.getValue();
    const wordStart = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn });
    const stmt = statementAt(full, wordStart);
    const textBefore = full.slice(stmt.start, wordStart);
    // A space only opens suggestions right after FROM / JOIN / ON (not while typing normally).
    if (context.triggerCharacter === ' ' && !/\b(FROM|JOIN|ON)\s$/i.test(textBefore) && !/,\s$/.test(textBefore)) return { suggestions };
    const dotMatch = lineBefore.match(/([`\["]?[\w$]+[`\]"]?)\.$/);
    const refs = parseTableRefs(full.slice(stmt.start, stmt.end), db, ctx.type);
    const byName = new Map<string, TableRef>();
    for (const r of refs) {
      byName.set(baseName(r.table).toLowerCase(), r);
      byName.set(r.qualifier.toLowerCase(), r);
    }

    try {
      // ---- "x." → columns of the table behind alias x (or tables of database x) ----
      if (dotMatch) {
        const qualifier = unquote(dotMatch[1]);
        const ref = byName.get(qualifier.toLowerCase());
        if (ref) {
          for (const c of await metaCache.columns(ctx.connectionId, ref.db, ref.table)) {
            suggestions.push({ label: c.name, kind: K.Field, detail: c.type, insertText: c.name, range, sortText: '0' });
          }
          return { suggestions };
        }
        const dbs = metaCache.peekDatabases(ctx.connectionId) ?? [];
        if (dbs.some((d) => d.toLowerCase() === qualifier.toLowerCase())) {
          const taken = refs.map((r) => r.qualifier);
          for (const t of await metaCache.tables(ctx.connectionId, qualifier)) {
            const alias = isTablePosition(textBefore.slice(0, -(qualifier.length + 1))) ? makeAlias(t.name, taken) : '';
            suggestions.push({ label: t.name, kind: K.Struct, detail: alias ? 'alias ' + alias : undefined, insertText: alias ? t.name + ' ' + alias : t.name, range });
          }
          return { suggestions };
        }
        if (ctx.type === 'mssql' && db) {
          for (const t of await metaCache.tables(ctx.connectionId, db)) {
            if (t.name.toLowerCase().startsWith(qualifier.toLowerCase() + '.')) {
              const name = t.name.slice(qualifier.length + 1);
              suggestions.push({ label: name, kind: K.Struct, insertText: name, range });
            }
          }
        }
        return { suggestions };
      }

      // ---- after FROM / JOIN / comma: table names, inserted WITH an alias ("loan_accounts la") ----
      if (isTablePosition(textBefore)) {
        const taken = refs.map((r) => r.qualifier);
        if (db) {
          for (const t of await metaCache.tables(ctx.connectionId, db)) {
            const alias = makeAlias(t.name, taken);
            suggestions.push({
              label: { label: t.name, description: alias },
              kind: t.kind === 'view' ? K.Interface : K.Struct,
              detail: (t.kind === 'view' ? 'view' : 'table') + ' · alias ' + alias,
              insertText: t.name + ' ' + alias,
              filterText: t.name,
              range,
              sortText: '0' + t.name,
            });
          }
        }
        for (const d of metaCache.peekDatabases(ctx.connectionId) ?? []) {
          suggestions.push({ label: d, kind: K.Module, detail: 'database', insertText: d, range, sortText: '3' + d });
        }
        return { suggestions };
      }

      // ---- "JOIN t x ON " → join conditions (foreign keys, then naming conventions) ----
      const before = parseTableRefs(textBefore, db, ctx.type);
      const ti = joinOnTarget(textBefore, before);
      if (ti >= 0) {
        const target = before[ti];
        const earlier = before.filter((r, i) => i !== ti && r.index < target.index);
        const colsOf = (r: TableRef) => metaCache.columns(ctx.connectionId, r.db, r.table).catch(() => []);
        const [targetCols, ...otherCols] = await Promise.all([colsOf(target), ...earlier.map(colsOf)]);
        const fkLists = await Promise.all([target, ...earlier].map((r) => metaCache.foreignKeys(ctx.connectionId, r.db, r.table).catch(() => [])));
        const conds = suggestJoinConditions(target, targetCols, earlier.map((ref, i) => ({ ref, cols: otherCols[i] })), fkLists.flat());
        conds.forEach((cond, i) => suggestions.push({
          label: cond, kind: K.Reference, detail: 'join condition', insertText: cond, range, sortText: '00' + String(i).padStart(3, '0'),
        }));
      }

      // ---- columns: "alias.column" when several tables are used, plus plain names ----
      const distinct = [...new Map(refs.map((r) => [r.qualifier.toLowerCase(), r])).values()];
      const seen = new Set<string>();
      for (const ref of distinct) {
        const cols = await metaCache.columns(ctx.connectionId, ref.db, ref.table).catch(() => []);
        for (const c of cols) {
          if (distinct.length > 1 || ref.alias) {
            suggestions.push({
              label: ref.qualifier + '.' + c.name, kind: K.Field, detail: baseName(ref.table) + ' · ' + c.type,
              insertText: ref.qualifier + '.' + c.name, filterText: c.name + ' ' + ref.qualifier + '.' + c.name, range, sortText: '0a' + c.name,
            });
          }
          if (seen.has(c.name)) continue;
          seen.add(c.name);
          suggestions.push({ label: c.name, kind: K.Field, detail: baseName(ref.table) + ' · ' + c.type, insertText: c.name, range, sortText: '0b' + c.name });
        }
      }
      if (db) {
        for (const t of metaCache.peekTables(ctx.connectionId, db) ?? []) {
          suggestions.push({ label: t.name, kind: t.kind === 'view' ? K.Interface : K.Struct, detail: t.kind, insertText: t.name, range, sortText: '1' + t.name });
        }
      }
      for (const d of metaCache.peekDatabases(ctx.connectionId) ?? []) {
        suggestions.push({ label: d, kind: K.Module, detail: 'database', insertText: d, range, sortText: '3' + d });
      }
    } catch {
      /* metadata unavailable: fall back to keywords */
    }
    for (const k of KEYWORDS) suggestions.push({ label: k, kind: K.Keyword, insertText: k, range, sortText: '2' + k });
    return { suggestions };
  },
};

monaco.languages.registerCompletionItemProvider('mysql', provider);
monaco.languages.registerCompletionItemProvider('sql', provider);

// ---------- SQL formatter (Ctrl+Shift+F, or "Format" button / right-click → Format Document) ----------
function formatSql(text: string, languageId: string): string {
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
    const text = formatSql(model.getValueInRange(range), model.getLanguageId());
    editor.pushUndoStop();
    editor.executeEdits('format', [{ range, text, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    return null;
  } catch (e) {
    return 'Could not format: ' + String((e as Error).message ?? e).split('\n')[0];
  }
}

export { monaco };
