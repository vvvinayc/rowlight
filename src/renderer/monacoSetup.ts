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

/** alias/table name (lower-case) -> { db, table } from FROM/JOIN clauses in the script. */
function referencedTables(text: string, defaultDb: string, type: DbType) {
  const map = new Map<string, { db: string; table: string }>();
  const ident = '[`\\["]?[\\w$]+[`\\]"]?';
  const re = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+((?:${ident}\\.){0,2}${ident})(?:\\s+(?:AS\\s+)?([\\w$]+))?`, 'gi');
  const reserved = /^(WHERE|ON|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|GROUP|ORDER|LIMIT|SET|VALUES|SELECT|UNION|HAVING|USING)$/i;
  for (const m of text.matchAll(re)) {
    const parts = m[1].split('.').map(unquote);
    let db = defaultDb;
    let table: string;
    if (type === 'mysql') {
      table = parts[parts.length - 1];
      if (parts.length > 1) db = parts[0];
    } else {
      // SQL Server: [db.]schema.table, tables are stored as "schema.table"
      if (parts.length === 3) { db = parts[0]; table = parts[1] + '.' + parts[2]; }
      else if (parts.length === 2) table = parts.join('.');
      else table = 'dbo.' + parts[0];
    }
    const entry = { db, table };
    map.set(parts[parts.length - 1].toLowerCase(), entry);
    if (m[2] && !reserved.test(m[2])) map.set(m[2].toLowerCase(), entry);
  }
  return map;
}

const provider: monaco.languages.CompletionItemProvider = {
  triggerCharacters: ['.'],
  async provideCompletionItems(model, position) {
    const ctx = contexts.get(model.uri.toString());
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    const K = monaco.languages.CompletionItemKind;
    const suggestions: monaco.languages.CompletionItem[] = [];
    if (!ctx) return { suggestions };

    const db = ctx.getDatabase();
    const before = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, word.startColumn));
    const dotMatch = before.match(/([`\["]?[\w$]+[`\]"]?)\.$/);
    const text = model.getValue();
    const refs = referencedTables(text, db, ctx.type);

    try {
      if (dotMatch) {
        const qualifier = unquote(dotMatch[1]);
        const ref = refs.get(qualifier.toLowerCase());
        if (ref) {
          for (const c of await metaCache.columns(ctx.connectionId, ref.db, ref.table)) {
            suggestions.push({ label: c.name, kind: K.Field, detail: c.type, insertText: c.name, range, sortText: '0' });
          }
          return { suggestions };
        }
        const dbs = metaCache.peekDatabases(ctx.connectionId) ?? [];
        if (dbs.some((d) => d.toLowerCase() === qualifier.toLowerCase())) {
          for (const t of await metaCache.tables(ctx.connectionId, qualifier)) {
            suggestions.push({ label: t.name, kind: K.Struct, insertText: t.name, range });
          }
          return { suggestions };
        }
        if (ctx.type === 'mssql' && db) {
          // schema prefix, e.g. "dbo."
          for (const t of await metaCache.tables(ctx.connectionId, db)) {
            if (t.name.toLowerCase().startsWith(qualifier.toLowerCase() + '.')) {
              const name = t.name.slice(qualifier.length + 1);
              suggestions.push({ label: name, kind: K.Struct, insertText: name, range });
            }
          }
          return { suggestions };
        }
        return { suggestions };
      }

      if (db) {
        for (const t of await metaCache.tables(ctx.connectionId, db)) {
          suggestions.push({ label: t.name, kind: t.kind === 'view' ? K.Interface : K.Struct, detail: t.kind, insertText: t.name, range, sortText: '1' + t.name });
        }
      }
      const seen = new Set<string>();
      for (const ref of new Set(refs.values())) {
        const cols = await metaCache.columns(ctx.connectionId, ref.db, ref.table).catch(() => []);
        for (const c of cols) {
          if (seen.has(c.name)) continue;
          seen.add(c.name);
          suggestions.push({ label: c.name, kind: K.Field, detail: `${ref.table} · ${c.type}`, insertText: c.name, range, sortText: '0' + c.name });
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
