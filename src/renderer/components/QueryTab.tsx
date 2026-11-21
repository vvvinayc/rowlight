// One query tab: Monaco editor + toolbar + results (one sub-tab per result set, plus Messages).

import React, { useEffect, useRef, useState } from 'react';
import type { ConnectionConfig, QueryRunResult, ResultSet, SessionInfo } from '../../shared/types';
import { api, ApiError, errorText, unwrap } from '../api';
import { metaCache } from '../metaCache';
import { formatEditor, monaco, registerEditorContext } from '../monacoSetup';
import { editorTheme } from '../theme';
import { connectionColor } from '../../shared/defaults';
import { ResultsGrid } from './ResultsGrid';
import { useRowEdits } from './useRowEdits';

const NO_ROWS: unknown[][] = [];

type ResultLayout = 'tabs' | 'stacked';
const LAYOUT_KEY = 'litesql.resultLayout'; // remembered for all tabs

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
  onToggleReadOnly(): void;
  onRegister(tabId: string, h: EditorHandle | null): void;
  onStatus(msg: string): void;
  onHistoryChanged(): void;
  onShare(): void;
  onTextChange(tabId: string, text: string): void;
  /** True while this connection is shared with Claude. */
  shared: boolean;
}

export function QueryTab({ tab, active, conn, session, onNewTab, onToggleReadOnly, onRegister, onStatus, onHistoryChanged, onShare, shared, onTextChange }: Props) {
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
  const [view, setView] = useState<number | 'messages'>(0);
  const [editorH, setEditorH] = useState(260);
  const [layout, setLayout] = useState<ResultLayout>(() => {
    try { return localStorage.getItem(LAYOUT_KEY) === 'stacked' ? 'stacked' : 'tabs'; } catch { return 'tabs'; }
  });
  const runRef = useRef<() => void>(() => {});
  const doFormatRef = useRef<() => void>(() => {});
  const newTabRef = useRef(onNewTab);
  newTabRef.current = onNewTab;
  const connected = !!session;
  const lastSql = useRef('');
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
    });
    editorRef.current = editor;
    (hostRef.current as any).__editor = editor; // handy for debugging from DevTools
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () => newTabRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => doFormatRef.current());
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
    const sub = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(() => textChangeRef.current(tab.id, model.getValue()), 300);
    });
    editor.onDidDispose(() => { clearTimeout(timer); sub.dispose(); });
    if (tab.autoRun) setTimeout(() => runRef.current(), 0);
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

  useEffect(() => {
    if (session && !db && session.currentDatabase) setDb(session.currentDatabase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  async function run(rerunSql?: string) {
    const editor = editorRef.current;
    if (!editor || running) return;
    if (!connected) { setError('Not connected. Connect the connection in the sidebar first.'); return; }
    if (!rerunSql && pendingCount && !window.confirm(`Discard ${pendingCount} unsaved change(s) and run the query?`)) return;
    const model = editor.getModel()!;
    const sel = editor.getSelection();
    const sql = rerunSql ?? (sel && !sel.isEmpty() ? model.getValueInRange(sel) : model.getValue());
    if (!sql.trim()) return;
    lastSql.current = sql;
    setRunning(true);
    setError(null);
    try {
      const r = await unwrap(api.query.run(conn.id, tab.id, sql));
      setResult(r);
      if (r.currentDatabase) setDb(r.currentDatabase);
      const failed = r.messages.find((m) => m.error);
      if (failed?.error) setError(failed.error.message);
      setView(r.results.length && !failed ? 0 : 'messages');
      const rows = r.results.reduce((a, b) => a + b.rows.length, 0);
      onStatus(r.cancelled ? 'Query cancelled' : failed ? 'Query failed' : `${r.results.length ? rows.toLocaleString() + ' rows' : 'Done'} in ${fmtMs(r.totalMs)}`);
      onHistoryChanged();
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.error.kind === 'not-connected') onStatus('Connection lost');
    } finally {
      setRunning(false);
    }
  }
  runRef.current = run;
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
    if (l === 'tabs' && view !== 'messages') setView(0);
  }
  const totalRows = result?.results.reduce((a, b) => a + b.rows.length, 0) ?? 0;

  return (
    <div className="query-tab" style={{ display: active ? 'flex' : 'none' }}>
      <div className={'toolbar' + (connectionColor(conn.color) ? ' colored' : '')}
        style={{ ['--conn-color' as string]: connectionColor(conn.color) } as React.CSSProperties}>
        <button className="primary" onClick={() => run()} disabled={running || !connected} title="Run selection, or whole script if nothing is selected (Ctrl+Enter)">▶ Run</button>
        <button onClick={cancel} disabled={!running} title="Cancel the running query">■ Cancel</button>
        <button onClick={() => doFormatRef.current()} title="Format the selection, or the whole script (Ctrl+Shift+F)">Format</button>
        <label className="db-select">DB
          <select value={db} onChange={(e) => changeDb(e.target.value)} disabled={!connected || running}>
            {!db && <option value="">(none)</option>}
            {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
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
      <div className="editor-host" ref={hostRef} style={{ height: editorH }} />
      <div className="splitter" onMouseDown={startSplit} />
      <div className="results">
        <div className="result-tabs">
          {stacked ? (
            !!result?.results.length && (
              <button className={view !== 'messages' ? 'active' : ''} onClick={() => setView(0)}>
                Results <span className="muted">({result.results.length})</span>
              </button>
            )
          ) : result?.results.map((rs, i) => (
            <button key={i} className={view === i ? 'active' : ''} onClick={() => setView(i)} title={rs.sql}>
              Result {i + 1} <span className="muted">({rs.rows.length.toLocaleString()}{rs.limitApplied ? ', limited' : ''})</span>
            </button>
          ))}
          <button className={view === 'messages' ? 'active' : ''} onClick={() => setView('messages')}>Messages</button>
          <span className="spacer" />
          {result && (
            <span className="muted small">
              {result.cancelled ? 'Cancelled · ' : ''}{totalRows.toLocaleString()} rows · {fmtMs(result.totalMs)}
              {!stacked && current?.limitApplied ? ' · auto-LIMIT applied' : ''}
            </span>
          )}
          <span className="layout-switch" title="Show several results as tabs, or one below the other (like SSMS)">
            <button className={!stacked ? 'active' : ''} onClick={() => changeLayout('tabs')}>⧉ Tabs</button>
            <button className={stacked ? 'active' : ''} onClick={() => changeLayout('stacked')}>☰ Stacked</button>
          </span>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="result-body">
          {stacked && view !== 'messages' && result && result.results.length > 0 ? (
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
