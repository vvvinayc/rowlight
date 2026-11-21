// Table details: overview + columns, indexes, foreign keys (both directions) and the CREATE statement.

import React, { useEffect, useState } from 'react';
import type { TableDetails } from '../../shared/types';
import { api, errorText, unwrap } from '../api';

interface Props {
  connId: string;
  database: string;
  table: string;
  onOpenSql(sql: string, title: string): void;
  onClose(): void;
}

type Tab = 'columns' | 'indexes' | 'fks' | 'ddl';

export function TableDetailsDialog({ connId, database, table, onOpenSql, onClose }: Props) {
  const [d, setD] = useState<TableDetails | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('columns');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    unwrap(api.meta.tableDetails(connId, database, table)).then(setD).catch((e) => setError(errorText(e)));
  }, [connId, database, table]);

  const fkOut = d?.foreignKeys.filter((f) => f.direction === 'out') ?? [];
  const fkIn = d?.foreignKeys.filter((f) => f.direction === 'in') ?? [];

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal details-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()} tabIndex={-1}>
        <h3>▦ {database}.{table}</h3>
        {error && <pre className="status-box err">{error}</pre>}
        {!d && !error && <div className="muted">Loading…</div>}
        {d && (
          <>
            <div className="details-info">
              {d.info.map((i) => <span key={i.label}><span className="muted">{i.label}:</span> {i.value}</span>)}
            </div>
            <div className="result-tabs">
              <button className={tab === 'columns' ? 'active' : ''} onClick={() => setTab('columns')}>Columns ({d.columns.length})</button>
              <button className={tab === 'indexes' ? 'active' : ''} onClick={() => setTab('indexes')}>Indexes ({d.indexes.length})</button>
              <button className={tab === 'fks' ? 'active' : ''} onClick={() => setTab('fks')}>Foreign keys ({d.foreignKeys.length})</button>
              <button className={tab === 'ddl' ? 'active' : ''} onClick={() => setTab('ddl')}>CREATE statement</button>
            </div>
            <div className="details-body">
              {tab === 'columns' && (
                <table className="details-table">
                  <thead><tr><th>Name</th><th>Type</th><th>Null</th><th>Key</th><th>Default</th><th>Extra</th><th>Comment</th></tr></thead>
                  <tbody>
                    {d.columns.map((c) => (
                      <tr key={c.name}>
                        <td><b>{c.key === 'PRI' ? '🔑 ' : ''}{c.name}</b></td><td>{c.type}</td><td>{c.nullable ? 'YES' : 'NO'}</td>
                        <td>{c.key}</td><td className={c.default === null ? 'muted' : ''}>{c.default ?? 'NULL'}</td><td>{c.extra}</td><td>{c.comment}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tab === 'indexes' && (
                d.indexes.length ? (
                  <table className="details-table">
                    <thead><tr><th>Name</th><th>Columns</th><th>Unique</th><th>Type</th></tr></thead>
                    <tbody>
                      {d.indexes.map((i) => (
                        <tr key={i.name}><td><b>{i.primary ? '🔑 ' : ''}{i.name}</b></td><td>{i.columns}</td><td>{i.unique ? 'YES' : ''}</td><td>{i.type}</td></tr>
                      ))}
                    </tbody>
                  </table>
                ) : <div className="muted pad">No indexes.</div>
              )}
              {tab === 'fks' && (
                <>
                  <div className="details-sub">This table → other tables</div>
                  {fkOut.length ? (
                    <table className="details-table">
                      <thead><tr><th>Name</th><th>Columns</th><th>References</th><th>On delete</th><th>On update</th></tr></thead>
                      <tbody>{fkOut.map((f) => <tr key={f.name}><td>{f.name}</td><td>{f.columns}</td><td>{f.refTable} ({f.refColumns})</td><td>{f.onDelete}</td><td>{f.onUpdate}</td></tr>)}</tbody>
                    </table>
                  ) : <div className="muted small pad">None.</div>}
                  <div className="details-sub">Other tables → this table</div>
                  {fkIn.length ? (
                    <table className="details-table">
                      <thead><tr><th>Name</th><th>Table</th><th>Columns</th><th>→ Columns here</th><th>On delete</th></tr></thead>
                      <tbody>{fkIn.map((f) => <tr key={f.name + f.table}><td>{f.name}</td><td>{f.table}</td><td>{f.columns}</td><td>{f.refColumns}</td><td>{f.onDelete}</td></tr>)}</tbody>
                    </table>
                  ) : <div className="muted small pad">None.</div>}
                </>
              )}
              {tab === 'ddl' && (
                <>
                  {d.ddlNote && <div className="muted small" style={{ marginBottom: 6 }}>{d.ddlNote}</div>}
                  <pre className="ddl">{d.ddl}</pre>
                </>
              )}
            </div>
          </>
        )}
        <div className="modal-actions">
          {d && tab === 'ddl' && (
            <>
              <button onClick={async () => { await api.copyText(d.ddl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied ✓' : 'Copy'}</button>
              <button onClick={() => { onOpenSql(d.ddl, `${table} (DDL)`); onClose(); }}>Open in editor</button>
            </>
          )}
          <span className="spacer" />
          <button className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
