// Manage saved SSH profiles (bastions shared by many connections).

import React, { useEffect, useRef, useState } from 'react';
import type { Secrets, SshProfile } from '../../shared/types';
import { api, errorText, unwrap } from '../api';

interface Props {
  profiles: SshProfile[];
  /** Open with this profile selected (or "new"). */
  initialId?: string | 'new';
  onChanged(selectId?: string): Promise<void> | void;
  onClose(): void;
}

/** Password auth, not 'ask every time', but nothing saved → the bastion will prompt on every connect. */
const noSecret = (p: SshProfile) => !p.askPassword && p.auth === 'password' && !!p.id && !p.hasSaved?.sshPassword;

const blank = (isDefault: boolean): SshProfile => ({
  id: '', name: '', host: '', port: 22, user: '', auth: 'password', askPassword: false, isDefault,
});

export function SshProfilesDialog({ profiles, initialId, onChanged, onClose }: Props) {
  const [selId, setSelId] = useState<string | 'new'>(initialId ?? profiles[0]?.id ?? 'new');
  const current = selId === 'new' ? undefined : profiles.find((p) => p.id === selId);
  const [p, setP] = useState<SshProfile>(() => current ? structuredClone(current) : blank(!profiles.length));
  const [secrets, setSecrets] = useState<Secrets>({});
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'busy'; text: string } | null>(null);
  const [usage, setUsage] = useState<string[]>([]);

  // Switching to another profile resets the form; a reload of the same profile (after Save/Test)
  // keeps the status message and only refreshes what the main process changed.
  const shownId = useRef<string | 'new' | null>(null);
  useEffect(() => {
    const cur = selId === 'new' ? undefined : profiles.find((x) => x.id === selId);
    if (shownId.current !== selId) {
      shownId.current = selId;
      setP(cur ? structuredClone(cur) : blank(!profiles.length));
      setSecrets({});
      setStatus(null);
    } else if (cur) {
      setP((x) => ({ ...x, hasSaved: cur.hasSaved, hostFingerprint: cur.hostFingerprint, isDefault: cur.isDefault }));
      setSecrets({});
    }
    if (cur) unwrap(api.ssh.profileUsage(cur.id)).then(setUsage).catch(() => setUsage([]));
    else setUsage([]);
  }, [selId, profiles]);

  const set = (patch: Partial<SshProfile>) => setP((x) => ({ ...x, ...patch }));
  const pwPlaceholder = (has?: boolean) => (p.askPassword ? 'only used for Test, not saved' : has ? '•••••• saved (leave empty to keep)' : '');

  function validate(): string | null {
    if (!p.name.trim()) return 'Give the profile a name, e.g. "Prod bastion".';
    if (!p.host.trim() || !p.user.trim()) return 'SSH host and SSH user are required.';
    if (p.auth === 'key' && !p.keyPath) return 'Choose an SSH private key file.';
    return null;
  }

  async function save() {
    const v = validate();
    if (v) return setStatus({ kind: 'err', text: v });
    try {
      const typed: Secrets = Object.fromEntries(Object.entries(secrets).filter(([, x]) => x));
      const saved = await unwrap(api.ssh.saveProfile(p, typed));
      shownId.current = saved.id; // same profile stays shown: keep the status message below
      setSelId(saved.id);
      await onChanged(saved.id);
      setStatus({ kind: 'ok', text: `Saved.${usage.length ? ` ${usage.length} connection(s) use this profile and will use the new settings next time they connect.` : ''}` });
    } catch (e) {
      setStatus({ kind: 'err', text: errorText(e) });
    }
  }

  async function test() {
    const v = validate();
    if (v) return setStatus({ kind: 'err', text: v });
    setStatus({ kind: 'busy', text: 'Logging in to the bastion…' });
    try {
      const r = await unwrap(api.ssh.testProfile(p, secrets));
      setStatus({ kind: 'ok', text: `SSH login OK.\nHost key: ${r.fingerprint}` });
      if (p.id) await onChanged(p.id); // the host key may have been remembered
    } catch (e) {
      setStatus({ kind: 'err', text: errorText(e) });
    }
  }

  async function remove() {
    if (!current) return;
    if (!window.confirm(`Delete the SSH profile "${current.name}"?`)) return;
    try {
      await unwrap(api.ssh.deleteProfile(current.id));
      await onChanged();
      setSelId('new');
    } catch (e) {
      setStatus({ kind: 'err', text: errorText(e) });
    }
  }

  async function pickKey() {
    const path = await unwrap(api.connections.pickKeyFile()).catch(() => null);
    if (path) set({ keyPath: path });
  }

  return (
    <div className="modal-backdrop">
      <div className="modal ssh-profiles" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h3>🔐 SSH profiles <span className="muted small">save a bastion once, use it in many connections</span></h3>
        <div className="sp-body">
          <div className="sp-list">
            {profiles.map((x) => (
              <div key={x.id} className={'sp-item' + (selId === x.id ? ' active' : '')} onClick={() => setSelId(x.id)}>
                <div><b>{x.name}</b>{x.isDefault && <span className="badge def">default</span>}</div>
                <div className="muted small">{x.user}@{x.host}:{x.port}</div>
                {noSecret(x) && <div className="warn-note small">⚠ no password saved</div>}
              </div>
            ))}
            <button className={'sp-new' + (selId === 'new' ? ' active' : '')} onClick={() => setSelId('new')}>+ New SSH profile</button>
          </div>

          <div className="sp-form form">
            <label>Profile name<input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Prod bastion" autoFocus /></label>
            <div className="row2">
              <label className="grow">SSH host<input value={p.host} onChange={(e) => set({ host: e.target.value })} placeholder="bastion.example.com" /></label>
              <label className="port">Port<input type="number" value={p.port} onChange={(e) => set({ port: Number(e.target.value) })} /></label>
            </div>
            <div className="row2">
              <label className="grow">SSH user<input value={p.user} onChange={(e) => set({ user: e.target.value })} /></label>
              <label className="grow">Auth
                <select value={p.auth} onChange={(e) => set({ auth: e.target.value as 'password' | 'key' })}>
                  <option value="password">Password (also keyboard-interactive)</option>
                  <option value="key">Private key file</option>
                </select>
              </label>
            </div>
            {p.auth === 'password' ? (
              <label>SSH password
                <input type="password" placeholder={pwPlaceholder(p.hasSaved?.sshPassword)} value={secrets.sshPassword ?? ''}
                  onChange={(e) => setSecrets((s) => ({ ...s, sshPassword: e.target.value }))} />
              </label>
            ) : (
              <>
                <div className="row2">
                  <label className="grow">Private key file<input value={p.keyPath ?? ''} onChange={(e) => set({ keyPath: e.target.value })} /></label>
                  <button className="align-end" onClick={pickKey}>Browse…</button>
                </div>
                <label>Key passphrase (if the key is encrypted)
                  <input type="password" placeholder={pwPlaceholder(p.hasSaved?.sshPassphrase)} value={secrets.sshPassphrase ?? ''}
                    onChange={(e) => setSecrets((s) => ({ ...s, sshPassphrase: e.target.value }))} />
                </label>
              </>
            )}
            {current && noSecret(p) && !secrets.sshPassword && !secrets.sshPassphrase && (
              <div className="warn-note small">⚠ No SSH {p.auth === 'key' ? 'key passphrase' : 'password'} is saved in this profile, so the bastion will ask for it on every connect. Type it above and click Save (or tick “Ask SSH password every time” if that is what you want).</div>
            )}
            <div className="checks">
              <label className="check"><input type="checkbox" checked={p.askPassword} onChange={(e) => set({ askPassword: e.target.checked })} /> Ask SSH password every time</label>
              <label className="check"><input type="checkbox" checked={p.isDefault} onChange={(e) => set({ isDefault: e.target.checked })} /> Default for new connections</label>
            </div>
            {p.hostFingerprint && (
              <div className="muted small">Trusted host key: {p.hostFingerprint}{' '}
                <button className="link" onClick={async () => { await api.ssh.forgetProfileHostKey(p.id); await onChanged(p.id); }}>Forget host key</button>
              </div>
            )}
            {current && (
              <div className="muted small">
                {usage.length ? <>Used by {usage.length} connection{usage.length === 1 ? '' : 's'}: {usage.join(', ')}</> : 'Not used by any connection yet.'}
              </div>
            )}
          </div>
        </div>

        {status && <pre className={'status-box ' + status.kind}>{status.text}</pre>}
        <div className="modal-actions">
          <button onClick={test} disabled={status?.kind === 'busy'}>Test SSH login</button>
          {current && <button className="danger" onClick={remove} disabled={usage.length > 0} title={usage.length ? 'Used by connections: switch them first' : ''}>Delete</button>}
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
          <button className="primary" onClick={save}>{current ? 'Save' : 'Create profile'}</button>
        </div>
      </div>
    </div>
  );
}
