// Query history for the active connection (newest first).

import React, { useEffect, useState } from 'react';
import type { HistoryEntry } from '../../shared/types';
import { api, unwrap } from '../api';

interface Props {
  connId: string | null;
  connName: string;
  version: number; // bump to reload
  onInsert(sql: string): void;
  onClose(): void;
}

export function HistoryPanel({ connId, connName, version, onInsert, onClose }: Props) {
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [q, setQ] = useState('');
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  async function copy(sql: string, i: number) {
    await api.copyText(sql);
    setCopiedIdx(i);
    setTimeout(() => setCopiedIdx((x) => (x === i ? null : x)), 1500);
  }

  useEffect(() => {
    if (!connId) { setItems([]); return; }
    unwrap(api.history.get(connId)).then(setItems).catch(() => setItems([]));
  }, [connId, version]);

  const shown = q ? items.filter((h) => h.sql.toLowerCase().includes(q.toLowerCase())) : items;

  return (
    <div className="history">
      <div className="sidebar-head">
        <strong>History</strong><span className="muted small">&nbsp;{connName}</span>
        <span className="spacer" />
        {connId && <button title="Clear history" onClick={async () => { await api.history.clear(connId); setItems([]); }}>Clear</button>}
        <button onClick={onClose}>✕</button>
      </div>
      <input className="sidebar-search" placeholder="Search history…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="history-list">
        {!connId && <div className="muted pad">Select a connection.</div>}
        {shown.map((h, i) => (
          <div key={h.ts + ':' + i} className={'history-item' + (h.ok ? '' : ' err')} onDoubleClick={() => onInsert(h.sql)} title="Double-click to insert into the editor">
            <div className="muted small">
              {new Date(h.ts).toLocaleString()} · {h.durationMs} ms{h.rows !== undefined ? ` · ${h.rows} rows` : ''}
              {h.source === 'ai' && <span className="badge">AI</span>}
            </div>
            <span className="history-actions" onDoubleClick={(e) => e.stopPropagation()}>
              <button onClick={() => copy(h.sql, i)} title="Copy the query to the clipboard">{copiedIdx === i ? 'Copied ✓' : 'Copy'}</button>
              <button onClick={() => onInsert(h.sql)} title="Insert at the cursor in the current editor">Insert</button>
            </span>
            <pre>{h.sql.length > 400 ? h.sql.slice(0, 400) + '…' : h.sql}</pre>
            {h.error && <div className="msg-err small">{h.error}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
