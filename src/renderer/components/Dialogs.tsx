// Small modal dialogs: password prompt, SSH keyboard-interactive prompt, settings, confirm.

import React, { useState } from 'react';
import type { ConnectionConfig, Secrets, Settings, SshPromptRequest } from '../../shared/types';
import type { ThemePref } from '../theme';

/** What the prompt must ask for (the rest is saved). */
export interface PromptNeeds {
  db: boolean;
  /** SSH settings in use (the profile's when the connection uses one), or null when no SSH secret is needed. */
  ssh: { auth: 'password' | 'key'; user: string; host: string; profileName?: string } | null;
}

export function PasswordPrompt({ conn, needs, onSubmit, onCancel }: { conn: ConnectionConfig; needs: PromptNeeds; onSubmit(s: Secrets): void; onCancel(): void }) {
  const [s, setS] = useState<Secrets>({});
  const sshPw = needs.ssh?.auth === 'password';
  const sshKey = needs.ssh?.auth === 'key';
  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={(e) => { e.preventDefault(); onSubmit(s); }}>
        <h3>Connect to {conn.name}</h3>
        <div className="form">
          {sshPw && (
            <label>SSH password for {needs.ssh!.user}@{needs.ssh!.host}{needs.ssh!.profileName ? ` (profile “${needs.ssh!.profileName}”)` : ''}
              <input type="password" autoFocus value={s.sshPassword ?? ''} onChange={(e) => setS({ ...s, sshPassword: e.target.value })} />
            </label>
          )}
          {sshKey && (
            <label>SSH key passphrase (leave empty if none)
              <input type="password" autoFocus value={s.sshPassphrase ?? ''} onChange={(e) => setS({ ...s, sshPassphrase: e.target.value })} />
            </label>
          )}
          {needs.db && (
            <label>DB password for {conn.user}
              <input type="password" autoFocus={!needs.ssh} value={s.dbPassword ?? ''} onChange={(e) => setS({ ...s, dbPassword: e.target.value })} />
            </label>
          )}
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary">Connect</button>
        </div>
      </form>
    </div>
  );
}

export function SshPromptDialog({ req, onAnswer }: { req: SshPromptRequest; onAnswer(a: string[] | null): void }) {
  const [answers, setAnswers] = useState<string[]>(() => req.prompts.map(() => ''));
  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={(e) => { e.preventDefault(); onAnswer(answers); }}>
        <h3>SSH verification – {req.connectionName}</h3>
        {req.instructions && <p className="muted">{req.instructions}</p>}
        <div className="form">
          {req.prompts.map((p, i) => (
            <label key={i}>{p.prompt}
              <input type={p.echo ? 'text' : 'password'} autoFocus={i === 0} value={answers[i]}
                onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))} />
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={() => onAnswer(null)}>Cancel</button>
          <button type="submit" className="primary">Send</button>
        </div>
      </form>
    </div>
  );
}

export function SettingsDialog({ settings, theme, onTheme, onSave, onCancel }:
  { settings: Settings; theme: ThemePref; onTheme(t: ThemePref): void; onSave(s: Settings): void; onCancel(): void }) {
  const [limit, setLimit] = useState(String(settings.selectLimit));
  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={(e) => { e.preventDefault(); onSave({ selectLimit: Number(limit) || 0 }); }}>
        <h3>Settings</h3>
        <div className="form">
          <label>Theme
            <select value={theme} onChange={(e) => onTheme(e.target.value as ThemePref)}>
              <option value="system">System (follow Windows)</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>Auto-LIMIT for SELECT without LIMIT/TOP (0 = off)
            <input type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} autoFocus />
          </label>
          <p className="muted small">MySQL: “LIMIT n” is appended. SQL Server: “SET ROWCOUNT n” is used for read-only batches without TOP.</p>
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary">Save</button>
        </div>
      </form>
    </div>
  );
}

export function ConfirmDialog({ title, text, danger, okText, onOk, onCancel, alertOnly }:
  { title: string; text: string; danger?: boolean; okText?: string; onOk(): void; onCancel(): void; alertOnly?: boolean }) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{title}</h3>
        <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>
        <div className="modal-actions">
          <span className="spacer" />
          {!alertOnly && <button onClick={onCancel} autoFocus>Cancel</button>}
          <button className={danger ? 'danger' : 'primary'} onClick={onOk} autoFocus={alertOnly}>{okText ?? 'OK'}</button>
        </div>
      </div>
    </div>
  );
}
