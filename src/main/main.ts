// Electron main process: window, app:// protocol and IPC handlers.

import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { ChangeSet, ConnectionConfig, Result, Secrets, SshProfile } from '../shared/types';
import { openTunnel } from './sshTunnel';
import { AppFailure, toAppError } from './errors';
import { DbSession, type SessionHooks } from './session';
import { exportResult } from './exporter';
import { exportConnections, importConnections, previewImport } from './connTransfer';
import { McpShare } from './mcpServer';
import { migrateOldData, relinkClaudeEntries } from './migrate';
import { decryptV10, legacyKeys } from './secretRepair';
import * as updater from './updater';
import { addToCode, codeStatus, removeFromCode } from './claudeCode';
import { addToDesktop, clearShares, desktopStatus, publishShare, removeFromDesktop, unpublishShare } from './claudeDesktop';
import * as store from './store';

app.setName('Rowlight');
// Logging must never crash the app (e.g. when its console output is a closed pipe → EPIPE).
for (const stream of [process.stdout, process.stderr]) stream?.on?.('error', () => {});
// First start after the rename: bring over connections, history, settings and open tabs from LiteSQL.
try {
  const from = migrateOldData();
  if (from) console.log('Migrated data from ' + from);
} catch (e) {
  console.error('Data migration failed:', e);
}

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const sessions = new Map<string, DbSession>();
const shares = new Map<string, McpShare>(); // connectionId -> running Claude MCP share
let win: BrowserWindow | null = null;

// ---------- keyboard-interactive prompts (OTP etc.) answered by the UI ----------
const pendingPrompts = new Map<string, (answers: string[] | null) => void>();

const hooks: SessionHooks = {
  askSshPrompts(connectionName, instructions, prompts) {
    return new Promise((resolve) => {
      if (!win) return resolve(null);
      const requestId = crypto.randomUUID();
      pendingPrompts.set(requestId, resolve);
      win.webContents.send('ssh:prompt', { requestId, connectionName, instructions, prompts });
    });
  },
  onClosed(connectionId, reason) {
    sessions.delete(connectionId);
    stopShare(connectionId);
    win?.webContents.send('session:closed', { connectionId, reason });
  },
};

// ---------- helpers ----------

/** Wraps an IPC handler so errors arrive in the UI as { ok:false, error:{kind,message} }. */
function handle<A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T> | T) {
  ipcMain.handle(channel, async (_e, ...args): Promise<Result<T>> => {
    try {
      return { ok: true, data: await fn(...(args as A)) };
    } catch (err) {
      return { ok: false, error: toAppError(err) };
    }
  });
}

function session(id: string): DbSession {
  const s = sessions.get(id);
  if (!s) throw new AppFailure('not-connected', 'Not connected. Connect first.');
  return s;
}

/** Remember the bastion host key on first use: on the SSH profile when one is used, else on the connection. */
function trustHostKey(connectionId: string, profileId: string | undefined, fingerprint: string | undefined, known: string | undefined) {
  if (!fingerprint || known) return;
  if (profileId) store.setProfileFingerprint(profileId, fingerprint);
  else if (connectionId) store.setHostFingerprint(connectionId, fingerprint);
}

async function closeSession(id: string) {
  await stopShare(id);
  await sessions.get(id)?.close();
  sessions.delete(id);
}

async function stopShare(id: string) {
  const sh = shares.get(id);
  if (!sh) return;
  shares.delete(id);
  try { unpublishShare(id); } catch { /* ignore */ }
  await sh.stop();
  win?.webContents.send('mcp:changed', { connectionId: id });
}

// ---------- IPC ----------

function registerIpc() {
  handle('connections:list', () => store.listConnections());
  handle('connections:save', (cfg: ConnectionConfig, secrets: Secrets) => store.saveConnection(cfg, secrets));
  handle('connections:delete', async (id: string) => {
    await closeSession(id);
    store.deleteConnection(id);
  });
  handle('connections:forgetHostKey', (id: string) => {
    const c = store.getConnection(id);
    if (!c) return;
    if (c.ssh.enabled && c.ssh.profileId) store.setProfileFingerprint(c.ssh.profileId, undefined);
    else store.patchConnection(id, { ssh: { ...c.ssh, hostFingerprint: undefined } });
  });
  handle('connections:test', async (raw: ConnectionConfig, typed: Secrets) => {
    const { cfg } = store.resolveConnection(raw);
    const { session: s, fingerprint } = await DbSession.open(cfg, await store.resolveSecrets(raw, typed), { ...hooks, onClosed: () => {} });
    try {
      return { version: await s.driver.serverVersion(), fingerprint };
    } finally {
      await s.close();
    }
  });
  handle('connections:export', (ids: string[], passphrase: string | null) => exportConnections(win!, ids, passphrase));
  handle('connections:importPreview', () => previewImport(win!));
  handle('connections:import', (filePath: string, passphrase: string | null) => importConnections(filePath, passphrase));
  // ---- saved SSH profiles ----
  handle('ssh:profiles', () => store.listProfiles());
  handle('ssh:saveProfile', async (p: SshProfile, secrets: Secrets, fromConnectionId?: string) => {
    // "Save these SSH settings as a profile": bring the connection's already-saved SSH password / passphrase along.
    if (fromConnectionId) {
      const own = await store.getSavedSecrets(fromConnectionId);
      secrets = { ...secrets, sshPassword: secrets?.sshPassword || own.sshPassword, sshPassphrase: secrets?.sshPassphrase || own.sshPassphrase };
    }
    return store.saveProfile(p, secrets);
  });
  handle('ssh:deleteProfile', (id: string) => store.deleteProfile(id));
  handle('ssh:profileUsage', (id: string) => store.connectionsUsingProfile(id));
  handle('ssh:forgetProfileHostKey', (id: string) => store.setProfileFingerprint(id, undefined));
  handle('ssh:testProfile', async (p: SshProfile, typed: Secrets) => {
    const saved = p.id ? await store.getProfileSecrets(p.id) : {};
    const t = await openTunnel({
      host: p.host, port: p.port || 22, user: p.user, auth: p.auth, keyPath: p.keyPath,
      password: typed?.sshPassword || saved.sshPassword, passphrase: typed?.sshPassphrase || saved.sshPassphrase,
      knownFingerprint: p.hostFingerprint, dstHost: '', dstPort: 0,
      askPrompts: (instr, prompts) => hooks.askSshPrompts(p.name || p.host, instr, prompts),
      onClose: () => {},
    });
    t.close();
    if (p.id) trustHostKey('', p.id, t.fingerprint, p.hostFingerprint);
    // A password that just logged in successfully is saved into the (unchanged) profile, so every
    // connection using the profile connects without asking.
    let savedPassword = false;
    const stored = p.id ? store.getProfile(p.id) : undefined;
    const typedSecret = typed?.sshPassword || typed?.sshPassphrase;
    if (stored && typedSecret && !stored.askPassword && stored.host === p.host && stored.port === p.port && stored.user === p.user && stored.auth === p.auth) {
      await store.saveProfile(stored, { sshPassword: typed?.sshPassword || undefined, sshPassphrase: typed?.sshPassphrase || undefined });
      savedPassword = true;
    }
    return { fingerprint: t.fingerprint, savedPassword, usedBy: p.id ? store.connectionsUsingProfile(p.id).length : 0 };
  });
  handle('connections:pickKeyFile', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Select SSH private key', properties: ['openFile', 'showHiddenFiles'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('session:connect', async (id: string, typed?: Secrets) => {
    const existing = sessions.get(id);
    if (existing) return existing.info();
    const raw = store.getConnection(id);
    if (!raw) throw new AppFailure('unknown', 'Connection not found.');
    const { cfg, profile } = store.resolveConnection(raw); // SSH settings from the saved SSH profile, if used
    const { session: s, fingerprint } = await DbSession.open(cfg, await store.resolveSecrets(raw, typed), hooks);
    trustHostKey(id, profile?.id, fingerprint, cfg.ssh.hostFingerprint);
    sessions.set(id, s);
    return s.info();
  });
  handle('session:disconnect', (id: string) => closeSession(id));
  handle('session:setReadOnly', async (id: string, readOnly: boolean) => {
    store.patchConnection(id, { readOnly });
    await sessions.get(id)?.setReadOnly(readOnly);
  });
  handle('session:list', () => [...sessions.values()].map((s) => s.info()));

  handle('meta:databases', (id: string) => session(id).driver.listDatabases());
  handle('meta:tables', (id: string, db: string) => session(id).driver.listTables(db));
  handle('meta:allTables', (id: string) => session(id).driver.listAllTables());
  handle('meta:tableDetails', (id: string, db: string, table: string) => session(id).driver.tableDetails(db, table));
  handle('meta:columns', (id: string, db: string, table: string) => session(id).driver.listColumns(db, table));

  handle('query:run', (id: string, tabId: string, sql: string) => session(id).run(tabId, sql, store.getSettings().selectLimit));
  handle('query:fetchMore', (id: string, tabId: string, sql: string, setIndex: number, offset: number, limit: number) =>
    session(id).fetchMore(tabId, sql, setIndex, offset, limit));
  handle('query:cancel', (id: string, tabId: string) => session(id).cancel(tabId));
  handle('query:closeTab', async (id: string, tabId: string) => { await sessions.get(id)?.driver.closeTab(tabId); });
  handle('query:useDatabase', (id: string, tabId: string, db: string) => session(id).driver.useDatabase(tabId, db));

  // Renderer errors (error boundary / window.onerror) go to userData/logs/renderer.log for bug reports.
  handle('log:error', (text: string) => {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'renderer.log');
    try { if (fs.statSync(file).size > 1_000_000) fs.renameSync(file, file + '.old'); } catch { /* new file */ }
    fs.appendFileSync(file, `${new Date().toISOString()} v${app.getVersion()} ${String(text).slice(0, 20000)}\n\n`);
  });
  handle('edit:preview', (id: string, changes: ChangeSet) => session(id).previewChanges(changes));
  handle('edit:save', (id: string, tabId: string, changes: ChangeSet) => session(id).saveChanges(tabId, changes));

  handle('mcp:start', async (id: string) => {
    const existing = shares.get(id);
    if (existing?.info) return existing.info;
    const share = new McpShare(session(id), () => {
      win?.webContents.send('history:changed', { connectionId: id });
      win?.webContents.send('mcp:changed', { connectionId: id });
    });
    const info = await share.start();
    shares.set(id, share);
    publishShare(id, { url: info.url, token: info.token, name: session(id).config.name }); // for the Claude Desktop bridge
    return info;
  });
  handle('mcp:desktopStatus', (id: string) => desktopStatus(id));
  handle('mcp:addDesktop', (id: string) => addToDesktop(id, session(id).config.name));
  handle('mcp:removeDesktop', (id: string) => removeFromDesktop(id));
  handle('mcp:codeStatus', (id: string) => codeStatus(id));
  handle('mcp:addCode', (id: string) => addToCode(id, session(id).config.name));
  handle('mcp:removeCode', (id: string) => removeFromCode(id));
  handle('mcp:stop', (id: string) => stopShare(id));
  handle('mcp:list', () => [...shares.values()].map((s) => s.info!).filter(Boolean));

  handle('file:open', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Open SQL file', properties: ['openFile'], filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }, { name: 'All files', extensions: ['*'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    if (fs.statSync(p).size > 20 * 1024 * 1024) throw new Error('The file is larger than 20 MB.');
    return { path: p, content: fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') };
  });
  handle('file:save', async (filePath: string | null, content: string, suggestedName: string) => {
    let target = filePath;
    if (!target) {
      const r = await dialog.showSaveDialog(win!, { title: 'Save SQL file', defaultPath: (suggestedName || 'query').replace(/[\\/:*?"<>|]+/g, '_') + '.sql', filters: [{ name: 'SQL', extensions: ['sql'] }] });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    fs.writeFileSync(target, content, 'utf8');
    return target;
  });
  handle('clipboard:write', (text: string) => clipboard.writeText(String(text)));

  handle('history:get', (id: string) => store.getHistory(id));
  handle('private:load', () => ({ data: store.getPrivateAll(), encrypted: store.privateEncrypted() }));
  handle('private:set', (key: string, value: string | null) => store.setPrivate(String(key), value === null ? null : String(value)));
  handle('history:clear', (id: string) => store.clearHistory(id));

  handle('settings:get', () => store.getSettings());
  handle('zoom:set', (what: 'in' | 'out' | 'reset') => (what === 'reset' ? setZoom(0) : zoomBy(what === 'in' ? 1 : -1)));
  handle('settings:save', (s) => {
    const saved = store.saveSettings(s as any);
    if ((s as any)?.autoUpdate) updater.setMode(saved.autoUpdate ?? 'auto');
    return saved;
  });
  handle('app:version', () => app.getVersion());
  handle('update:status', () => updater.updateStatus());
  handle('update:check', () => updater.checkNow(true));
  handle('update:download', () => updater.download());
  handle('update:install', () => updater.installNow());
  handle('update:openReleases', () => updater.openReleases());

  handle('export:result', (format: 'csv' | 'xlsx', columns: string[], rows: unknown[][], name: string) =>
    exportResult(win!, format, columns, rows, name));

  handle('ssh:answerPrompt', (requestId: string, answers: string[] | null) => {
    pendingPrompts.get(requestId)?.(answers);
    pendingPrompts.delete(requestId);
  });
}

// ---------- app:// protocol (serves the renderer files; lets Monaco web workers load) ----------

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function registerProtocol() {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(RENDERER_DIR)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

// ---------- zoom (remembered in settings.json) ----------
const ZOOM_STEP = 0.5; // ≈ 10 % per step
function setZoom(level: number) {
  if (!win) return;
  const clamped = Math.max(-3, Math.min(5, Math.round(level * 2) / 2)); // ≈ 57 % … 250 %
  win.webContents.setZoomLevel(clamped);
  store.saveSettings({ zoomLevel: clamped });
  win.webContents.send('zoom:changed', { percent: Math.round(Math.pow(1.2, clamped) * 100) });
}
function zoomBy(steps: number) {
  if (win) setZoom(win.webContents.getZoomLevel() + steps * ZOOM_STEP);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'Rowlight',
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && !input.alt) {
      // Zoom everything (text, grid, editor): Ctrl + / Ctrl − / Ctrl 0 (main keyboard or numpad)
      if (['=', '+', 'Add'].includes(input.key)) { e.preventDefault(); zoomBy(1); return; }
      if (['-', '_', 'Subtract'].includes(input.key)) { e.preventDefault(); zoomBy(-1); return; }
      if (input.key === '0' && !input.shift) { e.preventDefault(); setZoom(0); return; }
    }
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'r') win?.webContents.reloadIgnoringCache();
  });
  // Ctrl + mouse wheel
  let lastWheelZoom = 0;
  win.webContents.on('zoom-changed', (_e, direction) => {
    const now = Date.now();
    if (now - lastWheelZoom < 80) return; // one wheel notch can fire this twice: one step per notch
    lastWheelZoom = now;
    zoomBy(direction === 'in' ? 1 : -1);
  });
  win.webContents.on('did-finish-load', () => setZoom(store.getSettings().zoomLevel ?? 0));
  win.loadURL('app://local/index.html');
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  clearShares();
  // Saved passwords copied from an older install (LiteSQL / LumenSQL) are encrypted with that install's
  // key: re-encrypt them with ours before anything tries to connect.
  try {
    const r = await store.repairSecrets(legacyKeys, decryptV10);
    if (r.repaired || r.unreadable) console.log(`Saved passwords: ${r.repaired} recovered from the previous install, ${r.unreadable} unreadable`);
  } catch (e) {
    console.error('Password repair failed:', e);
  }
  registerProtocol();
  registerIpc();
  createWindow();
  relinkClaudeEntries((m) => console.log(m)).catch((e) => console.error(e));
  updater.initUpdater(() => win, store.getSettings().autoUpdate ?? 'auto');
});

app.on('will-quit', () => { try { store.flushPrivate(); } catch { /* best effort */ } });
app.on('window-all-closed', async () => {
  for (const id of [...sessions.keys()]) await closeSession(id).catch(() => {});
  app.quit();
});
