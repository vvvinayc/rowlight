// Virtual-scrolling results grid: only visible rows are rendered, so 100k+ rows stay fast.
// Features: sort (click header), per-column + quick filter, cell/range selection, copy, CSV/Excel export,
// and inline editing (when the result is editable and the connection is not read-only).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, unwrap } from '../api';
import type { GridEditApi, SqlKind } from './useRowEdits';
import type { ChangeSet } from '../../shared/types';
import { jsonError, jsonTopLevel, looksLikeJson, prettyJson } from '../../shared/jsonFormat';

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

function initialWidths(columns: string[], rowCount: number, get: (r: number, c: number) => unknown): number[] {
  return columns.map((name, c) => {
    let len = name.length + 2;
    for (let r = 0; r < Math.min(rowCount, 200); r++) len = Math.max(len, display(get(r, c)).length);
    return Math.max(60, Math.min(360, len * 7.5 + 18));
  });
}

/** A number in a cell (numbers, or text like "655.00"), for the totals bar. */
function numberOf(v: unknown): { n: number; dec: number } | null {
  if (typeof v === 'number') return Number.isFinite(v) ? { n: v, dec: (String(v).split('.')[1] ?? '').length } : null;
  if (typeof v === 'bigint') return { n: Number(v), dec: 0 };
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return { n: Number(v), dec: (v.trim().split('.')[1] ?? '').length };
  return null;
}

/** JSON-object columns: detected from the first non-empty values. */
function jsonColumns(columns: string[], rowCount: number, get: (r: number, c: number) => unknown): number[] {
  const out: number[] = [];
  for (let c = 0; c < columns.length; c++) {
    let seen = 0, json = 0;
    for (let r = 0; r < rowCount && seen < 20; r++) {
      const v = get(r, c);
      if (v === null || v === undefined || v === '') continue;
      seen++;
      if (typeof v === 'string' && v.trimStart().startsWith('{') && jsonTopLevel(v)) json++;
      else if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) json++;
    }
    if (seen && json === seen) out.push(c);
  }
  return out;
}

const asText = (v: unknown) => (typeof v === 'string' ? v : v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : null);

export function ResultsGrid(props: Props) {
  const { columns: baseColumns, rows, resetKey, edit: editProp } = props;
  const baseGet = (r: number, c: number) => (editProp ? editProp.value(r, c) : rows[r][c]);
  const jsonCols = useMemo(() => jsonColumns(baseColumns, rows.length, baseGet),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseColumns, rows]);
  const [expanded, setExpanded] = useState<number[]>([]);
  useEffect(() => setExpanded([]), [baseColumns, resetKey]);

  // JSON → columns: each key of the expanded JSON columns becomes its own column, right after it.
  const derived = useMemo(() => {
    const exp = expanded.filter((c) => jsonCols.includes(c));
    if (!exp.length) return null;
    const cache = new Map<number, Map<number, Record<string, string | null> | null>>();
    const parsed = (r: number, c: number) => {
      let m = cache.get(c);
      if (!m) cache.set(c, (m = new Map()));
      if (!m.has(r)) { const t = asText(baseGet(r, c)); m.set(r, t ? jsonTopLevel(t) : null); }
      return m.get(r)!;
    };
    const cols: { name: string; base: number; get(r: number): unknown }[] = [];
    baseColumns.forEach((name, c) => {
      cols.push({ name, base: c, get: (r) => baseGet(r, c) });
      if (!exp.includes(c)) return;
      const keys: string[] = [];
      for (let r = 0; r < Math.min(rows.length, 5000); r++) for (const k of Object.keys(parsed(r, c) ?? {})) if (!keys.includes(k)) keys.push(k);
      for (const k of keys) cols.push({ name: `${name}.${k}`, base: -1, get: (r) => { const o = parsed(r, c); return o && k in o ? o[k] : null; } });
    });
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, jsonCols, baseColumns, rows, editProp]);
  const columns = useMemo(() => (derived ? derived.map((d) => d.name) : baseColumns), [derived, baseColumns]);
  const toggleJson = (c: number) => setExpanded((e) => (e.includes(c) ? e.filter((x) => x !== c) : [...e, c]));
  const baseIndex = (c: number) => (derived ? derived[c]?.base ?? -1 : c);
  return <GridInner {...props} columns={columns} edit={derived ? undefined : editProp}
    getCell={derived ? (r, c) => derived[c].get(r) : undefined}
    jsonCols={jsonCols} expanded={expanded} baseIndex={baseIndex} onToggleJson={toggleJson}
    editNote={derived ? 'JSON shown as columns: editing is off' : props.editNote} />;
}

interface InnerProps extends Props {
  getCell?: (r: number, c: number) => unknown;
  jsonCols: number[];
  expanded: number[];
  baseIndex(c: number): number;
  onToggleJson(c: number): void;
}

function GridInner({ columns, rows, resetKey, exportName, onStatus, edit, canEdit, editNote, hasMore, loadingMore, pageSize, onLoadMore, onPreviewSql, onOpenSql, getCell, jsonCols, expanded, baseIndex, onToggleJson }: InnerProps) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [filters, setFilters] = useState<string[]>(() => columns.map(() => ''));
  const [quick, setQuick] = useState('');
  /** Right-click → Filter = value / Exclude value (exact match, NULL included). */
  const [valueFilters, setValueFilters] = useState<{ c: number; value: string | null; neg: boolean }[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; r: number; c: number } | null>(null);
  const val = (r: number, c: number) => (getCell ? getCell(r, c) : edit ? edit.value(r, c) : rows[r][c]);
  const [widths, setWidths] = useState<number[]>(() => initialWidths(columns, rows.length, val));
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
  const rowDrag = useRef(false);

  // Reset state when a new result arrives.
  useEffect(() => {
    setSort(null);
    setFilters(columns.map(() => ''));
    setQuick('');
    setValueFilters([]);
    setMenu(null);
    setWidths(initialWidths(columns, rows.length, val));
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
      if (ok) for (const f of valueFilters) {
        const v = val(r, f.c);
        const same = f.value === null ? v === null || v === undefined : v !== null && v !== undefined && display(v) === f.value;
        if (same === f.neg) { ok = false; break; }
      }
      if (ok) idx.push(r);
    }
    if (sort) {
      const { col, dir } = sort;
      idx = idx.sort((a, b) => dir * compare(val(a, col), val(b, col)));
    }
    return idx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters, quick, sort, edit, getCell, valueFilters]);

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

  // Totals bar: Count / Sum / Avg / Min / Max of the selected cells (like Excel's status bar).
  const totals = useMemo(() => {
    if (!sel) return null;
    const cells = (sel.r2 - sel.r1 + 1) * (sel.c2 - sel.c1 + 1);
    if (cells < 2 || cells > 2_000_000) return cells > 2_000_000 ? { cells, nums: 0, sum: 0, min: 0, max: 0, dec: 0, minDec: 0, maxDec: 0 } : null;
    let nums = 0, sum = 0, min = Infinity, max = -Infinity, dec = 0, minDec = 0, maxDec = 0;
    for (let r = sel.r1; r <= sel.r2; r++) {
      for (let c = sel.c1; c <= sel.c2; c++) {
        const x = numberOf(val(view[r], c));
        if (!x) continue;
        nums++; sum += x.n; dec = Math.max(dec, x.dec);
        if (x.n < min) { min = x.n; minDec = x.dec; }
        if (x.n > max) { max = x.n; maxDec = x.dec; }
      }
    }
    return { cells, nums, sum, min, max, dec, minDec, maxDec };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.r1, sel?.r2, sel?.c1, sel?.c2, view, getCell, edit]);
  const fmtNum = (n: number, dec: number) => n.toLocaleString(undefined, { minimumFractionDigits: Math.min(dec, 6), maximumFractionDigits: Math.max(Math.min(dec, 6), 0) });
  const copyValue = async (label: string, text: string) => { await api.copyText(text); onStatus?.(`${label} copied: ${text}`); };

  return (
    <div className="grid-wrap">
      <div className="grid-toolbar">
        <input className="grid-quick" placeholder="Filter all columns…" value={quick} onChange={(e) => setQuick(e.target.value)} />
        <span className="muted">{filtered ? `${view.length.toLocaleString()} of ${rows.length.toLocaleString()} rows` : `${rows.length.toLocaleString()} rows`}</span>
        {valueFilters.map((f, i) => (
          <span key={i} className={'value-chip' + (f.neg ? ' neg' : '')} title="Right-click a cell to add more">
            {columns[f.c]} {f.neg ? (f.value === null ? 'is not NULL' : '≠') : (f.value === null ? 'is NULL' : '=')} {f.value === null ? '' : f.value.length > 24 ? f.value.slice(0, 24) + '…' : f.value}
            <button title="Remove this filter" onClick={() => setValueFilters((v) => v.filter((_, j) => j !== i))}>×</button>
          </span>
        ))}
        {(filtered || sort) && (
          <button className="link" onClick={() => { setFilters(columns.map(() => '')); setQuick(''); setSort(null); setValueFilters([]); }}>Clear filters/sort</button>
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
              <div className="grid-cell rownum clickable" style={{ width: ROWNUM_W }} title="Select all"
                onClick={() => { if (view.length && columns.length) { setAnchor({ r: 0, c: 0 }); setFocus({ r: view.length - 1, c: columns.length - 1 }); scrollRef.current?.focus(); } }}>#</div>
              {columns.map((c, i) => (
                <div key={i} className={'grid-cell head' + (editable && !edit!.isEditableCol(i) ? ' computed' : '')} style={{ width: widths[i] }} onClick={() => clickSort(i)} title={c}>
                  {jsonCols.includes(baseIndex(i)) && (
                    <button className={'json-cols' + (expanded.includes(baseIndex(i)) ? ' active' : '')}
                      title={expanded.includes(baseIndex(i)) ? 'Hide the JSON key columns' : 'Show each JSON key as its own column (filter, sort, copy, export)'}
                      onClick={(e) => { e.stopPropagation(); onToggleJson(baseIndex(i)); }}>{'{}'}</button>
                  )}
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
                  <div className="grid-cell rownum clickable" style={{ width: ROWNUM_W }} title="Click: select the row · Shift+Click / drag: several rows · then Ctrl+C"
                    onMouseDown={(e) => {
                      if (e.button !== 0 || !columns.length) return;
                      e.preventDefault();
                      scrollRef.current?.focus();
                      const lastC = columns.length - 1;
                      if (e.shiftKey && anchor) setAnchor({ r: anchor.r, c: 0 }); else setAnchor({ r, c: 0 });
                      setFocus({ r, c: lastC });
                      rowDrag.current = true;
                      const up = () => { rowDrag.current = false; window.removeEventListener('mouseup', up); };
                      window.addEventListener('mouseup', up);
                    }}
                    onMouseEnter={() => { if (rowDrag.current) setFocus({ r, c: columns.length - 1 }); }}
                  >{state === 'inserted' ? '+' : r + 1}</div>
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
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (!isSel(r, c)) { setAnchor({ r, c }); setFocus({ r, c }); }
                          setMenu({ x: e.clientX, y: e.clientY, r, c });
                        }}
                      >{text.length > 300 ? text.slice(0, 300) + '…' : text}</div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {menu && (() => {
        const v = val(view[menu.r], menu.c);
        const isNull = v === null || v === undefined;
        const shown = isNull ? 'NULL' : display(v);
        const short = shown.length > 30 ? shown.slice(0, 30) + '…' : shown;
        const col = columns[menu.c];
        const plainCol = /^[A-Za-z_][\w$]*$/.test(col) ? col : '`' + col.replace(/`/g, '``') + '`';
        // Numbers from number columns without quotes; everything else quoted (also safe for VARCHAR ids like '2705820').
        const literal = isNull ? null : typeof v === 'number' || typeof v === 'bigint' ? String(v) : "'" + shown.replace(/'/g, "''") + "'";
        const cond = isNull ? `${plainCol} IS NULL` : `${plainCol} = ${literal}`;
        const add = (neg: boolean) => { setValueFilters((f) => [...f, { c: menu.c, value: isNull ? null : shown, neg }]); setMenu(null); };
        const item = (label: React.ReactNode, act: () => void, title?: string) => (
          <button className="ctx-item" title={title} onMouseDown={(e) => e.preventDefault()} onClick={act}>{label}</button>
        );
        return (
          <div className="ctx-backdrop" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
            <div className="ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 300), top: Math.min(menu.y, window.innerHeight - 220) }} onMouseDown={(e) => e.stopPropagation()}>
              {item(<>Filter: <b>{col}</b> {isNull ? 'is NULL' : '='} <code>{isNull ? '' : short}</code></>, () => add(false), 'Show only rows with this value')}
              {item(<>Exclude: <b>{col}</b> {isNull ? 'is not NULL' : '≠'} <code>{isNull ? '' : short}</code></>, () => add(true), 'Hide rows with this value')}
              <div className="ctx-sep" />
              {item('Copy value', async () => { setMenu(null); await api.copyText(isNull ? '' : shown); onStatus?.('Value copied'); })}
              {item(<>Copy as condition <code>{cond.length > 34 ? cond.slice(0, 34) + '…' : cond}</code></>, async () => { setMenu(null); await api.copyText(cond); onStatus?.('Copied: ' + cond); }, 'For a WHERE clause')}
              {sel && (sel.r1 !== sel.r2 || sel.c1 !== sel.c2) && item('Copy selected cells (Ctrl+C)', () => { setMenu(null); copy(false); })}
              {valueFilters.length > 0 && <><div className="ctx-sep" />{item('Remove value filters', () => { setValueFilters([]); setMenu(null); })}</>}
            </div>
          </div>
        );
      })()}
      {totals && (
        <div className="grid-totals" title="Click a number to copy it">
          <span>Count <b>{totals.cells.toLocaleString()}</b></span>
          {totals.nums > 0 && (() => {
            const avgDec = Math.max(totals.dec, 2);
            const items: [string, number, number][] = [['Sum', totals.sum, totals.dec], ['Avg', totals.sum / totals.nums, avgDec], ['Min', totals.min, totals.minDec], ['Max', totals.max, totals.maxDec]];
            return <>
              {totals.nums !== totals.cells && <span>Numbers <b>{totals.nums.toLocaleString()}</b></span>}
              {items.map(([label, n, dec]) => {
                const plain = n.toFixed(Math.min(dec, 6));
                return <span key={label} className="clickable" onClick={() => copyValue(label, plain)}>{label} <b>{fmtNum(n, dec)}</b></span>;
              })}
            </>;
          })()}
          {totals.cells > 2_000_000 && <span className="muted">too many cells to add up</span>}
        </div>
      )}
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
      {viewer && <ValueViewer col={viewer.col} value={viewer.value} onClose={() => setViewer(null)} onStatus={onStatus} />}
    </div>
  );
}

/** Full cell value. JSON is shown formatted (values kept exactly as stored), with a switch back to the raw text. */
function ValueViewer({ col, value, onClose, onStatus }: { col: string; value: string; onClose(): void; onStatus?: (m: string) => void }) {
  const isJson = useMemo(() => looksLikeJson(value), [value]);
  const [pretty, setPretty] = useState(true);
  const err = useMemo(() => (isJson ? jsonError(value.trim()) : null), [isJson, value]);
  const shown = isJson && pretty ? prettyJson(value) : value;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <h3>{col}{isJson && <span className="muted small"> · JSON</span>}</h3>
        <textarea className="value-viewer" readOnly value={shown} autoFocus wrap={isJson && pretty ? 'off' : 'soft'} />
        {err && <div className="muted small json-error">⚠ Not valid JSON: {err}</div>}
        <div className="modal-actions">
          {isJson && (
            <span className="seg">
              <button className={pretty ? 'active' : ''} onClick={() => setPretty(true)} title="Indented, one value per line">Formatted</button>
              <button className={!pretty ? 'active' : ''} onClick={() => setPretty(false)} title="Exactly as stored in the database">As stored</button>
            </span>
          )}
          <span className="spacer" />
          <button onClick={async () => { await api.copyText(shown); onStatus?.(isJson && pretty ? 'Formatted JSON copied' : 'Value copied'); }}>Copy</button>
          <button className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
