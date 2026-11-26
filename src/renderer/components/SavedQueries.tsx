// Saved queries: "☆ Save" in a query tab asks for a name; Ctrl+P (or ★ Saved) finds one by typing a few words.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { deleteSaved, markUsed, onSavedChange, saveQuery, searchSaved, suggestName, updateSaved, type SavedQuery } from '../savedQueries';

export function SaveQueryDialog({ sql, connName, onClose, onStatus }: { sql: string; connName: string; onClose(): void; onStatus(m: string): void }) {
  const [name, setName] = useState(() => suggestName(sql));
  const exists = useMemo(() => searchSaved('').some((q) => q.name.toLowerCase() === name.trim().toLowerCase()), [name]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal save-query" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          saveQuery(name.trim(), sql, connName);
          onStatus(`Saved query "${name.trim()}". Ctrl+P finds it.`);
          onClose();
        }}>
        <h3>☆ Save query</h3>
        <label className="muted small">Name (you find it later by typing a few words of the name or the SQL)</label>
        <input autoFocus value={name} onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
        <pre className="saved-sql">{sql.trim()}</pre>
        <div className="modal-actions">
          {exists && <span className="muted small">A saved query with this name exists: it will be replaced.</span>}
          <span className="spacer" />
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!name.trim()}>{exists ? 'Replace' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

interface PaletteProps {
  connName: string | null;
  onClose(): void;
  /** Opens the SQL in a new tab of the current connection; run = also run it. */
  onOpen(q: SavedQuery, run: boolean): void;
  onInsert(q: SavedQuery): void;
}

export function SavedQueriesDialog({ connName, onClose, onOpen, onInsert }: PaletteProps) {
  const [q, setQ] = useState('');
  const [version, setVersion] = useState(0);
  const [pick, setPick] = useState(0);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => onSavedChange(() => setVersion((v) => v + 1)), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => searchSaved(q), [q, version]);
  useEffect(() => setPick(0), [q]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.querySelector('.saved-item.picked')?.scrollIntoView({ block: 'nearest' }); }, [pick]);
  const cur = list[Math.min(pick, list.length - 1)];
  const open = (item: SavedQuery | undefined, run: boolean) => { if (!item) return; markUsed(item.id); onOpen(item, run); onClose(); };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal saved-queries" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (renaming) return;
          if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => Math.min(list.length - 1, p + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => Math.max(0, p - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); open(cur, e.ctrlKey); }
        }}>
        <h3>★ Saved queries</h3>
        <input autoFocus className="shortcuts-search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Type a few words of the name or the SQL…" />
        <div className="saved-list" ref={listRef}>
          {list.length === 0 && (
            <div className="muted pad">{q ? `No saved query matches “${q}”.` : 'No saved queries yet. In a query tab, put the cursor in a query and click ☆ Save.'}</div>
          )}
          {list.map((item, i) => (
            <div key={item.id} className={'saved-item' + (item === cur ? ' picked' : '')}
              onMouseEnter={() => setPick(i)} onDoubleClick={() => open(item, false)}>
              <div className="saved-head">
                {renaming?.id === item.id ? (
                  <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter' && renaming.name.trim()) { updateSaved(item.id, { name: renaming.name.trim() }); setRenaming(null); }
                      if (e.key === 'Escape') setRenaming(null);
                    }} onBlur={() => setRenaming(null)} />
                ) : <b>{item.name}</b>}
                <span className="muted small">{item.connName ? item.connName + ' · ' : ''}{item.uses ? `used ${item.uses}×` : 'not used yet'}</span>
                <span className="spacer" />
                <span className="saved-actions">
                  <button title="Open in a new tab and run it (Ctrl+Enter)" onClick={() => open(item, true)}>▶ Run</button>
                  <button title="Open in a new tab (Enter)" onClick={() => open(item, false)}>Open</button>
                  <button title="Insert at the cursor in the current tab" onClick={() => { markUsed(item.id); onInsert(item); onClose(); }}>Insert</button>
                  <button title="Rename" onClick={() => setRenaming({ id: item.id, name: item.name })}>✎</button>
                  <button title="Delete" onClick={() => { if (window.confirm(`Delete the saved query "${item.name}"?`)) deleteSaved(item.id); }}>🗑</button>
                </span>
              </div>
              <pre className="saved-sql">{item.sql.trim().split('\n').slice(0, 4).join('\n')}{item.sql.trim().split('\n').length > 4 ? '\n…' : ''}</pre>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <span className="muted small">↑↓ pick · Enter: open in a new {connName ?? ''} tab · Ctrl+Enter: open and run · double-click: open</span>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
