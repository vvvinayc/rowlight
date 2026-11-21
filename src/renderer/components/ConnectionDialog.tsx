// Add / edit a connection, with "Test connection".

import React, { useState } from 'react';
import type { ConnectionConfig, Secrets, SshProfile } from '../../shared/types';
import { CONNECTION_COLORS, DEFAULT_PORTS, defaultColorForName, defaultReadOnlyForName } from '../../shared/defaults';
import { api, ApiError, errorText, unwrap } from '../api';

interface Props {
  initial?: ConnectionConfig;
  /** Saved SSH profiles (bastions shared by many connections). */
  profiles: SshProfile[];
  onManageProfiles(selectId?: string): void;
  onProfilesChanged(): Promise<void> | void;
  onClose: () => void;
  onSaved: (c: ConnectionConfig) => void;
}

/** A new connection uses the default SSH profile, if there is one. */
function blank(def?: SshProfile): ConnectionConfig {
  return {
    id: '', name: '', type: 'mysql', host: '', port: 3306, database: '', user: '',
    readOnly: false, askPassword: false,
    ssh: { enabled: !!def, host: '', port: 22, user: '', auth: 'password', profileId: def?.id },
    mssqlEncrypt: true, mssqlTrustCert: true,
  };
}

export function ConnectionDialog({ initial, profiles, onManageProfiles, onProfilesChanged, onClose, onSaved }: Props) {
  const [c, setC] = useState<ConnectionConfig>(() => (initial ? structuredClone(initial) : blank(profiles.find((p) => p.isDefault))));
  const profile = c.ssh.enabled && c.ssh.profileId ? profiles.find((p) => p.id === c.ssh.profileId) : undefined;
  const [secrets, setSecrets] = useState<Secrets>({});
  const [readOnlyTouched, setReadOnlyTouched] = useState(!!initial);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'busy'; text: string } | null>(null);

  const set = (patch: Partial<ConnectionConfig>) => setC((x) => ({ ...x, ...patch }));
  const setSsh = (patch: Partial<ConnectionConfig['ssh']>) => setC((x) => ({ ...x, ssh: { ...x.ssh, ...patch } }));
  const saved = initial?.hasSaved;

  function onName(name: string) {
    set(readOnlyTouched ? { name } : { name, readOnly: defaultReadOnlyForName(name), color: defaultColorForName(name) });
  }

  function validate(): string | null {
    if (!c.name.trim()) return 'Name is required.';
    if (!c.host.trim()) return 'DB host is required.';
    if (!c.user.trim()) return 'DB user is required.';
    if (c.ssh.enabled && c.ssh.profileId) {
      if (!profile) return 'The selected SSH profile no longer exists. Pick another one (or Custom).';
    } else {
      if (c.ssh.enabled && (!c.ssh.host.trim() || !c.ssh.user.trim())) return 'SSH host and SSH user are required.';
      if (c.ssh.enabled && c.ssh.auth === 'key' && !c.ssh.keyPath) return 'Choose an SSH private key file.';
    }
    return null;
  }

  async function test() {
    const v = validate();
    if (v) return setStatus({ kind: 'err', text: v });
    setStatus({ kind: 'busy', text: 'Connecting…' });
    try {
      const r = await unwrap(api.connections.test(c, secrets));
      setStatus({ kind: 'ok', text: `Connected. Server: ${r.version}${r.fingerprint ? `\nSSH host key: ${r.fingerprint}` : ''}` });
    } catch (e) {
      const kind = e instanceof ApiError ? e.error.kind : 'unknown';
      const label: Record<string, string> = {
        'ssh-auth': 'SSH password / key problem', 'ssh-unreachable': 'SSH host unreachable', 'ssh-hostkey': 'SSH host key changed',
        'ssh-key': 'SSH key problem', 'ssh-forward': 'Bastion cannot reach DB', 'db-auth': 'DB password / user problem',
        'db-unreachable': 'DB unreachable', 'db-unknown-database': 'Unknown database',
      };
      setStatus({ kind: 'err', text: `${label[kind] ? label[kind] + ': ' : ''}${errorText(e)}` });
    }
  }

  async function save() {
    const v = validate();
    if (v) return setStatus({ kind: 'err', text: v });
    try {
      // Empty password fields mean "keep the saved one".
      const typed: Secrets = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v));
      onSaved(await unwrap(api.connections.save(c, typed)));
    } catch (e) {
      setStatus({ kind: 'err', text: errorText(e) });
    }
  }

  async function saveAsProfile() {
    if (!c.ssh.host.trim() || !c.ssh.user.trim()) return setStatus({ kind: 'err', text: 'Fill in SSH host and SSH user first.' });
    try {
      const p = await unwrap(api.ssh.saveProfile({
        id: '', name: `${c.ssh.user}@${c.ssh.host}`, host: c.ssh.host, port: c.ssh.port || 22, user: c.ssh.user, auth: c.ssh.auth,
        keyPath: c.ssh.keyPath, askPassword: c.askPassword, isDefault: !profiles.length,
      }, Object.fromEntries(Object.entries({ sshPassword: secrets.sshPassword, sshPassphrase: secrets.sshPassphrase }).filter(([, v]) => v))));
      await onProfilesChanged();
      setSsh({ profileId: p.id });
      setStatus({ kind: 'ok', text: `Saved as SSH profile "${p.name}"${p.isDefault ? ' (default)' : ''}. Other connections can now pick it too. Rename it under "Manage SSH profiles".` });
    } catch (e) {
      setStatus({ kind: 'err', text: errorText(e) });
    }
  }

  async function pickKey() {
    const p = await unwrap(api.connections.pickKeyFile()).catch(() => null);
    if (p) setSsh({ keyPath: p });
  }

  async function forgetHostKey() {
    if (!initial) return;
    await unwrap(api.connections.forgetHostKey(initial.id));
    setSsh({ hostFingerprint: undefined });
    setStatus({ kind: 'ok', text: 'Host key forgotten. The next connection will trust and remember the new key.' });
  }

  const pwPlaceholder = (has?: boolean) => (c.askPassword ? 'only used for Test, not saved' : has ? '•••••• saved (leave empty to keep)' : '');

  return (
    <div className="modal-backdrop">
      <div className="modal conn-dialog" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h3>{initial ? 'Edit connection' : 'New connection'}</h3>
        <div className="form">
          <label>Name<input autoFocus value={c.name} onChange={(e) => onName(e.target.value)} placeholder="e.g. orders-prod" /></label>
          <label>Type
            <select value={c.type} onChange={(e) => {
              const type = e.target.value as ConnectionConfig['type'];
              set({ type, port: c.port === DEFAULT_PORTS[c.type] ? DEFAULT_PORTS[type] : c.port });
            }}>
              <option value="mysql">MySQL / MariaDB</option>
              <option value="mssql">SQL Server</option>
            </select>
          </label>
          <div className="row2">
            <label className="grow">DB host<input value={c.host} onChange={(e) => set({ host: e.target.value })} placeholder={c.ssh.enabled ? 'as seen from the bastion, e.g. 10.0.1.20' : 'host or IP'} /></label>
            <label className="port">Port<input type="number" value={c.port} onChange={(e) => set({ port: Number(e.target.value) })} /></label>
          </div>
          <label>Database (optional)<input value={c.database} onChange={(e) => set({ database: e.target.value })} /></label>
          <div className="row2">
            <label className="grow">DB user<input value={c.user} onChange={(e) => set({ user: e.target.value })} /></label>
            <label className="grow">DB password
              <input type="password" placeholder={pwPlaceholder(saved?.dbPassword)}
                value={secrets.dbPassword ?? ''} onChange={(e) => setSecrets((s) => ({ ...s, dbPassword: e.target.value }))} />
            </label>
          </div>
          {c.type === 'mssql' && (
            <div className="checks">
              <label className="check"><input type="checkbox" checked={c.mssqlEncrypt ?? true} onChange={(e) => set({ mssqlEncrypt: e.target.checked })} /> Encrypt</label>
              <label className="check"><input type="checkbox" checked={c.mssqlTrustCert ?? true} onChange={(e) => set({ mssqlTrustCert: e.target.checked })} /> Trust server certificate</label>
            </div>
          )}
          <div className="checks">
            <label className="check"><input type="checkbox" checked={c.askPassword} onChange={(e) => set({ askPassword: e.target.checked })} /> Ask password every time (nothing saved)</label>
            <label className={'check' + (c.readOnly ? ' ro-on' : '')}>
              <input type="checkbox" checked={c.readOnly} onChange={(e) => { setReadOnlyTouched(true); set({ readOnly: e.target.checked }); }} /> Read-only
            </label>
          </div>

          <div className="color-row">
            <span className="muted small">Colour</span>
            <button type="button" className={'swatch none' + (!c.color ? ' picked' : '')} title="No colour" onClick={() => set({ color: undefined })}>∅</button>
            {Object.entries(CONNECTION_COLORS).map(([name, hex]) => (
              <button type="button" key={name} title={name} className={'swatch' + (c.color === name ? ' picked' : '')}
                style={{ background: hex }} onClick={() => set({ color: name })} />
            ))}
            <span className="muted small">shown on tabs and the toolbar (tip: red for prod / DR)</span>
          </div>

          <fieldset>
            <legend><label className="check"><input type="checkbox" checked={c.ssh.enabled} onChange={(e) => setSsh({ enabled: e.target.checked })} /> SSH tunnel (bastion)</label></legend>
            {c.ssh.enabled && (
              <div className="row2">
                <label className="grow">Use
                  <select value={c.ssh.profileId && profile ? c.ssh.profileId : 'custom'}
                    onChange={(e) => setSsh({ profileId: e.target.value === 'custom' ? undefined : e.target.value })}>
                    {profiles.map((p) => <option key={p.id} value={p.id}>🔐 {p.name}{p.isDefault ? ' (default)' : ''}: {p.user}@{p.host}</option>)}
                    <option value="custom">✎ Custom (only for this connection)</option>
                  </select>
                </label>
                <button className="align-end" onClick={() => onManageProfiles(profile?.id)}>Manage SSH profiles…</button>
              </div>
            )}
            {c.ssh.enabled && profile && (
              <div className="profile-summary small">
                <div><b>{profile.user}@{profile.host}:{profile.port}</b> · {profile.auth === 'key' ? 'private key' : 'password'}
                  {profile.askPassword ? ' · asked every time' : profile.hasSaved?.sshPassword || profile.hasSaved?.sshPassphrase ? ' · saved' : ''}</div>
                <div className="muted">SSH password / key and the trusted host key come from the profile. Change them once in “Manage SSH profiles” for all connections that use it.</div>
              </div>
            )}
            {c.ssh.enabled && !profile && (
              <>
                <div className="row2">
                  <label className="grow">SSH host<input value={c.ssh.host} onChange={(e) => setSsh({ host: e.target.value })} /></label>
                  <label className="port">Port<input type="number" value={c.ssh.port} onChange={(e) => setSsh({ port: Number(e.target.value) })} /></label>
                </div>
                <div className="row2">
                  <label className="grow">SSH user<input value={c.ssh.user} onChange={(e) => setSsh({ user: e.target.value })} /></label>
                  <label className="grow">Auth
                    <select value={c.ssh.auth} onChange={(e) => setSsh({ auth: e.target.value as 'password' | 'key' })}>
                      <option value="password">Password (also keyboard-interactive)</option>
                      <option value="key">Private key file</option>
                    </select>
                  </label>
                </div>
                {c.ssh.auth === 'password' ? (
                  <label>SSH password
                    <input type="password" placeholder={pwPlaceholder(saved?.sshPassword)}
                      value={secrets.sshPassword ?? ''} onChange={(e) => setSecrets((s) => ({ ...s, sshPassword: e.target.value }))} />
                  </label>
                ) : (
                  <>
                    <div className="row2">
                      <label className="grow">Private key file<input value={c.ssh.keyPath ?? ''} onChange={(e) => setSsh({ keyPath: e.target.value })} placeholder="C:\Users\you\.ssh\id_rsa" /></label>
                      <button className="align-end" onClick={pickKey}>Browse…</button>
                    </div>
                    <label>Key passphrase (if the key is encrypted)
                      <input type="password" placeholder={pwPlaceholder(saved?.sshPassphrase)}
                        value={secrets.sshPassphrase ?? ''} onChange={(e) => setSecrets((s) => ({ ...s, sshPassphrase: e.target.value }))} />
                    </label>
                  </>
                )}
                {c.ssh.hostFingerprint && (
                  <div className="muted small">Trusted host key: {c.ssh.hostFingerprint}{' '}
                    {initial && <button className="link" onClick={forgetHostKey}>Forget host key</button>}
                  </div>
                )}
                <div><button className="link" onClick={saveAsProfile}>💾 Save these SSH settings as a profile (to reuse in other connections)</button></div>
              </>
            )}
          </fieldset>
        </div>

        {status && <pre className={'status-box ' + status.kind}>{status.text}</pre>}

        <div className="modal-actions">
          <button onClick={test} disabled={status?.kind === 'busy'}>Test connection</button>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
