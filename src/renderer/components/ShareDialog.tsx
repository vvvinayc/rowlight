// "Share with Claude": start/stop the local read-only MCP server for one connection,
// connect it to the Claude desktop app (one-time), or show the Claude Code command.

import React, { useEffect, useState } from 'react';
import type { ConnectionConfig, McpShareInfo } from '../../shared/types';
import { api, errorText, unwrap, type CodeStatus, type DesktopStatus } from '../api';
import { defaultReadOnlyForName } from '../../shared/defaults';

interface Props {
  conn: ConnectionConfig;
  info?: McpShareInfo;
  onStart(): Promise<void>;
  onStop(): Promise<void>;
  onClose(): void;
}

export function ShareDialog({ conn, info, onStart, onStop, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const [desktop, setDesktop] = useState<DesktopStatus | null>(null);
  const [justAdded, setJustAdded] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState<CodeStatus | null>(null);
  const [codeJustAdded, setCodeJustAdded] = useState(false);
  // PROD / DR (by name, or coloured red): results leave this PC, so ask for an explicit OK first.
  const looksProd = defaultReadOnlyForName(conn.name) || conn.color === 'red';
  const [ack, setAck] = useState(false);

  useEffect(() => {
    unwrap(api.mcp.desktopStatus(conn.id)).then(setDesktop).catch(() => setDesktop(null));
    unwrap(api.mcp.codeStatus(conn.id)).then(setCode).catch(() => setCode(null));
  }, [conn.id]);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function copy(text: string, what: string) {
    await api.copyText(text);
    setCopied(what);
    setTimeout(() => setCopied(''), 1500);
  }

  const addDesktop = () => act(async () => {
    setDesktop(await unwrap(api.mcp.addDesktop(conn.id)));
    setJustAdded(true);
  });
  const addCode = () => act(async () => {
    setCode(await unwrap(api.mcp.addCode(conn.id)));
    setCodeJustAdded(true);
  });
  const removeCode = () => act(async () => {
    setCode(await unwrap(api.mcp.removeCode(conn.id)));
    setCodeJustAdded(false);
  });
  const removeDesktop = () => act(async () => {
    setDesktop(await unwrap(api.mcp.removeDesktop(conn.id)));
    setJustAdded(false);
  });

  return (
    <div className="modal-backdrop">
      <div className="modal share-dialog" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h3>✦ Share “{conn.name}” with Claude</h3>

        {/* ---- Step 1: Claude desktop app (one-time) ---- */}
        <div className="share-step">
          <div className="step-no">1</div>
          <div className="step-body">
            <b>Connect your Claude apps</b> <span className="muted small">(one time only)</span>
            <div className="app-row-title">Claude desktop app (chat)</div>
            {desktop === null ? (
              <div className="muted small">Checking…</div>
            ) : !desktop.found ? (
              <div className="muted small">The Claude desktop app was not found on this PC. Install it from claude.ai/download, open it once, then reopen this window.</div>
            ) : desktop.installed ? (
              <div className="small">
                <span className="ok-text">✓ Added to Claude Desktop</span> as <code>{desktop.serverName}</code>{' '}
                <button className="link" onClick={removeDesktop} disabled={busy}>Remove</button>
                {justAdded && (
                  <div className="restart-note">
                    Now <b>fully quit</b> Claude Desktop (right-click its icon near the clock → <b>Quit</b>) and open it again.
                    You only need to do this once.
                  </div>
                )}
              </div>
            ) : (
              <div>
                <button className="primary" onClick={addDesktop} disabled={busy}>Add Rowlight to Claude Desktop</button>
                <div className="muted small">Adds a “{conn.name}” tool to Claude Desktop's settings. No password or token is stored there.</div>
              </div>
            )}
          </div>
        </div>

        {/* ---- Step 1b: Claude Code (VS Code / terminal / Code tab) ---- */}
        <div className="share-step sub">
          <div className="step-no ghost" />
          <div className="step-body">
            <div className="app-row-title">Claude Code: VS Code extension, terminal, Code tab</div>
            {code === null ? (
              <div className="muted small">Checking…</div>
            ) : code.installed ? (
              <div className="small">
                <span className="ok-text">✓ Added to Claude Code</span> as <code>{code.serverName}</code>{' '}
                <button className="link" onClick={removeCode} disabled={busy}>Remove</button>
                {codeJustAdded && (
                  <div className="restart-note">Start a <b>new</b> Claude conversation in VS Code (or run <code>/mcp</code>) to load it.</div>
                )}
              </div>
            ) : !code.cliFound ? (
              <div className="muted small">Claude Code was not found. Install the “Claude Code” extension in VS Code, then reopen this window.</div>
            ) : (
              <div>
                <button className="primary" onClick={addCode} disabled={busy}>Add Rowlight to Claude Code</button>
                <div className="muted small">Works in every project: when Claude is fixing a bug in VS Code it can look up data here.</div>
              </div>
            )}
          </div>
        </div>

        {/* ---- Step 2: share ---- */}
        <div className="share-step">
          <div className="step-no">2</div>
          <div className="step-body">
            <b>Share this connection</b> <span className="muted small">(each time you want Claude to use it)</span>
            {!info && looksProd && (
              <div className="prod-share-warning">
                <b>⚠ “{conn.name}” looks like a production / DR connection.</b>
                <div>The rows Claude asks for (customer names, loan details, amounts…) are sent to Claude (Anthropic) and leave this PC.
                  Sharing is read-only and stops when you click Stop sharing, but check your company’s data policy before sharing real customer data.</div>
                <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand, share this connection</label>
              </div>
            )}
            <div className="share-toggle">
              {info ? (
                <>
                  <span className="ok-text">● Sharing is ON · {info.queries} AI request{info.queries === 1 ? '' : 's'}</span>
                  <button className="danger" disabled={busy} onClick={() => act(onStop)}>Stop sharing</button>
                </>
              ) : (
                <>
                  <span className="muted">○ Not shared</span>
                  <button className="primary" disabled={busy || (looksProd && !ack)} onClick={() => act(onStart)}
                    title={looksProd && !ack ? 'Tick the box above first' : undefined}>{busy ? 'Starting…' : 'Start sharing'}</button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ---- Step 3: ask ---- */}
        <div className="share-step">
          <div className="step-no">3</div>
          <div className="step-body">
            <b>Ask Claude</b> <span className="muted small">(desktop chat, VS Code, or terminal)</span>
            <div className="muted small">e.g. “Using {conn.name}, what is the first customer's name in the customer table?”</div>
          </div>
        </div>

        <ul className="share-facts small">
          <li><b>Always read-only</b> for Claude (even if writes are allowed in your tabs) · max <b>500 rows</b> · <b>15 s</b> timeout.</li>
          <li>Every AI query is logged in History, marked “AI”. Sharing stops when you click Stop, disconnect, or close Rowlight.</li>
          <li>Claude in Chrome / claude.ai in a browser cannot reach Rowlight (it runs in the cloud). Use the desktop app.</li>
        </ul>

        <button className="link" onClick={() => setShowCode((v) => !v)}>{showCode ? '▾' : '▸'} Another MCP client? Show the raw HTTP command</button>
        {showCode && (
          info ? (
            <>
              <div className="cmd-box">
                <code>{info.command}</code>
                <button onClick={() => copy(info.command, 'cmd')}>{copied === 'cmd' ? 'Copied ✓' : 'Copy'}</button>
              </div>
              <div className="muted small">The token in this command changes every time you share. Do not paste it into chats.</div>
            </>
          ) : <div className="muted small">Start sharing first to get the command.</div>
        )}

        {error && <pre className="status-box err">{error}</pre>}
        <div className="modal-actions">
          <span className="spacer" />
          <button className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
