// One query tab: Monaco editor + toolbar + results (one sub-tab per result set, plus Messages).

import React, { useEffect, useReducer, useRef, useState } from 'react';
import type { ConnectionConfig, QueryRunResult, ResultSet, SessionInfo } from '../../shared/types';
import { api, ApiError, errorText, unwrap } from '../api';
import { metaCache, subscribe as subscribeMeta } from '../metaCache';
import { ParamsDialog } from './ParamsDialog';
import { SaveQueryDialog } from './SavedQueries';
import { CompareView, ComparePicker, type CompareData } from './CompareView';
import { compareTables, isReadOnlyQuery } from '../../shared/compare';
import { findParams, fillParams } from '../../shared/sqlParams';
import { formatEditor, minifyJsonInEditor, monaco, registerEditorContext, statementsWithoutWhere, updateHints } from '../monacoSetup';
import { closestNames, fixBareStars, parseMissingName, replaceName, smartStatements, statementAt, withSemicolons, type MissingName } from '../../shared/sqlSmart';
import { parseTableRefs, baseName } from '../../shared/sqlAssist';
import { smart } from '../smart';
import { editorTheme } from '../theme';
import { connectionColor } from '../../shared/defaults';
import { ResultsGrid } from './ResultsGrid';
import { useRowEdits } from './useRowEdits';
import { ErrorBoundary } from './ErrorBoundary';

const NO_ROWS: unknown[][] = [];

type ResultLayout = 'tabs' | 'stacked';
const LAYOUT_KEY = 'litesql.resultLayout'; // remembered for all tabs
const EDITOR_H_KEY = 'rowlight.editorHeight';
const RESULTS_OPEN_KEY = 'rowlight.resultsOpen';

/** Height of one grid in the stacked layout: fits small results, caps big ones (they scroll inside). */
function stackedHeight(rows: number): number {
  const toolbarAndHeader = 34 + 2 * 24 + 26;
  return Math.min(420, Math.max(150, toolbarAndHeader + Math.max(rows, 1) * 24 + 18));
}

export interface TabState {
  id: string;
  connId: string;
  title: string;
  initialSql: string;
  /** Run the initial SQL as soon as the tab opens (used by double-click on a table). */
  autoRun?: boolean;
  /** .sql file this tab was opened from / saved to. */
  filePath?: string;
}

export interface EditorHandle {
  insert(text: string): void;
  focus(): void;
  getText(): string;
}

interface Props {
  tab: TabState;
  active: boolean;
  conn: ConnectionConfig;
  session?: SessionInfo;
  onNewTab(): void;
  /** Opens SQL in a new query tab of the same connection. */
  onOpenSql(sql: string): void;
  onToggleReadOnly(): void;
  onRegister(tabId: string, h: EditorHandle | null): void;
  onStatus(msg: string): void;
  onHistoryChanged(): void;
  onShare(): void;
  onTextChange(tabId: string, text: string): void;
  /** True while this connection is shared with Claude. */
  shared: boolean;
  /** All connections and the open sessions, for "⇄ Compare with …". */
  connections: ConnectionConfig[];
  sessions: Record<string, SessionInfo>;
  onConnect(id: string): Promise<void>;
}

const COMPARE_LAST_KEY = 'rowlight.compareLast';
function lastCompare(connId: string): string | undefined {
  try { return JSON.parse(localStorage.getItem(COMPARE_LAST_KEY) ?? '{}')[connId]; } catch { return undefined; }
}
function rememberCompare(connId: string, otherId: string) {
  try { const m = JSON.parse(localStorage.getItem(COMPARE_LAST_KEY) ?? '{}'); m[connId] = otherId; localStorage.setItem(COMPARE_LAST_KEY, JSON.stringify(m)); } catch { /* not important */ }
}

type RunMode = 'cursor' | 'script';

/** Briefly highlights what Ctrl+Enter is about to run, so it is clear which statement ran. */
function flashRange(editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel, start: number, end: number) {
  const a = model.getPositionAt(start);
  const b = model.getPositionAt(end);
  const deco = editor.createDecorationsCollection([{ range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), options: { className: 'run-flash', isWholeLine: false } }]);
  setTimeout(() => deco.clear(), 700);
}

export function QueryTab({ tab, active, conn, session, onNewTab, onOpenSql, onToggleReadOnly, onRegister, onStatus, onHistoryChanged, onShare, shared, onTextChange, connections, sessions, onConnect }: Props) {
  const textChangeRef = useRef(onTextChange);
  textChangeRef.current = onTextChange;
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [db, setDb] = useState(session?.currentDatabase ?? conn.database);
  const dbRef = useRef(db);
  dbRef.current = db;
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paramAsk, setParamAsk] = useState<{ names: string[]; resolve(v: Record<string, string> | null): void } | null>(null);
  const [saving2, setSavingQuery] = useState<string | null>(null);
  /** The selection, else the statement under the cursor, else the whole script. */
  const queryForSave = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return '';
    const sel = editor.getSelection();
    if (sel && !sel.isEmpty()) return model.getValueInRange(sel);
    const text = model.getValue();
    const r = statementAt(smartStatements(text, { blankLines: smart().blankLineSplit, dialect: conn.type }), model.getOffsetAt(editor.getPosition() ?? { lineNumber: 1, column: 1 }));
    return r ? text.slice(r.start, r.end) : text;
  };
  const saveQueryRef = useRef<() => void>(() => {});
  saveQueryRef.current = () => {
    const sql = queryForSave();
    if (!sql.trim()) { onStatus('Nothing to save: write a query first'); return; }
    setSavingQuery(sql);
  };
  const askParams = (names: string[]) => new Promise<Record<string, string> | null>((resolve) => setParamAsk({ names, resolve }));
  /** "Did you mean …?" for an unknown column / table in the last error. */
  const [fix, setFix] = useState<{ missing: MissingName; options: string[]; sql: string } | null>(null);
  const [view, setView] = useState<number | 'messages' | 'compare'>(0);
  const [compare, setCompare] = useState<CompareData | null>(null);
  const [picker, setPicker] = useState(false);
  const compareSessions = useRef(new Set<string>());
  useEffect(() => () => { for (const id of compareSessions.current) api.query.closeTab(id, tab.id + '~cmp'); }, [tab.id]);
  // Editor height (the divider) and whether the results panel is open are remembered across tabs and restarts.
  const [editorH, setEditorHState] = useState(() => {
    try { const v = Number(localStorage.getItem(EDITOR_H_KEY)); return v >= 80 ? v : 260; } catch { return 260; }
  });
  const setEditorH = (h: number) => { setEditorHState(h); try { localStorage.setItem(EDITOR_H_KEY, String(h)); } catch { /* ignore */ } };
  const [resultsOpen, setResultsOpenState] = useState(() => {
    try { return localStorage.getItem(RESULTS_OPEN_KEY) !== '0'; } catch { return true; }
  });
  const setResultsOpen = (open: boolean) => { setResultsOpenState(open); try { localStorage.setItem(RESULTS_OPEN_KEY, open ? '1' : '0'); } catch { /* ignore */ } };
  const toggleResultsRef = useRef<() => void>(() => {});
  toggleResultsRef.current = () => setResultsOpen(!resultsOpen);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [layout, setLayout] = useState<ResultLayout>(() => {
    try { return localStorage.getItem(LAYOUT_KEY) === 'stacked' ? 'stacked' : 'tabs'; } catch { return 'tabs'; }
  });
  const runRef = useRef<(rerunSql?: string, mode?: RunMode) => void>(() => {});
  const doFormatRef = useRef<() => void>(() => {});
  const newTabRef = useRef(onNewTab);
  newTabRef.current = onNewTab;
  const connected = !!session;

  // The DB dropdown lists the server's databases: load them as soon as the connection is open and
  // re-render when the list arrives (before, it only appeared after the first query).
  const [, metaChanged] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeMeta(metaChanged), []);
  useEffect(() => {
    if (session) metaCache.databases(conn.id).catch(() => {});
  }, [session, conn.id]);
  const lastSql = useRef('');

  // ---------- load more (results cut by the auto-LIMIT) ----------
  const [paging, setPaging] = useState<Record<number, { hasMore: boolean; loading: boolean }>>({});
  useEffect(() => {
    setPaging(Object.fromEntries((result?.results ?? []).map((rs, i) => [i, { hasMore: rs.limitApplied && !!rs.pageLimit && !!rs.sql, loading: false }])));
  }, [result]);
  async function loadMore(i: number) {
    const rs = result?.results[i];
    const pg = paging[i];
    if (!rs || !rs.sql || !rs.pageLimit || !pg?.hasMore || pg.loading || running) return;
    setPaging((p) => ({ ...p, [i]: { ...p[i], loading: true } }));
    try {
      const r = await unwrap(api.query.fetchMore(conn.id, tab.id, rs.sql, rs.setIndex ?? 0, rs.rows.length, rs.pageLimit));
      // Same result object (so the grid keeps sort / filters / scroll), new rows array (so React re-renders).
      rs.rows = rs.rows.concat(r.rows);
      setPaging((p) => ({ ...p, [i]: { hasMore: r.hasMore, loading: false } }));
      onStatus(r.rows.length ? `Loaded ${r.rows.length.toLocaleString()} more rows (${rs.rows.length.toLocaleString()} in total)` : 'No more rows');
    } catch (e) {
      setError(errorText(e));
      setPaging((p) => ({ ...p, [i]: { hasMore: false, loading: false } }));
    }
  }

  const [saving, setSaving] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [sqlPreview, setSqlPreview] = useState<string[]>([]);

  // Inline editing works on a single result set that maps to one table with a primary key.
  const single = result && result.results.length === 1 ? result.results[0] : undefined;
  const edits = useRowEdits(single?.rows ?? NO_ROWS, single?.edit);
  const pendingCount = edits.pending.length;
  useEffect(() => { edits.reset(); setShowSql(false); }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  // SQL preview for the pending-changes panel (built by the main process, values inlined).
  useEffect(() => {
    if (!showSql || !pendingCount) { setSqlPreview([]); return; }
    const cs = edits.changeSet();
    if (!cs) return;
    let alive = true;
    unwrap(api.edit.preview(conn.id, cs)).then((p) => alive && setSqlPreview(p)).catch((e) => alive && setSqlPreview(['-- ' + errorText(e)]));
    return () => { alive = false; };
  }, [showSql, edits.pending]); // eslint-disable-line react-hooks/exhaustive-deps

  // Create the editor once.
  useEffect(() => {
    const model = monaco.editor.createModel(tab.initialSql, conn.type === 'mysql' ? 'mysql' : 'sql');
    registerEditorContext(model, { connectionId: conn.id, type: conn.type, getDatabase: () => dbRef.current });
    const editor = monaco.editor.create(hostRef.current!, {
      model,
      theme: editorTheme(),
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      tabSize: 2,
      renderLineHighlight: 'line',
      suggest: { showWords: false },
      quickSuggestions: { other: true, comments: false, strings: false },
      // Like SSMS: Alt+drag selects a box (type once, every line gets it); Ctrl+Click adds another cursor.
      multiCursorModifier: 'ctrlCmd',
    });
    editorRef.current = editor;
    (hostRef.current as any).__editor = editor; // handy for debugging from DevTools
    // Ctrl+Enter is handled by a window listener below. editor.addCommand registers shortcuts globally, so with
    // several tabs open the most recently created editor received them and the visible tab did not run.
    // addAction is scoped to this editor instance.
    editor.addAction({ id: 'rowlight.format', label: 'Format SQL', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF], run: () => doFormatRef.current() });
    editor.addAction({ id: 'rowlight.saveQuery', label: '☆ Save this query (find it later with Ctrl+P)', contextMenuGroupId: '1_modification', contextMenuOrder: 1, run: () => saveQueryRef.current() });
    editor.addAction({ id: 'rowlight.compare', label: '⇄ Compare with another connection…', contextMenuGroupId: '1_modification', contextMenuOrder: 1.5, run: () => setPicker(true) });
    editor.addAction({ id: 'rowlight.jsonPretty', label: 'JSON: format (indent)', contextMenuGroupId: '1_modification', contextMenuOrder: 2, run: () => doFormatRef.current() });
    editor.addAction({ id: 'rowlight.jsonMinify', label: 'JSON: one line', contextMenuGroupId: '1_modification', contextMenuOrder: 3,
      run: () => { const err = minifyJsonInEditor(editor); if (err) setError(err); } });
    onRegister(tab.id, {
      insert(text) {
        const sel = editor.getSelection();
        if (sel) editor.executeEdits('insert', [{ range: sel, text, forceMoveMarkers: true }]);
        editor.focus();
      },
      focus: () => editor.focus(),
      getText: () => model.getValue(),
    });
    // Report edits (debounced) so open tabs can be restored after a restart and files show "unsaved".
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleHints = () => { clearTimeout(hintTimer); hintTimer = setTimeout(() => { if (!model.isDisposed()) updateHints(model); }, 500); };
    scheduleHints();
    const unsubMeta = subscribeMeta(scheduleHints);
    const sub = model.onDidChangeContent(() => {
      scheduleHints();
      clearTimeout(timer);
      timer = setTimeout(() => textChangeRef.current(tab.id, model.getValue()), 300);
    });
    editor.onDidDispose(() => { clearTimeout(timer); clearTimeout(hintTimer); unsubMeta(); sub.dispose(); });
    if (tab.autoRun) setTimeout(() => runRef.current(undefined, 'script'), 0);
    return () => {
      onRegister(tab.id, null);
      editor.dispose();
      model.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (active) setTimeout(() => editorRef.current?.focus(), 0);
  }, [active]);

  // Ctrl+R: hide / show the results panel (capture phase, so it also works while the editor has focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current || !e.ctrlKey || e.altKey) return;
      // Ctrl+Enter: run the visible tab, wherever the focus is (editor, results grid, DB list...), but not
      // behind an open dialog or while a grid cell is being edited. Ctrl+Shift+Enter: the whole script.
      if (e.key === 'Enter') {
        const t = e.target as HTMLElement | null;
        if (document.querySelector('.modal-backdrop') || t?.closest?.('.grid-cell.editing')) return;
        e.preventDefault(); e.stopPropagation();
        runRef.current(undefined, e.shiftKey ? 'script' : 'cursor');
        return;
      }
      if (e.shiftKey) return;
      if (e.key.toLowerCase() !== 'r') return;
      e.preventDefault(); e.stopPropagation();
      toggleResultsRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    if (session && !db && session.currentDatabase) setDb(session.currentDatabase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /**
   * Runs, in order of preference: `rerunSql`; the selection; with mode "cursor" (Ctrl+Enter) and the setting on,
   * the statement under the cursor; otherwise the whole script. Statements that end at a blank line get their
   * missing ";" (MySQL) so they run as separate statements.
   */
  async function run(rerunSql?: string, mode: RunMode = 'cursor') {
    const editor = editorRef.current;
    if (!editor || running) return;
    if (!connected) { setError('Not connected. Connect the connection in the sidebar first.'); return; }
    if (!rerunSql && pendingCount && !window.confirm(`Discard ${pendingCount} unsaved change(s) and run the query?`)) return;
    const model = editor.getModel()!;
    const sel = editor.getSelection();
    const split = (text: string) => smartStatements(text, { blankLines: smart().blankLineSplit, dialect: conn.type });
    let sql: string;
    if (rerunSql !== undefined) sql = rerunSql;
    else if (sel && !sel.isEmpty()) sql = model.getValueInRange(sel);
    else if (mode === 'cursor' && smart().runAtCursor) {
      const text = model.getValue();
      const r = statementAt(split(text), model.getOffsetAt(editor.getPosition() ?? { lineNumber: 1, column: 1 }));
      if (!r) return;
      sql = text.slice(r.start, r.end);
      flashRange(editor, model, r.start, r.end);
    } else sql = model.getValue();
    if (!sql.trim()) return;
    // "where loan_id = :loan": ask for the values first.
    if (smart().params) {
      const names = findParams(sql);
      if (names.length) {
        const values = await askParams(names);
        editor.focus();
        if (!values) return;
        sql = fillParams(sql, values);
      }
    }
    if (conn.type === 'mysql' && smart().blankLineSplit) sql = withSemicolons(sql, split(sql));
    // "a, b, *" is a syntax error in MySQL: send it as "a, b, lads.*"
    let starNote = '';
    if (conn.type === 'mysql' && smart().fixStar) {
      const r = fixBareStars(sql);
      if (r.fixes.length) { sql = r.sql; starNote = ` · * sent as ${r.fixes[0].replacement}`; }
    }
    if (!readOnly && smart().safety) {
      const risky = statementsWithoutWhere(sql, conn.type);
      if (risky.length && !window.confirm(risky[0] + '\n\nRun it anyway?')) return;
    }
    lastSql.current = sql;
    setResultsOpen(true); // running always shows the results
    setRunning(true);
    setError(null);
    setFix(null);
    try {
      const r = await unwrap(api.query.run(conn.id, tab.id, sql));
      setResult(r);
      if (r.currentDatabase) setDb(r.currentDatabase);
      const failed = r.messages.find((m) => m.error);
      if (failed?.error) { setError(failed.error.message); suggestFix(failed.error.message, failed.sql || sql); }
      setView(r.results.length && !failed ? 0 : 'messages');
      const rows = r.results.reduce((a, b) => a + b.rows.length, 0);
      onStatus((r.cancelled ? 'Query cancelled' : failed ? 'Query failed' : `${r.results.length ? rows.toLocaleString() + ' rows' : 'Done'} in ${fmtMs(r.totalMs)}`) + starNote);
      onHistoryChanged();
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.error.kind === 'not-connected') onStatus('Connection lost');
    } finally {
      setRunning(false);
    }
  }
  runRef.current = run;

  // ---------- ⇄ Compare with another connection ----------
  const partnerId = [conn.compareWith, lastCompare(conn.id)].find((id) => id && id !== conn.id && connections.some((c) => c.id === id && c.type === conn.type));
  const partner = connections.find((c) => c.id === partnerId);
  const runCompareRef = useRef<(otherId: string) => void>(() => {});
  runCompareRef.current = async (otherId: string) => {
    const other = connections.find((c) => c.id === otherId);
    if (!other || running) return;
    if (!connected) { setError('Not connected. Connect the connection in the sidebar first.'); return; }
    let sql = queryForSave().trim();
    if (!sql) { onStatus('Write a query first'); return; }
    const parts = smartStatements(sql, { blankLines: smart().blankLineSplit, dialect: conn.type }).filter((r) => sql.slice(r.start, r.end).trim());
    if (parts.length > 1) { setError('Compare runs one query at a time: put the cursor in one query, or select it.'); return; }
    sql = sql.replace(/;\s*$/, '');
    if (!isReadOnlyQuery(sql)) { setError('Compare only runs SELECT queries, so nothing is changed on either connection.'); return; }
    if (smart().params) {
      const names = findParams(sql);
      if (names.length) { const values = await askParams(names); if (!values) return; sql = fillParams(sql, values); }
    }
    if (conn.type === 'mysql' && smart().fixStar) sql = fixBareStars(sql).sql;
    rememberCompare(conn.id, otherId);
    if (!sessions[otherId]) { onStatus(`Connecting to ${other.name}…`); await onConnect(otherId); }
    compareSessions.current.add(otherId);
    const useDb = db ? (conn.type === 'mysql' ? 'USE `' + db.replace(/`/g, '``') + '`;\n' : 'USE [' + db.replace(/]/g, ']]') + '];\n') : '';
    const runOn = async (id: string, tabId: string, text: string): Promise<{ table?: { columns: string[]; rows: unknown[][] }; limited?: boolean; error?: string }> => {
      try {
        const r = await unwrap(api.query.run(id, tabId, text));
        const failed = r.messages.find((m) => m.error);
        if (failed?.error) return { error: failed.error.message };
        const rs = r.results[r.results.length - 1];
        if (!rs) return { error: 'The query returned no rows table.' };
        return { table: { columns: rs.columns, rows: rs.rows }, limited: !!rs.limitApplied };
      } catch (e) { return { error: errorText(e) }; }
    };
    setRunning(true); setError(null); setFix(null); setResultsOpen(true);
    const t0 = performance.now();
    try {
      const [ra, rb] = await Promise.all([runOn(conn.id, tab.id, sql), runOn(otherId, tab.id + '~cmp', useDb + sql)]);
      const data: CompareData = {
        aName: conn.name, bName: other.name, sql, a: ra.table ?? null, b: rb.table ?? null,
        aError: ra.error, bError: rb.error, limited: !!(ra.limited || rb.limited), ms: Math.round(performance.now() - t0),
      };
      setCompare(data);
      setView('compare');
      if (data.a && data.b) {
        const c = compareTables(data.a, data.b).counts;
        const n = c.changed + c.onlyA + c.onlyB;
        onStatus(n ? `⇄ ${other.name}: ${c.changed} different, ${c.onlyA} only in ${conn.name}, ${c.onlyB} only in ${other.name}` : `⇄ Same on ${conn.name} and ${other.name} (${c.same} rows)`);
      } else onStatus('Compare failed');
      onHistoryChanged();
    } finally {
      setRunning(false);
    }
  };
  doFormatRef.current = () => {
    if (!editorRef.current) return;
    const err = formatEditor(editorRef.current);
    if (err) setError(err);
  };

  async function saveChanges() {
    const cs = edits.changeSet();
    if (!cs || saving) return;
    setSaving(true);
    try {
      const n = await unwrap(api.edit.save(conn.id, tab.id, cs));
      onStatus(`Saved: ${n} row(s) changed`);
      edits.reset();
      onHistoryChanged();
      await run(lastSql.current); // reload so the grid shows what is really in the database
    } catch (e) {
      setError('Save failed, nothing was changed: ' + errorText(e));
    } finally {
      setSaving(false);
    }
  }

  /** Finds likely intended names for an "Unknown column / table" error (offline, from the metadata cache). */
  async function suggestFix(message: string, failedSql: string) {
    if (!smart().didYouMean) return;
    const missing = parseMissingName(message);
    if (!missing) return;
    try {
      const refs = parseTableRefs(failedSql, dbRef.current, conn.type);
      let candidates: string[] = [];
      if (missing.kind === 'column') {
        const q = missing.qualifier?.toLowerCase();
        const targets = q ? refs.filter((r) => r.qualifier.toLowerCase() === q || baseName(r.table).toLowerCase() === q) : refs;
        for (const r of targets.length ? targets : refs) candidates.push(...(await metaCache.columns(conn.id, r.db, r.table).catch(() => [])).map((c) => c.name));
      } else {
        const dbName = missing.qualifier && conn.type === 'mysql' ? missing.qualifier : dbRef.current;
        if (dbName) candidates = (await metaCache.tables(conn.id, dbName).catch(() => [])).map((t) => baseName(t.name));
      }
      const options = closestNames(missing.name, candidates);
      if (options.length) setFix({ missing, options, sql: failedSql });
    } catch { /* no suggestion */ }
  }

  /** Replaces the misspelled name in the editor (one undo step) and runs the query again. */
  function applyFix(name: string) {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !fix) return;
    const text = model.getValue();
    const at = text.indexOf(fix.sql);
    const next = at >= 0
      ? text.slice(0, at) + replaceName(fix.sql, fix.missing, name) + text.slice(at + fix.sql.length)
      : replaceName(text, fix.missing, name);
    editor.pushUndoStop();
    editor.executeEdits('did-you-mean', [{ range: model.getFullModelRange(), text: next }]);
    editor.pushUndoStop();
    setFix(null);
    setError(null);
    onStatus(`Replaced ${fix.missing.name} with ${name}`);
    const fixed = at >= 0 ? replaceName(fix.sql, fix.missing, name) : undefined;
    setTimeout(() => runRef.current(fixed, 'script'), 0);
  }

  const previewSql = (cs: import('../../shared/types').ChangeSet) => unwrap(api.edit.preview(conn.id, cs));

  async function cancel() {
    await api.query.cancel(conn.id, tab.id);
    onStatus('Cancelling…');
  }

  async function changeDb(next: string) {
    try {
      await unwrap(api.query.useDatabase(conn.id, tab.id, next));
      setDb(next);
      metaCache.tables(conn.id, next).catch(() => {});
    } catch (e) {
      setError(errorText(e));
    }
  }

  function startSplit(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorH;
    const move = (ev: MouseEvent) => setEditorH(Math.max(80, Math.min(window.innerHeight - 200, startH + ev.clientY - startY)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  const dbs = metaCache.peekDatabases(conn.id) ?? (db ? [db] : []);
  const readOnly = session?.readOnly ?? conn.readOnly;
  const current = typeof view === 'number' ? result?.results[view] : undefined;
  const stacked = layout === 'stacked';
  function changeLayout(l: ResultLayout) {
    setLayout(l);
    try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* ignore */ }
    if (l === 'tabs' && typeof view === 'number') setView(0);
  }
  const totalRows = result?.results.reduce((a, b) => a + b.rows.length, 0) ?? 0;

  return (
    <div className="query-tab" style={{ display: active ? 'flex' : 'none' }}>
      {saving2 !== null && <SaveQueryDialog sql={saving2} connName={conn.name} onStatus={onStatus} onClose={() => { setSavingQuery(null); editorRef.current?.focus(); }} />}
      {picker && <ComparePicker self={conn} connections={connections} connected={sessions}
        onClose={() => { setPicker(false); editorRef.current?.focus(); }}
        onPick={(id) => { setPicker(false); runCompareRef.current(id); }} />}
      {paramAsk && <ParamsDialog names={paramAsk.names} onDone={(v) => { paramAsk.resolve(v); setParamAsk(null); }} />}
      <div className={'toolbar' + (connectionColor(conn.color) ? ' colored' : '')}
        style={{ ['--conn-color' as string]: connectionColor(conn.color) } as React.CSSProperties}>
        <button className="primary" onClick={() => run()} disabled={running || !connected}
          title={smart().runAtCursor ? 'Run the selection, or the statement under the cursor (Ctrl+Enter)' : 'Run the selection, or the whole script (Ctrl+Enter)'}>▶ Run</button>
        {smart().runAtCursor && (
          <button onClick={() => run(undefined, 'script')} disabled={running || !connected} title="Run the whole script (Ctrl+Shift+Enter)">▶▶ Script</button>
        )}
        <button onClick={cancel} disabled={!running} title="Cancel the running query">■ Cancel</button>
        <button onClick={() => saveQueryRef.current()} title="Save the query under the cursor (or the selection) with a name. Ctrl+P finds it again.">☆ Save</button>
        {partner && (
          <span className="split-btn">
            <button onClick={() => runCompareRef.current(partner.id)} disabled={running || !connected}
              title={`Run the query under the cursor on ${conn.name} and ${partner.name} and show the differences (SELECT only)`}>⇄ Compare with {partner.name}</button>
            <button onClick={() => setPicker(true)} disabled={running || !connected} title="Compare with another connection…">▾</button>
          </span>
        )}
        <button onClick={() => doFormatRef.current()} title="Format the selection, or the whole script (Ctrl+Shift+F)">Format</button>
        <label className="db-select">DB
          <select value={db} onChange={(e) => changeDb(e.target.value)} disabled={!connected || running}
            // Opening the list loads it if it is missing (or failed before) - never just "(none)".
            onMouseDown={() => { if (connected && !metaCache.peekDatabases(conn.id)) metaCache.databases(conn.id, true).catch(() => {}); }}
            onFocus={() => { if (connected && !metaCache.peekDatabases(conn.id)) metaCache.databases(conn.id, true).catch(() => {}); }}
            title={metaCache.peekDbError(conn.id) ? 'Could not load databases: ' + metaCache.peekDbError(conn.id) : 'Database for this tab'}>
            {!db && <option value="">{connected && metaCache.isLoadingDatabases(conn.id) ? 'Loading databases…' : '(none)'}</option>}
            {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
            {connected && !metaCache.peekDatabases(conn.id) && metaCache.peekDbError(conn.id) && (
              <option value="" disabled>⚠ could not load databases (click again to retry)</option>
            )}
          </select>
        </label>
        <button className={'ro-toggle ' + (readOnly ? 'on' : 'off')} onClick={onToggleReadOnly}
          title={readOnly ? 'Read-only: writes and DDL are blocked. Click to allow writes.' : 'Writes allowed. Click to switch to read-only.'}>
          {readOnly ? '🔒 Read-only' : '⚠ Writes allowed'}
        </button>
        {running && <span className="spinner">Running…</span>}
        <span className="spacer" />
        <button className={'share-btn' + (shared ? ' on' : '')} onClick={onShare} disabled={!connected}
          title="Let Claude Code query this connection (read-only, local only)">✦ {shared ? 'Shared with Claude' : 'Share with Claude'}</button>
        <span className="muted small">{conn.name}{conn.ssh.enabled ? (conn.ssh.profileId ? ' via SSH profile' : ` via ${conn.ssh.host}`) : ''} · {connected ? 'connected' : 'disconnected'}</span>
      </div>
      <div className="editor-host" ref={hostRef} style={resultsOpen ? { height: editorH } : { flex: 1 }} />
      {resultsOpen && <div className="splitter" onMouseDown={startSplit} title="Drag to resize" />}
      <div className={'results' + (resultsOpen ? '' : ' collapsed')}>
        <div className="result-tabs">
          {stacked ? (
            !!result?.results.length && (
              <button className={view !== 'messages' ? 'active' : ''} onClick={() => setView(0)}>
                Results <span className="muted">({result.results.length})</span>
              </button>
            )
          ) : result?.results.map((rs, i) => (
            <button key={i} className={view === i ? 'active' : ''} onClick={() => setView(i)} title={rs.sql}>
              Result {i + 1} <span className="muted">({rs.rows.length.toLocaleString()}{rs.limitApplied && paging[i]?.hasMore !== false ? ', more available' : ''})</span>
            </button>
          ))}
          {compare && <button className={view === 'compare' ? 'active' : ''} onClick={() => setView('compare')} title={compare.sql}>⇄ Compare</button>}
          <button className={view === 'messages' ? 'active' : ''} onClick={() => setView('messages')}>Messages</button>
          <span className="spacer" />
          {result && (
            <span className="muted small">
              {result.cancelled ? 'Cancelled · ' : ''}{totalRows.toLocaleString()} rows · {fmtMs(result.totalMs)}
              {!stacked && current?.limitApplied ? ' · auto-LIMIT applied' : ''}
            </span>
          )}
          <button className="results-toggle" onClick={() => setResultsOpen(!resultsOpen)}
            title={resultsOpen ? 'Hide the results panel (Ctrl+R)' : 'Show the results panel (Ctrl+R)'}>{resultsOpen ? '▾ Hide' : '▴ Show'}</button>
          <span className="layout-switch" title="Show several results as tabs, or one below the other (like SSMS)">
            <button className={!stacked ? 'active' : ''} onClick={() => changeLayout('tabs')}>⧉ Tabs</button>
            <button className={stacked ? 'active' : ''} onClick={() => changeLayout('stacked')}>☰ Stacked</button>
          </span>
        </div>
        {resultsOpen && error && (
          <div className="error-banner">
            {error}
            {fix && (
              <div className="did-you-mean">
                Did you mean{' '}
                {fix.options.map((o, i) => (
                  <React.Fragment key={o}>{i > 0 && ' or '}
                    <button className="fix-btn" title={`Replace ${fix.missing.name} with ${o} and run again`} onClick={() => applyFix(o)}>{o}</button>
                  </React.Fragment>
                ))}?
                <span className="muted small"> (click to fix and run again)</span>
              </div>
            )}
          </div>
        )}
        <div className="result-body" style={resultsOpen ? undefined : { display: 'none' }}>
          <ErrorBoundary label="results grid" onReset={() => edits.reset()}>
          {view === 'compare' && compare ? (
            <CompareView key={compare.sql + compare.ms} data={compare} onStatus={onStatus} />
          ) : stacked && view !== 'messages' && result && result.results.length > 0 ? (
            <div className="stacked">
              {result.results.map((rs, i) => (
                <div key={i} className="stacked-item"
                  style={result.results.length === 1 ? { flex: 1 } : { height: stackedHeight(rs.rows.length) }}>
                  <div className="stacked-head">
                    <b>Result {i + 1}</b>
                    <span className="muted">{rs.rows.length.toLocaleString()} rows{rs.limitApplied ? ' · auto-LIMIT applied' : ''}</span>
                    {rs.sql && <code className="stacked-sql" title={rs.sql}>{rs.sql.replace(/\s+/g, ' ')}</code>}
                  </div>
                  <ResultsGrid
                    columns={rs.columns}
                    rows={rs === single ? edits.rows : rs.rows}
                    resetKey={rs}
                    exportName={`${conn.name}_${tab.title}_${i + 1}`}
                    onStatus={onStatus}
                    edit={rs === single ? edits.api : undefined}
                    canEdit={!readOnly}
                    editNote={editNote(rs, single, readOnly)}
                    hasMore={paging[i]?.hasMore}
                    loadingMore={paging[i]?.loading}
                    pageSize={rs.pageLimit}
                    onLoadMore={() => loadMore(i)}
                    onPreviewSql={previewSql}
                    onOpenSql={onOpenSql}
                  />
                </div>
              ))}
            </div>
          ) : current ? (
            <ResultsGrid
              columns={current.columns}
              rows={current === single ? edits.rows : current.rows}
              resetKey={current}
              exportName={`${conn.name}_${tab.title}`}
              onStatus={onStatus}
              edit={current === single ? edits.api : undefined}
              canEdit={!readOnly}
              editNote={editNote(current, single, readOnly)}
              hasMore={typeof view === 'number' ? paging[view]?.hasMore : false}
              loadingMore={typeof view === 'number' ? paging[view]?.loading : false}
              pageSize={current.pageLimit}
              onLoadMore={() => typeof view === 'number' && loadMore(view)}
              onPreviewSql={previewSql}
              onOpenSql={onOpenSql}
            />
          ) : view === 'messages' && result ? (
            <div className="messages">
              {result.messages.map((m, i) => (
                <div key={i} className={'message ' + (m.error ? 'err' : 'ok')}>
                  <div className="msg-head">
                    <span>{m.error ? '✖' : '✔'}</span>
                    <span>{fmtMs(m.durationMs)}</span>
                    {m.rowCount !== undefined && <span>{m.rowCount.toLocaleString()} rows</span>}
                    {m.affectedRows !== undefined && <span>{m.affectedRows.toLocaleString()} rows affected</span>}
                  </div>
                  <pre className="msg-sql">{m.sql.length > 800 ? m.sql.slice(0, 800) + '…' : m.sql}</pre>
                  {m.note && <div className="msg-note">{m.note}</div>}
                  {m.error && <div className="msg-err">{m.error.message}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div className="muted pad">
              Ctrl+Enter runs the selection (or the whole script). Ctrl+E opens a new tab.
              {readOnly ? ' Read-only mode: INSERT/UPDATE/DELETE/DDL are blocked.' : ''}
            </div>
          )}
          </ErrorBoundary>
        </div>
        {pendingCount > 0 && (
          <div className="pending">
            <div className="pending-head">
              <strong>{pendingCount} pending change{pendingCount === 1 ? '' : 's'}</strong>
              <span className="muted small">&nbsp;to {single?.edit?.database}.{single?.edit?.table}. Nothing is written until you click Save (one transaction).</span>
              <span className="spacer" />
              <button className="link" onClick={() => setShowSql((v) => !v)}>{showSql ? 'Hide SQL' : 'Show SQL'}</button>
              <button onClick={() => edits.reset()} disabled={saving}>Revert all</button>
              <button className="primary" onClick={saveChanges} disabled={saving || readOnly}
                title={readOnly ? 'Turn off Read-only to save' : 'Save all changes in one transaction'}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
            <div className="pending-list">
              {showSql
                ? <pre className="pending-sql">{sqlPreview.join('\n')}</pre>
                : edits.pending.map((p, i) => (
                  <div key={i} className={'pending-item ' + p.kind}>
                    <span className="kind">{p.kind.toUpperCase()}</span>
                    <span className="label">{p.label}</span>
                    <button className="link" onClick={() => edits.revert(p)} title="Revert this change">↺ revert</button>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function editNote(current: ResultSet, single: ResultSet | undefined, readOnly: boolean): string {
  if (current !== single) return 'Not editable: several result sets';
  if (!current.edit) return current.editBlocked ? 'Not editable: ' + current.editBlocked : '';
  if (readOnly) return 'Read-only: turn it off to edit';
  return `✎ Editable · ${current.edit.table} · double-click a cell`;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}
