// Result of "⇄ Compare with …": the same query on two connections, differences highlighted.

import React, { useMemo, useState } from 'react';
import { compareTables, defaultKey, type RowStatus, type Table } from '../../shared/compare';
import { api } from '../api';

export interface CompareData {
  aName: string;
  bName: string;
  sql: string;
  a: Table | null;
  b: Table | null;
  aError?: string;
  bError?: string;
  /** Either side was cut by the auto-LIMIT. */
  limited: boolean;
  ms: number;
}

const MAX_SHOWN = 3000;
const show = (v: unknown) => (v === null || v === undefined ? 'NULL' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v));
const LABEL: Record<RowStatus, string> = { same: '=', changed: '≠', onlyA: 'only', onlyB: 'only' };

export function CompareView({ data, onStatus }: { data: CompareData; onStatus(m: string): void }) {
  const { a, b, aName, bName } = data;
  const [key, setKey] = useState<string | null | undefined>(undefined); // undefined = automatic
  const [onlyDiff, setOnlyDiff] = useState(true);
  const diff = useMemo(() => (a && b ? compareTables(a, b, key === undefined ? defaultKey(a, b) : key) : null), [a, b, key]);

  if (!a || !b || !diff) {
    return (
      <div className="compare">
        <div className="compare-head"><b>⇄ {aName} vs {bName}</b></div>
        <div className="error-banner">
          {data.aError && <div><b>{aName}:</b> {data.aError}</div>}
          {data.bError && <div><b>{bName}:</b> {data.bError}</div>}
        </div>
      </div>
    );
  }
  const { counts } = diff;
  const differences = counts.changed + counts.onlyA + counts.onlyB;
  const rows = onlyDiff ? diff.rows.filter((r) => r.status !== 'same') : diff.rows;
  const shown = rows.slice(0, MAX_SHOWN);
  const shared = a.columns.filter((c) => b.columns.includes(c));
  // Columns worth showing: the key, plus every column that differs somewhere (all columns when showing everything).
  const diffCols = new Set(diff.rows.flatMap((r) => r.diff));
  const keyIdx = diff.key ? diff.columns.indexOf(diff.key) : -1;
  const cols = diff.columns.map((_, i) => i).filter((i) => !onlyDiff || i === keyIdx || diffCols.has(i) || counts.onlyA + counts.onlyB > 0);
  const short = (n: string) => (n.length > 18 ? n.slice(0, 17) + '…' : n);

  async function copyReport() {
    const lines = [['status', ...cols.map((i) => diff!.columns[i])].join('\t')];
    for (const r of rows) {
      const st = r.status === 'onlyA' ? `only in ${aName}` : r.status === 'onlyB' ? `only in ${bName}` : r.status;
      lines.push([st, ...cols.map((i) => {
        if (r.status === 'changed' && r.diff.includes(i)) return `${show(r.a![i])} → ${show(r.b![i])}`;
        return show((r.a ?? r.b)![i]);
      })].join('\t'));
    }
    await api.copyText(lines.join('\r\n'));
    onStatus(`Copied ${rows.length} row(s) of the comparison`);
  }

  return (
    <div className="compare">
      <div className="compare-head">
        <b>⇄ {aName} vs {bName}</b>
        <span className="muted">{a.rows.length.toLocaleString()} rows vs {b.rows.length.toLocaleString()} rows · {data.ms} ms</span>
        <label className="small">Match rows by{' '}
          <select value={key === undefined ? '\u0000auto' : key ?? ''} onChange={(e) => setKey(e.target.value === '\u0000auto' ? undefined : e.target.value || null)}>
            <option value={'\u0000auto'}>automatic ({diff.key ?? 'row order'})</option>
            <option value="">row order</option>
            {shared.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="check small"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Only differences</label>
        <span className="spacer" />
        <button onClick={copyReport} disabled={!rows.length} title="Copy the rows shown (paste into Excel)">Copy</button>
      </div>
      <div className={'compare-summary' + (differences ? ' diff' : ' same')}>
        {differences === 0
          ? <>✓ Same on both: {counts.same.toLocaleString()} row(s){diff.onlyAColumns.length + diff.onlyBColumns.length ? '' : `, ${shared.length} column(s)`}</>
          : <>
              {counts.changed > 0 && <span className="pill changed">≠ {counts.changed.toLocaleString()} different</span>}
              {counts.onlyA > 0 && <span className="pill onlyA">{counts.onlyA.toLocaleString()} only in {aName}</span>}
              {counts.onlyB > 0 && <span className="pill onlyB">{counts.onlyB.toLocaleString()} only in {bName}</span>}
              <span className="pill same">= {counts.same.toLocaleString()} same</span>
            </>}
        {diff.onlyAColumns.length > 0 && <span className="muted"> · columns only in {aName}: {diff.onlyAColumns.join(', ')}</span>}
        {diff.onlyBColumns.length > 0 && <span className="muted"> · columns only in {bName}: {diff.onlyBColumns.join(', ')}</span>}
        {data.limited && <span className="muted"> · only the first rows were compared (auto-LIMIT); add ORDER BY and a WHERE to compare exactly the same rows</span>}
        {!diff.key && differences > 0 && <span className="muted"> · rows matched by order: pick a column under “Match rows by” for exact matching</span>}
      </div>
      {shown.length > 0 && (
        <div className="compare-table-wrap">
          <table className="compare-table">
            <thead>
              <tr>
                <th />
                {cols.map((i) => <th key={i} title={diff.columns[i]} className={diffCols.has(i) ? 'has-diff' : ''}>{diff.columns[i]}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, k) => (
                <tr key={k} className={r.status}>
                  <td className="st" title={r.status === 'onlyA' ? `Only in ${aName}` : r.status === 'onlyB' ? `Only in ${bName}` : r.status === 'changed' ? 'Different values' : 'Same'}>
                    {LABEL[r.status]}{r.status === 'onlyA' ? ' ' + short(aName) : r.status === 'onlyB' ? ' ' + short(bName) : ''}
                  </td>
                  {cols.map((i) => {
                    if (r.status === 'changed' && r.diff.includes(i)) {
                      return <td key={i} className="cell-diff"><div className="va" title={aName}>{show(r.a![i])}</div><div className="vb" title={bName}>{show(r.b![i])}</div></td>;
                    }
                    const v = (r.a ?? r.b)![i];
                    return <td key={i} className={v === null ? 'null' : ''}>{show(v)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > MAX_SHOWN && <div className="muted small pad">Showing the first {MAX_SHOWN.toLocaleString()} of {rows.length.toLocaleString()} rows. Copy copies all of them.</div>}
        </div>
      )}
      <div className="compare-legend muted small">
        <span><i className="sw va" /> {aName}</span><span><i className="sw vb" /> {bName}</span>
      </div>
    </div>
  );
}

/** "Compare with…": pick the other connection (same database type). Connected ones first. */
export function ComparePicker({ self, connections, connected, onPick, onClose }: {
  self: { id: string; type: string };
  connections: { id: string; name: string; type: string }[];
  connected: Record<string, unknown>;
  onPick(id: string): void;
  onClose(): void;
}) {
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(0);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = connections
    .filter((c) => c.id !== self.id && c.type === self.type && words.every((w) => c.name.toLowerCase().includes(w)))
    .sort((x, y) => Number(!!connected[y.id]) - Number(!!connected[x.id]) || x.name.localeCompare(y.name));
  const cur = list[Math.min(pick, list.length - 1)];
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal compare-picker" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => Math.min(list.length - 1, p + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => Math.max(0, p - 1)); }
          else if (e.key === 'Enter' && cur) { e.preventDefault(); e.stopPropagation(); onPick(cur.id); }
        }}>
        <h3>⇄ Compare with…</h3>
        <input autoFocus className="shortcuts-search" value={q} onChange={(e) => { setQ(e.target.value); setPick(0); }} placeholder="Type part of a connection name…" />
        <div className="saved-list">
          {list.length === 0 && <div className="muted pad">No other {self.type === 'mysql' ? 'MySQL' : 'SQL Server'} connection{q ? ` matches “${q}”` : ''}.</div>}
          {list.map((c, i) => (
            <div key={c.id} className={'saved-item' + (c === cur ? ' picked' : '')} onMouseEnter={() => setPick(i)} onClick={() => onPick(c.id)}>
              <span className={'dot ' + (connected[c.id] ? 'on' : 'off')} /> {c.name}
              {!connected[c.id] && <span className="muted small"> · not connected (it connects first)</span>}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <span className="muted small">Runs the query under the cursor on both and shows the differences. To always compare two connections, set ✎ Edit → Compare with.</span>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
