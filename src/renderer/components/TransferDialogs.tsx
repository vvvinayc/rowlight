// Export / import connections.

import React, { useState } from 'react';
import type { ConnectionConfig } from '../../shared/types';
import { api, errorText, unwrap, type ImportPreview } from '../api';

export function ExportDialog({ connections, onDone, onCancel }:
  { connections: ConnectionConfig[]; onDone(msg: string): void; onCancel(): void }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(connections.map((c) => c.id)));
  const [withPw, setWithPw] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function doExport() {
    setError('');
    if (!picked.size) return setError('Select at least one connection.');
    if (withPw && pw.length < 8) return setError('The passphrase must be at least 8 characters.');
    if (withPw && pw !== pw2) return setError('The two passphrases are different.');
    setBusy(true);
    try {
      const file = await unwrap(api.connections.exportFile([...picked], withPw ? pw : null));
      if (file) onDone(`Exported ${picked.size} connection(s) to ${file}${withPw ? ' (passwords encrypted with your passphrase)' : ' (without passwords)'}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 560 }} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        <h3>Export connections</h3>
        <div className="pick-list">
          <label className="check-line">
            <input type="checkbox" checked={picked.size === connections.length}
              onChange={(e) => setPicked(e.target.checked ? new Set(connections.map((c) => c.id)) : new Set())} /> <b>All</b>
          </label>
          {connections.map((c) => (
            <label key={c.id} className="check-line">
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} /> {c.name}
              <span className="muted small">&nbsp;{c.type} · {c.user}@{c.host}{c.ssh.enabled ? (c.ssh.profileId ? ' via SSH profile' : ` via ${c.ssh.host}`) : ''}</span>
            </label>
          ))}
        </div>
        <div className="form" style={{ marginTop: 12 }}>
          <label className="check">
            <input type="checkbox" checked={withPw} onChange={(e) => setWithPw(e.target.checked)} /> Include saved passwords (encrypted with a passphrase)
          </label>
          {withPw ? (
            <div className="row2">
              <label className="grow">Passphrase (min. 8 characters)<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></label>
              <label className="grow">Repeat passphrase<input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
            </div>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>Without passwords the file is safe to give to colleagues: they enter their own passwords.</p>
          )}
          {withPw && <p className="muted small" style={{ margin: 0 }}>Use this to move your connections to a new PC. Keep the passphrase separate from the file.</p>}
        </div>
        {error && <pre className="status-box err">{error}</pre>}
        <div className="modal-actions">
          <span className="spacer" />
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={doExport} disabled={busy}>Export…</button>
        </div>
      </div>
    </div>
  );
}

export function ImportDialog({ preview, onDone, onCancel }:
  { preview: ImportPreview; onDone(msg: string): void; onCancel(): void }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function doImport(withPasswords: boolean) {
    setError('');
    setBusy(true);
    try {
      const r = await unwrap(api.connections.importFile(preview.filePath, withPasswords ? pw : null));
      onDone(`Imported ${r.imported.length} connection(s): ${r.imported.join(', ')}${withPasswords ? '' : ' (without passwords)'}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" style={{ width: 520 }} onSubmit={(e) => { e.preventDefault(); doImport(preview.encryptedPasswords); }}>
        <h3>Import {preview.names.length} connection{preview.names.length === 1 ? '' : 's'}</h3>
        <ul className="small" style={{ margin: '0 0 10px', paddingLeft: 18, maxHeight: 160, overflow: 'auto' }}>
          {preview.names.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
        <p className="muted small">Existing connections are not changed; a name that already exists gets “(2)”. Saved SSH host keys are not imported (they are checked again on first connect).</p>
        {preview.encryptedPasswords && (
          <div className="form">
            <label>This file contains passwords. Passphrase:
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
            </label>
          </div>
        )}
        {error && <pre className="status-box err">{error}</pre>}
        <div className="modal-actions">
          {preview.encryptedPasswords && <button type="button" onClick={() => doImport(false)} disabled={busy}>Import without passwords</button>}
          <span className="spacer" />
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || (preview.encryptedPasswords && !pw)}>Import</button>
        </div>
      </form>
    </div>
  );
}
