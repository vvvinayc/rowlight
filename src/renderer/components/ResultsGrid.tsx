// Virtual-scrolling results grid: only visible rows are rendered, so 100k+ rows stay fast.
// Features: sort (click header), per-column + quick filter, cell/range selection, copy, CSV/Excel export,
// and inline editing (when the result is editable and the connection is not read-only).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, unwrap } from '../api';
import type { GridEditApi, SqlKind } from './useRowEdits';
import type { ChangeSet } from '../../shared/types';

const ROW_H = 24;
const ROWNUM_W = 56;
const OVERSCAN = 10;

interface Props {
  columns: string[];
  rows: unknown[][];
  /** Changes when a new query result arrives (resets sort, filters, selection). */
  resetKey: unknown;
  exportName: string;
  onStatus?: (msg: string) => void;
  /** Present when the result maps to one table with a primary key. */
  edit?: GridEditApi;
  /** False when the connection is read-only. */
  canEdit?: boolean;
  /** Short text shown in the toolbar about editability. */
  editNote?: string;
  /** The result was cut by the auto-LIMIT and more rows can be fetched. */
  hasMore?: boolean;
  loadingMore?: boolean;
  /** Rows fetched per page (the auto-LIMIT), shown on the button. */
  pageSize?: number;
  onLoadMore?(): void;
  /** Turns a change set into readable SQL (no execution). Present when the result maps to one table. */
  onPreviewSql?(cs: ChangeSet): Promise<string[]>;
  /** Opens generated SQL in a new query tab. */
  onOpenSql?(sql: string): void;
}

interface Cell { r: number; c: number }

const display = (v: unknown) => (v === null || v === undefined ? 'NULL' : String(v));

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function initialWidths(columns: string[], rows: unknown[][]): number[] {
  return columns.map((name, c) => {
    let len = name.length + 2;
    for (let r = 0; r < Math.min(rows.length, 200); r++) len = Math.max(len, display(rows[r][c]).length);
    return Math.max(60, Math.min(360, len * 7.5 + 18));
  });
}

export function ResultsGrid({ columns, rows, resetKey, exportName, onStatus, edit, canEdit, editNote, hasMore, loadingMore, pageSize, onLoadMore, onPreviewSql, onOpenSql }: Props) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [filters, setFilters] = useState<string[]>(() => columns.map(() => ''));
  const [quick, setQuick] = useState('');
  const [widths, setWidths] = useState<number[]>(() => initialWidths(columns, rows));
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [focus, setFocus] = useState<Cell | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [viewer, setViewer] = useState<{ col: string; value: string } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; text: string } | null>(null);
  const [generated, setGenerated] = useState<{ title: string; sql: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const editable = !!edit && !!canEdit;
  const val = (r: number, c: number) => (edit ? edit.value(r, c) : rows[r][c]);

  // Reset state when a new result arrives.
  useEffect(() => {
    setSort(null);
    setFilters(columns.map(() => ''));
    setQuick('');
    setWidths(initialWidths(columns, rows));
    setAnchor(null);
    setFocus(null);
    setEditing(null);
    scrollRef.current?.scrollTo(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, resetKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Visible row indexes after filter + sort.
  const view = useMemo(() => {
    const active = filters.map((f, i) => [i, f.trim().toLowerCase()] as const).filter(([, f]) => f);
    const q = quick.trim().toLowerCase();
    let idx: number[] = [];
    for (let r = 0; r < rows.length; r++) {
      let ok = true;
      for (const [c, f] of active) {
        if (!display(val(r, c)).toLowerCase().includes(f)) { ok = false; break; }
      }
      if (ok && q) ok = columns.some((_, c) => display(val(r, c)).toLowerCase().includes(q));
      if (ok) idx.push(r);
    }
    if (sort) {
      const { col, dir } = sort;
      idx = idx.sort((a, b) => dir * compare(val(a, col), val(b, col)));
    }
    return idx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters, quick, sort, edit]);

  const totalW = ROWNUM_W + widths.reduce((a, b) => a + b, 0);
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(view.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);

  const sel = anchor && focus ? {
    r1: Math.min(anchor.r, focus.r), r2: Math.max(anchor.r, focus.r),
    c1: Math.min(anchor.c, focus.c), c2: Math.max(anchor.c, focus.c),
  } : null;
  const isSel = (r: number, c: number) => !!sel && r >= sel.r1 && r <= sel.r2 && c >= sel.c1 && c <= sel.c2;
  const selectedRows = () => (sel ? view.slice(sel.r1, sel.r2 + 1) : []);

  function clickSort(c: number) {
    setSort((s) => (!s || s.col !== c ? { col: c, dir: 1 } : s.dir === 1 ? { col: c, dir: -1 } : null));
  }

  function startResize(e: React.MouseEvent, c: number) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[c];
    const move = (ev: MouseEvent) => setWidths((w) => w.map((x, i) => (i === c ? Math.max(40, startW + ev.clientX - startX) : x)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function selectedText(withHeaders: boolean): string {
    if (!sel) return '';
    const lines: string[] = [];
    const cols = Array.from({ length: sel.c2 - sel.c1 + 1 }, (_, i) => sel.c1 + i);
    if (withHeaders) lines.push(cols.map((c) => columns[c]).join('\t'));
    for (let r = sel.r1; r <= sel.r2; r++) {
      lines.push(cols.map((c) => { const v = val(view[r], c); return v === null ? '' : String(v).replace(/[\t\r\n]+/g, ' '); }).join('\t'));
    }
    return lines.join('\r\n');
  }

  async function copy(withHeaders: boolean) {
    const text = selectedText(withHeaders);
    if (!text) return;
    await api.copyText(text);
    const n = sel ? (sel.r2 - sel.r1 + 1) * (sel.c2 - sel.c1 + 1) : 0;
    onStatus?.(`Copied ${n} cell${n === 1 ? '' : 's'}${withHeaders ? ' with headers' : ''}`);
  }

  /** Scrolls so the cell (view row r, column c) is fully visible: up/down AND left/right. */
  function ensureVisible(r: number, c?: number) {
    const el = scrollRef.current;
    if (!el) return;
    const top = r * ROW_H;
    const headerH = 2 * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight - headerH) el.scrollTop = top + ROW_H - el.clientHeight + headerH;
    if (c === undefined) return;
    // The row-number column is sticky on the left, so the visible data area starts after it.
    const left = ROWNUM_W + widths.slice(0, c).reduce((a, b) => a + b, 0);
    const right = left + widths[c];
    if (left - ROWNUM_W < el.scrollLeft) el.scrollLeft = left - ROWNUM_W;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.min(left - ROWNUM_W, right - el.clientWidth);
  }

  // ---------- editing ----------

  function canEditCell(vr: number, c: number) {
    const r = view[vr];
    return editable && r !== undefined && edit!.isEditableCol(c) && edit!.rowState(r) !== 'deleted';
  }

  function beginEdit(vr: number, c: number, initial?: string) {
    if (!canEditCell(vr, c)) {
      if (edit && canEdit && !edit.isEditableCol(c)) onStatus?.(`Column "${columns[c]}" is computed and cannot be edited`);
      return false;
    }
    const v = val(view[vr], c);
    setEditing({ r: vr, c, text: initial ?? (v === null || v === undefined ? '' : String(v)) });
    return true;
  }

  function commitEdit(move?: [number, number]) {
    if (!editing) return;
    edit!.setCell(view[editing.r], editing.c, editing.text);
    const next = move ? {
      r: Math.max(0, Math.min(view.length - 1, editing.r + move[0])),
      c: Math.max(0, Math.min(columns.length - 1, editing.c + move[1])),
    } : { r: editing.r, c: editing.c };
    setEditing(null);
    setFocus(next);
    setAnchor(next);
    scrollRef.current?.focus();
    ensureVisible(next.r, next.c);
  }

  function setNull() {
    if (!sel || !editable) return;
    let n = 0;
    for (let vr = sel.r1; vr <= sel.r2; vr++) {
      for (let c = sel.c1; c <= sel.c2; c++) {
        if (canEditCell(vr, c)) { edit!.setCell(view[vr], c, null); n++; }
      }
    }
    onStatus?.(n ? `Set ${n} cell(s) to NULL` : 'Selected cells are not editable');
  }

  function deleteRows() {
    const rs = selectedRows();
    if (!rs.length) { onStatus?.('Select a row first'); return; }
    edit!.toggleDelete(rs);
  }

  function duplicate() {
    const rs = selectedRows();
    if (!rs.length) { onStatus?.('Select the row(s) to duplicate first'); return; }
    const k = edit!.duplicateRows(rs);
    setSort(null);
    onStatus?.(`Duplicated ${k} row(s) as new rows (primary key left empty). Edit them, then Save.`);
    setTimeout(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, 0);
  }

  /** INSERT / UPDATE / DELETE for the selected rows (or all shown rows), shown for copying. Runs nothing. */
  async function generateSql(kind: SqlKind) {
    if (!edit || !onPreviewSql) return;
    const picked = selectedRows();
    const rs = picked.length ? picked : view;
    if (!rs.length) { onStatus?.('No rows'); return; }
    if (rs.length > 5000 && !window.confirm(`Generate ${kind.toUpperCase()} statements for ${rs.length.toLocaleString()} rows?`)) return;
    try {
      const lines = await onPreviewSql(edit.sqlFor(kind, rs));
      if (!lines.length) { onStatus?.(kind === 'insert' ? 'Nothing to generate' : 'New (unsaved) rows have no key yet: only INSERT works for them'); return; }
      setGenerated({ title: `${kind.toUpperCase()} for ${lines.length} row(s)${picked.length ? '' : ' (all shown rows)'}`, sql: lines.join('\n') });
    } catch (e) {
      onStatus?.('Could not generate SQL: ' + errorText(e));
    }
  }

  function addRow() {
    edit!.addRow();
    // The new row is added at the end; clear sort so it shows up last.
    setSort(null);
    setTimeout(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, 0);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); copy(e.shiftKey); return; }
    if (ctrl && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (view.length && columns.length) { setAnchor({ r: 0, c: 0 }); setFocus({ r: view.length - 1, c: columns.length - 1 }); }
      return;
    }
    if (editable && focus && (e.key === 'F2' || e.key === 'Enter')) { e.preventDefault(); beginEdit(focus.r, focus.c); return; }
    if (editable && focus && e.key === 'Delete' && !ctrl) { e.preventDefault(); setNull(); return; }
    if (editable && focus && !ctrl && !e.altKey && e.key.length === 1) {
      if (beginEdit(focus.r, focus.c, e.key)) e.preventDefault(); // start typing replaces the value
      return;
    }
    const page = Math.max(1, Math.floor(((scrollRef.current?.clientHeight ?? 400) - 2 * ROW_H) / ROW_H) - 1);
    const lastR = view.length - 1;
    const lastC = columns.length - 1;
    const cur = focus ?? { r: 0, c: 0 };
    const targets: Record<string, () => Cell> = {
      ArrowUp: () => ({ r: cur.r - 1, c: cur.c }),
      ArrowDown: () => ({ r: cur.r + 1, c: cur.c }),
      ArrowLeft: () => ({ r: cur.r, c: cur.c - 1 }),
      ArrowRight: () => ({ r: cur.r, c: cur.c + 1 }),
      PageUp: () => ({ r: cur.r - page, c: cur.c }),
      PageDown: () => ({ r: cur.r + page, c: cur.c }),
      Home: () => (ctrl ? { r: 0, c: 0 } : { r: cur.r, c: 0 }), // Home: first column, Ctrl+Home: first cell
      End: () => (ctrl ? { r: lastR, c: lastC } : { r: cur.r, c: lastC }), // End: last column, Ctrl+End: last cell
    };
    const t = targets[e.key];
    if (!t || !view.length || !columns.length) return;
    e.preventDefault();
    const raw = focus ? t() : { r: 0, c: 0 }; // first key press selects the first cell
    const next = { r: Math.max(0, Math.min(lastR, raw.r)), c: Math.max(0, Math.min(lastC, raw.c)) };
    setFocus(next);
    if (!e.shiftKey) setAnchor(next);
    ensureVisible(next.r, next.c);
    if (next.r === lastR && hasMore && !loadingMore) onLoadMore?.(); // reached the end of a limited result
  }

  async function doExport(format: 'csv' | 'xlsx') {
    try {
      const data = view.map((r) => columns.map((_, c) => val(r, c)));
      const file = await unwrap(api.exportResult(format, columns, data, exportName));
      if (file) onStatus?.(`Exported ${data.length} rows to ${file}`);
    } catch (e) {
      onStatus?.('Export failed: ' + errorText(e));
    }
  }

  const filtered = view.length !== rows.length;

  return (
    <div className="grid-wrap">
      <div className="grid-toolbar">
        <input className="grid-quick" placeholder="Filter all columns…" value={quick} onChange={(e) => setQuick(e.target.value)} />
        <span className="muted">{filtered ? `${view.length.toLocaleString()} of ${rows.length.toLocaleString()} rows` : `${rows.length.toLocaleString()} rows`}</span>
        {(filtered || sort) && (
          <button className="link" onClick={() => { setFilters(columns.map(() => '')); setQuick(''); setSort(null); }}>Clear filters/sort</button>
        )}
        {editable && (
          <>
            <span className="sep" />
            <button onClick={addRow} title="Add a new row">+ Row</button>
            <button onClick={deleteRows} title="Mark the selected rows for deletion (click again to undo)">− Delete row</button>
            <button onClick={setNull} title="Set the selected cells to NULL (Delete key)">Set NULL</button>
            <button onClick={duplicate} title="Copy the selected rows as new rows (primary key left empty), then edit and Save">⧉ Duplicate</button>
          </>
        )}
        {edit && onPreviewSql && (
          <select className="gen-sql" value="" title="Generate INSERT / UPDATE / DELETE statements for the selected rows (all shown rows if none are selected). Nothing is run."
            onChange={(e) => { const k = e.target.value as SqlKind; if (k) generateSql(k); }}>
            <option value="">Generate SQL…</option>
            <option value="insert">INSERT statements</option>
            <option value="update">UPDATE statements</option>
            <option value="delete">DELETE statements</option>
          </select>
        )}
        <span className="spacer" />
        {editNote && <span className={'edit-note small' + (editable ? ' on' : '')} title={editNote}>{editNote}</span>}
        <button onClick={() => doExport('csv')}>Export CSV</button>
        <button onClick={() => doExport('xlsx')}>Export Excel</button>
      </div>
      <div className="grid-scroll" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown}
        onScroll={(e) => {
          const el = e.target as HTMLDivElement;
          setScrollTop(el.scrollTop);
          // Near the bottom of a limited result: fetch the next page automatically.
          if (hasMore && !loadingMore && el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 3 * ROW_H) onLoadMore?.();
        }}>
        <div style={{ width: totalW, minWidth: '100%' }}>
          <div className="grid-head">
            <div className="grid-row">
              <div className="grid-cell rownum" style={{ width: ROWNUM_W }}>#</div>
              {columns.map((c, i) => (
                <div key={i} className={'grid-cell head' + (editable && !edit!.isEditableCol(i) ? ' computed' : '')} style={{ width: widths[i] }} onClick={() => clickSort(i)} title={c}>
                  <span className="head-name">{c}</span>
                  {sort?.col === i && <span className="sort">{sort.dir === 1 ? '▲' : '▼'}</span>}
                  <span className="resizer" onMouseDown={(e) => startResize(e, i)} onClick={(e) => e.stopPropagation()} />
                </div>
              ))}
            </div>
            <div className="grid-row filters">
              <div className="grid-cell rownum" style={{ width: ROWNUM_W }} />
              {columns.map((_, i) => (
                <div key={i} className="grid-cell" style={{ width: widths[i] }}>
                  <input value={filters[i] ?? ''} placeholder="filter"
                    onChange={(e) => { const v = e.target.value; setFilters((f) => f.map((x, j) => (j === i ? v : x))); }} />
                </div>
              ))}
            </div>
          </div>
          <div style={{ height: view.length * ROW_H + (hasMore ? 2 * ROW_H : 0), position: 'relative' }}>
            {hasMore && (
              <div className="load-more-row" style={{ top: view.length * ROW_H }}><div className="load-more">
                <button onClick={() => onLoadMore?.()} disabled={loadingMore}>
                  {loadingMore ? 'Loading more rows…' : `↓ Load ${pageSize ? 'next ' + pageSize.toLocaleString() : 'more'} rows`}
                </button>
                <span className="muted small">&nbsp;Scroll to the bottom to load automatically. Sort and filters apply to the rows loaded so far.</span>
              </div></div>
            )}
            {view.slice(first, last).map((rowIdx, k) => {
              const r = first + k;
              const state = edit?.rowState(rowIdx);
              return (
                <div key={r} className={'grid-row' + (r % 2 ? ' odd' : '') + (state ? ' ' + state : '')} style={{ position: 'absolute', top: r * ROW_H, height: ROW_H }}>
                  <div className="grid-cell rownum" style={{ width: ROWNUM_W }}>{state === 'inserted' ? '+' : r + 1}</div>
                  {columns.map((_, c) => {
                    if (editing && editing.r === r && editing.c === c) {
                      return (
                        <div key={c} className="grid-cell editing" style={{ width: widths[c] }}>
                          <input autoFocus value={editing.text}
                            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                            onBlur={() => commitEdit()}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === 'Enter') { e.preventDefault(); commitEdit([1, 0]); }
                              else if (e.key === 'Tab') { e.preventDefault(); commitEdit([0, e.shiftKey ? -1 : 1]); }
                              else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); scrollRef.current?.focus(); }
                            }} />
                        </div>
                      );
                    }
                    const v = val(rowIdx, c);
                    const text = display(v);
                    return (
                      <div key={c}
                        className={'grid-cell' + (v === null ? ' null' : '') + (typeof v === 'number' ? ' num' : '') +
                          (edit?.isDirty(rowIdx, c) ? ' dirty' : '') + (isSel(r, c) ? ' sel' : '') +
                          (focus && focus.r === r && focus.c === c ? ' focus' : '')}
                        style={{ width: widths[c] }}
                        title={text.length > 40 ? text.slice(0, 500) : undefined}
                        onMouseDown={(e) => {
                          if (e.button !== 0) return;
                          scrollRef.current?.focus();
                          dragging.current = true;
                          const cell = { r, c };
                          setFocus(cell);
                          if (!e.shiftKey || !anchor) setAnchor(cell);
                          const up = () => { dragging.current = false; window.removeEventListener('mouseup', up); };
                          window.addEventListener('mouseup', up);
                        }}
                        onMouseEnter={() => { if (dragging.current) setFocus({ r, c }); }}
                        onDoubleClick={() => { if (!beginEdit(r, c)) setViewer({ col: columns[c], value: text }); }}
                      >{text.length > 300 ? text.slice(0, 300) + '…' : text}</div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {generated && (
        <div className="modal-backdrop" onMouseDown={() => setGenerated(null)}>
          <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
            <h3>{generated.title}</h3>
            <textarea className="value-viewer sql-gen" readOnly value={generated.sql} />
            <div className="modal-actions">
              <span className="muted small">Nothing was run. Review before using it.</span>
              <span className="spacer" />
              <button onClick={async () => { await api.copyText(generated.sql); onStatus?.('SQL copied'); }}>Copy</button>
              {onOpenSql && <button onClick={() => { onOpenSql(generated.sql); setGenerated(null); }}>Open in new tab</button>}
              <button className="primary" onClick={() => setGenerated(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {viewer && (
        <div className="modal-backdrop" onMouseDown={() => setViewer(null)}>
          <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
            <h3>{viewer.col}</h3>
            <textarea className="value-viewer" readOnly value={viewer.value} />
            <div className="modal-actions">
              <button onClick={() => api.copyText(viewer.value)}>Copy</button>
              <button className="primary" onClick={() => setViewer(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
