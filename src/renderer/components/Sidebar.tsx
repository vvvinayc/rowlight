// Left sidebar: connections, and for connected ones a databases > tables > columns tree.

import React, { useEffect, useReducer, useRef, useState } from 'react';
import type { ConnectionConfig, SessionInfo } from '../../shared/types';
import { colorOf } from '../../shared/defaults';
import { errorText } from '../api';
import { metaCache, subscribe } from '../metaCache';

interface Props {
  connections: ConnectionConfig[];
  sessions: Record<string, SessionInfo>;
  connecting: Record<string, boolean>;
  shared: Record<string, unknown>;
  activeConnId: string | null;
  onSelect(id: string): void;
  onConnect(id: string): void;
  onDisconnect(id: string): void;
  onNew(): void;
  onImport(): void;
  onExport(): void;
  onEdit(c: ConnectionConfig): void;
  onDelete(c: ConnectionConfig): void;
  onNewTab(id: string): void;
  onOpenTable(connId: string, db: string, table: string): void;
  onTableDetails(connId: string, db: string, table: string): void;
  onInsert(text: string): void;
}

export function Sidebar(p: Props) {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => subscribe(rerender), []);

  const q = search.trim().toLowerCase();
  // Searching looks through every database, so load all table lists once (one metadata query).
  useEffect(() => {
    if (!q) return;
    for (const id of Object.keys(p.sessions)) metaCache.allTables(id).catch(() => {});
  }, [!!q, p.sessions]);

  // Auto-open the connection + default database when a session starts.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const id of [...seen.current]) if (!p.sessions[id]) seen.current.delete(id);
    for (const s of Object.values(p.sessions)) {
      if (seen.current.has(s.connectionId)) continue;
      seen.current.add(s.connectionId);
      const key = 'c:' + s.connectionId;
      setOpen((o) => new Set(o).add(key).add(`d:${s.connectionId}:${s.currentDatabase}`));
      setErrors((x) => ({ ...x, [key]: '' }));
      metaCache.databases(s.connectionId).catch((e) => setErrors((x) => ({ ...x, [key]: errorText(e) })));
      if (s.currentDatabase) metaCache.tables(s.connectionId, s.currentDatabase).catch(() => {});
    }
  }, [p.sessions]);

  function toggle(key: string, load?: () => Promise<unknown>) {
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else {
        n.add(key);
        load?.().catch((e) => setErrors((x) => ({ ...x, [key]: errorText(e) })));
      }
      return n;
    });
  }

  function refresh(connId: string) {
    metaCache.clear(connId);
    metaCache.databases(connId).catch(() => {});
    for (const key of open) {
      const m = key.match(/^d:([^:]+):(.*)$/);
      if (m && m[1] === connId) metaCache.tables(connId, m[2]).catch(() => {});
    }
  }

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <strong>Connections</strong>
        <span className="spacer" />
        <button title="Import connections from a file" onClick={p.onImport}>Import</button>
        <button title="Export connections to a file" onClick={p.onExport} disabled={!p.connections.length}>Export</button>
        <button title="New connection" onClick={p.onNew}>+ New</button>
      </div>
      <input className="sidebar-search" placeholder="Search tables in all databases…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="tree">
        {p.connections.length === 0 && <div className="muted pad">No connections yet. Click “+ New”.</div>}
        {p.connections.map((c) => {
          const s = p.sessions[c.id];
          const ckey = 'c:' + c.id;
          const isOpen = !!s && open.has(ckey);
          const dbs = s ? metaCache.peekDatabases(c.id) : undefined;
          return (
            <div key={c.id}>
              <div className={'node conn' + (p.activeConnId === c.id ? ' active' : '')}
                style={{ boxShadow: colorOf(c) ? `inset 4px 0 0 ${colorOf(c)}` : undefined }}
                onClick={() => { p.onSelect(c.id); if (s) toggle(ckey); }}
                onDoubleClick={() => !s && p.onConnect(c.id)}>
                <span className={'dot ' + (s ? 'on' : p.connecting[c.id] ? 'busy' : 'off')} />
                <span className="label" title={`${c.type} · ${c.user}@${c.host}:${c.port}${c.ssh.enabled ? (c.ssh.profileId ? ' via SSH profile' : ' via ' + c.ssh.host) : ''}`}>{c.name}</span>
                {c.readOnly && <span className="badge ro" title="Read-only">RO</span>}
                {!!p.shared[c.id] && <span className="badge ai" title="Shared with Claude (read-only MCP server running)">✦ AI</span>}
                <span className="node-actions" onClick={(e) => e.stopPropagation()}>
                  {s ? (
                    <>
                      <button title={`New query tab for ${c.name}`} onClick={() => p.onNewTab(c.id)}>SQL</button>
                      <button title="Refresh metadata" onClick={() => refresh(c.id)}>⟳</button>
                      <button title="Disconnect" onClick={() => p.onDisconnect(c.id)}>⏏</button>
                    </>
                  ) : (
                    <button title="Connect" disabled={p.connecting[c.id]} onClick={() => p.onConnect(c.id)}>{p.connecting[c.id] ? '…' : 'Connect'}</button>
                  )}
                  <button title="Edit" onClick={() => p.onEdit(c)}>✎</button>
                  <button title="Delete" onClick={() => p.onDelete(c)}>🗑</button>
                </span>
              </div>
              {isOpen && errors[ckey] && <div className="node err" style={{ paddingLeft: 24 }}>{errors[ckey]}</div>}
              {isOpen && dbs?.map((db) => {
                const dkey = `d:${c.id}:${db}`;
                const dbOpen = open.has(dkey);
                const tables = metaCache.peekTables(c.id, db);
                const shown = q ? tables?.filter((t) => t.name.toLowerCase().includes(q)) : tables;
                if (q && !db.toLowerCase().includes(q) && !(shown && shown.length)) return null;
                return (
                  <div key={dkey}>
                    <div className="node db" style={{ paddingLeft: 20 }} onClick={() => toggle(dkey, () => metaCache.tables(c.id, db))}>
                      <span className="twisty">{dbOpen || (q && shown?.length) ? '▾' : '▸'}</span>
                      <span className="icon">🛢</span>
                      <span className="label">{db}</span>
                      {s.currentDatabase === db && <span className="badge">default</span>}
                      {tables && <span className="muted small">{q ? `${shown?.length}/` : ''}{tables.length}</span>}
                    </div>
                    {errors[dkey] && <div className="node err" style={{ paddingLeft: 40 }}>{errors[dkey]}</div>}
                    {(dbOpen || (q && shown?.length)) && !tables && <div className="node muted" style={{ paddingLeft: 40 }}>Loading…</div>}
                    {(dbOpen || (q && shown?.length)) && shown?.map((t) => {
                      const tkey = `t:${c.id}:${db}:${t.name}`;
                      const tOpen = open.has(tkey);
                      const cols = metaCache.peekColumns(c.id, db, t.name);
                      return (
                        <div key={tkey}>
                          <div className="node table" style={{ paddingLeft: 36 }}
                            onClick={() => toggle(tkey, () => metaCache.columns(c.id, db, t.name))}
                            onDoubleClick={() => p.onOpenTable(c.id, db, t.name)}
                            title="Click: columns · Double-click: SELECT top rows · Right-click: insert name">
                            <span className="twisty">{tOpen ? '▾' : '▸'}</span>
                            <span className="icon">{t.kind === 'view' ? '👁' : '▦'}</span>
                            <span className="label" onContextMenu={(e) => { e.preventDefault(); p.onInsert(t.name); }}>{t.name}</span>
                            <button className="info-btn" title="Table details: columns, indexes, foreign keys, CREATE statement"
                              onClick={(e) => { e.stopPropagation(); p.onTableDetails(c.id, db, t.name); }}
                              onDoubleClick={(e) => e.stopPropagation()}>ⓘ</button>
                          </div>
                          {errors[tkey] && <div className="node err" style={{ paddingLeft: 56 }}>{errors[tkey]}</div>}
                          {tOpen && !cols && <div className="node muted" style={{ paddingLeft: 56 }}>Loading…</div>}
                          {tOpen && cols?.map((col) => (
                            <div key={col.name} className="node col" style={{ paddingLeft: 56 }} onDoubleClick={() => p.onInsert(col.name)} title="Double-click to insert">
                              <span className="icon">{col.key === 'PRI' ? '🔑' : '·'}</span>
                              <span className="label">{col.name}</span>
                              <span className="muted small">{col.type}{col.nullable ? '' : ' not null'}</span>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
