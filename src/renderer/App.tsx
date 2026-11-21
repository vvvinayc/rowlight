// App shell: sidebar, query tabs, history panel, dialogs and global shortcuts.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionConfig, McpShareInfo, Secrets, SessionInfo, Settings, SshProfile, SshPromptRequest } from '../shared/types';
import { connectionColor, defaultReadOnlyForName, DEFAULT_SELECT_LIMIT } from '../shared/defaults';
import { getThemePref, setThemePref, type ThemePref } from './theme';
import { api, ApiError, errorText, unwrap } from './api';
import { metaCache } from './metaCache';
import { Sidebar } from './components/Sidebar';
import { ConnectionDialog } from './components/ConnectionDialog';
import { QueryTab, type EditorHandle, type TabState } from './components/QueryTab';
import { HistoryPanel } from './components/HistoryPanel';
import { ConfirmDialog, PasswordPrompt, SettingsDialog, SshPromptDialog, type PromptNeeds } from './components/Dialogs';
import { SshProfilesDialog } from './components/SshProfilesDialog';
import { ShareDialog } from './components/ShareDialog';
import { ExportDialog, ImportDialog } from './components/TransferDialogs';
import { TableDetailsDialog } from './components/TableDetailsDialog';
import type { ImportPreview } from './api';

const ERROR_TITLES: Record<string, string> = {
  'ssh-auth': 'SSH login failed',
  'ssh-unreachable': 'SSH bastion unreachable',
  'ssh-hostkey': 'SSH host key changed',
  'ssh-key': 'SSH key problem',
  'ssh-forward': 'Bastion cannot reach the database',
  'db-auth': 'Database login failed',
  'db-unreachable': 'Database unreachable',
  'db-unknown-database': 'Unknown database',
};

const TABS_KEY = 'app.openTabs';
interface PersistedTabs {
  active: string | null;
  tabs: { id: string; connId: string; title: string; filePath?: string; sql: string; savedSql?: string }[];
}
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

let tabCounter = 0;
const newTabId = () => `tab-${Date.now()}-${++tabCounter}`;

export function App() {
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({});
  const [connecting, setConnecting] = useState<Record<string, boolean>>({});
  const [activeConnId, setActiveConnId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ConnectionConfig | 'new' | null>(null);
  const [pwPrompt, setPwPrompt] = useState<{ conn: ConnectionConfig; needs: PromptNeeds } | null>(null);
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  const [profilesDialog, setProfilesDialog] = useState<{ selectId?: string } | null>(null);
  const reloadProfiles = useCallback(async () => { setProfiles(await unwrap(api.ssh.profiles())); }, []);
  const [sshPrompts, setSshPrompts] = useState<SshPromptRequest[]>([]);
  const [confirm, setConfirm] = useState<{ title: string; text: string; danger?: boolean; okText?: string; onOk: () => void } | null>(null);
  const [alert, setAlert] = useState<{ title: string; text: string } | null>(null);
  const [settings, setSettings] = useState<Settings>({ selectLimit: DEFAULT_SELECT_LIMIT });
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [status, setStatus] = useState('Ready');
  const [theme, setTheme] = useState<ThemePref>(getThemePref());
  const THEME_NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
  const THEME_LABEL: Record<ThemePref, string> = { system: '🖥 System', light: '☀ Light', dark: '🌙 Dark' };
  const changeTheme = (t: ThemePref) => { setThemePref(t); setTheme(t); };
  const [shares, setShares] = useState<Record<string, McpShareInfo>>({});
  const [shareFor, setShareFor] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [details, setDetails] = useState<{ connId: string; db: string; table: string } | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const editors = useRef(new Map<string, EditorHandle>());
  const texts = useRef(new Map<string, string>()); // current SQL of each tab
  const savedTexts = useRef(new Map<string, string>()); // last saved/opened file content
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const restored = useRef(false);

  const reloadConnections = useCallback(async () => {
    setConnections(await unwrap(api.connections.list()));
  }, []);

  useEffect(() => {
    reloadConnections().catch((e) => setStatus(errorText(e)));
    reloadProfiles().catch(() => {});
    unwrap(api.settings.get()).then(setSettings).catch(() => {});
    const offPrompt = api.on('ssh:prompt', (req: SshPromptRequest) => setSshPrompts((q) => [...q, req]));
    const reloadShares = () => unwrap(api.mcp.list())
      .then((list) => setShares(Object.fromEntries(list.map((i) => [i.connectionId, i]))))
      .catch(() => {});
    const offMcp = api.on('mcp:changed', reloadShares);
    const offHist = api.on('history:changed', () => setHistoryVersion((v) => v + 1));
    const offClosed = api.on('session:closed', ({ connectionId, reason }) => {
      setSessions((s) => { const n = { ...s }; delete n[connectionId]; return n; });
      metaCache.clear(connectionId);
      setAlert({ title: 'Connection lost', text: `${reason}\n\nClick “Connect” in the sidebar to reconnect.` });
    });
    return () => { offPrompt(); offClosed(); offMcp(); offHist(); };
  }, [reloadConnections]);

  const connById = (id: string | null) => connections.find((c) => c.id === id);

  // ---------- restore / persist open tabs ----------
  useEffect(() => {
    if (restored.current || !connections.length) return;
    restored.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? 'null') as PersistedTabs | null;
      if (!saved?.tabs?.length) return;
      const list = saved.tabs.filter((t) => connections.some((c) => c.id === t.connId));
      for (const t of list) {
        texts.current.set(t.id, t.sql);
        if (t.filePath && typeof t.savedSql === 'string') savedTexts.current.set(t.id, t.savedSql);
      }
      setTabs(list.map((t) => ({ id: t.id, connId: t.connId, title: t.title, initialSql: t.sql, filePath: t.filePath })));
      setDirty(Object.fromEntries(list.filter((t) => t.filePath && t.sql !== t.savedSql).map((t) => [t.id, true])));
      setActiveTabId(list.some((t) => t.id === saved.active) ? saved.active : list[0]?.id ?? null);
    } catch { /* corrupt: start fresh */ }
  }, [connections]);

  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const persistTabs = useCallback(() => {
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const data: PersistedTabs = {
        active: activeIdRef.current,
        tabs: tabsRef.current.map((t) => ({
          id: t.id, connId: t.connId, title: t.title, filePath: t.filePath,
          sql: texts.current.get(t.id) ?? t.initialSql,
          savedSql: savedTexts.current.get(t.id),
        })),
      };
      try { localStorage.setItem(TABS_KEY, JSON.stringify(data)); } catch { /* quota: ignore */ }
    }, 500);
  }, []);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeTabId);
  activeIdRef.current = activeTabId;
  useEffect(() => { if (restored.current) persistTabs(); }, [tabs, activeTabId, persistTabs]);

  function onTextChange(tabId: string, text: string) {
    texts.current.set(tabId, text);
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (tab?.filePath) {
      const isDirty = text !== savedTexts.current.get(tabId);
      setDirty((d) => (!!d[tabId] === isDirty ? d : { ...d, [tabId]: isDirty }));
    }
    persistTabs();
  }

  // ---------- .sql files ----------
  async function openFile() {
    const connId = currentConnId ?? connections[0]?.id ?? null;
    if (!connId) { setStatus('Add a connection first: a SQL tab always belongs to a connection.'); return; }
    try {
      const f = await unwrap(api.openFile());
      if (!f) return;
      const id = newTabId();
      texts.current.set(id, f.content);
      savedTexts.current.set(id, f.content);
      setTabs((t) => [...t, { id, connId, title: baseName(f.path), initialSql: f.content, filePath: f.path }]);
      setActiveTabId(id);
      setStatus('Opened ' + f.path);
    } catch (e) {
      setAlert({ title: 'Could not open the file', text: errorText(e) });
    }
  }

  async function saveFile(saveAs: boolean) {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (!tab) return;
    const text = editors.current.get(tab.id)?.getText() ?? texts.current.get(tab.id) ?? '';
    try {
      const p = await unwrap(api.saveFile(saveAs ? null : tab.filePath ?? null, text, tab.title));
      if (!p) return;
      texts.current.set(tab.id, text);
      savedTexts.current.set(tab.id, text);
      setTabs((list) => list.map((t) => (t.id === tab.id ? { ...t, filePath: p, title: baseName(p) } : t)));
      setDirty((d) => ({ ...d, [tab.id]: false }));
      setStatus('Saved ' + p);
    } catch (e) {
      setAlert({ title: 'Could not save the file', text: errorText(e) });
    }
  }
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const currentConnId = activeTab?.connId ?? activeConnId;

  // ---------- tabs ----------
  const openTab = useCallback((connId: string | null, sql = '', autoRun = false, title?: string) => {
    if (!connId) { setStatus('Select a connection in the sidebar first.'); return; }
    const conn = connections.find((c) => c.id === connId);
    const n = tabs.filter((t) => t.connId === connId).length + 1;
    const tab: TabState = { id: newTabId(), connId, title: title ?? `${conn?.name ?? 'SQL'} ${n}`, initialSql: sql, autoRun };
    setTabs((t) => [...t, tab]);
    setActiveTabId(tab.id);
    setActiveConnId(connId);
  }, [connections, tabs]);

  function closeTab(id: string) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (dirty[id] && !window.confirm(`"${tab.title}" has unsaved changes. Close it anyway?`)) return;
    texts.current.delete(id);
    savedTexts.current.delete(id);
    api.query.closeTab(tab.connId, tab.id);
    const idx = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    if (activeTabId === id) setActiveTabId(rest[Math.min(idx, rest.length - 1)]?.id ?? null);
  }

  // Global shortcuts (capture phase so they work while Monaco has focus).
  const shortcuts = useRef<{ newTab(): void; closeTab(): void; open(): void; save(as: boolean): void }>({ newTab: () => {}, closeTab: () => {}, open: () => {}, save: () => {} });
  shortcuts.current = {
    newTab: () => openTab(currentConnId ?? null),
    closeTab: () => activeTabId && closeTab(activeTabId),
    open: () => openFile(),
    save: (as: boolean) => saveFile(as),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'e' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); shortcuts.current.newTab(); }
      if (k === 'w' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); shortcuts.current.closeTab(); }
      if (k === 'o' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); shortcuts.current.open(); }
      if (k === 's') { e.preventDefault(); e.stopPropagation(); shortcuts.current.save(e.shiftKey); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ---------- connect / disconnect ----------
  async function connect(id: string, secrets?: Secrets) {
    const conn = connById(id);
    if (!conn) return;
    if (!secrets) {
      // Ask only for what is not saved: the DB password (connection setting) and/or the SSH secret
      // (the SSH profile's setting when the connection uses a profile).
      const profile = conn.ssh.enabled && conn.ssh.profileId ? profiles.find((p) => p.id === conn.ssh.profileId) : undefined;
      const sshAsk = conn.ssh.enabled && (profile ? profile.askPassword : conn.askPassword);
      const needs: PromptNeeds = {
        db: conn.askPassword,
        ssh: sshAsk ? { auth: profile?.auth ?? conn.ssh.auth, user: profile?.user ?? conn.ssh.user, host: profile?.host ?? conn.ssh.host, profileName: profile?.name } : null,
      };
      if (needs.db || needs.ssh) { setPwPrompt({ conn, needs }); return; }
    }
    setConnecting((c) => ({ ...c, [id]: true }));
    setStatus(`Connecting to ${conn.name}…`);
    try {
      const info = await unwrap(api.session.connect(id, secrets));
      setSessions((s) => ({ ...s, [id]: info }));
      setActiveConnId(id);
      setStatus(`Connected to ${conn.name}${info.readOnly ? ' (read-only)' : ''}`);
      await reloadConnections(); // host key fingerprint may have been stored
      if (!tabs.some((t) => t.connId === id)) openTab(id);
    } catch (e) {
      const kind = e instanceof ApiError ? e.error.kind : 'unknown';
      const detail = e instanceof ApiError && e.error.detail && e.error.detail !== e.error.message ? `\n\nDetails: ${e.error.detail}` : '';
      setAlert({ title: ERROR_TITLES[kind] ?? 'Connection failed', text: errorText(e) + detail });
      setStatus('Connection failed');
    } finally {
      setConnecting((c) => ({ ...c, [id]: false }));
    }
  }

  async function disconnect(id: string) {
    await api.session.disconnect(id);
    setShares((s) => { const n = { ...s }; delete n[id]; return n; });
    metaCache.clear(id);
    setSessions((s) => { const n = { ...s }; delete n[id]; return n; });
    setStatus('Disconnected');
  }

  function toggleReadOnly(connId: string) {
    const conn = connById(connId);
    if (!conn) return;
    const next = !(sessions[connId]?.readOnly ?? conn.readOnly);
    const apply = async () => {
      setConfirm(null);
      await unwrap(api.session.setReadOnly(connId, next)).catch((e) => setStatus(errorText(e)));
      setSessions((s) => (s[connId] ? { ...s, [connId]: { ...s[connId], readOnly: next } } : s));
      await reloadConnections();
      setStatus(next ? `${conn.name}: read-only ON` : `${conn.name}: writes ALLOWED`);
    };
    if (!next) {
      setConfirm({
        title: 'Allow writes?',
        text: `Turn OFF read-only for “${conn.name}”?\n\nINSERT / UPDATE / DELETE / DDL will run for real.` +
          (defaultReadOnlyForName(conn.name) ? '\n\n⚠ This looks like a PROD / DR connection.' : ''),
        danger: true,
        okText: 'Allow writes',
        onOk: apply,
      });
    } else {
      apply();
    }
  }

  function deleteConnection(c: ConnectionConfig) {
    setConfirm({
      title: 'Delete connection',
      text: `Delete “${c.name}” and its query history?`,
      danger: true,
      okText: 'Delete',
      onOk: async () => {
        setConfirm(null);
        await api.connections.delete(c.id);
        setTabs((t) => t.filter((x) => x.connId !== c.id));
        setSessions((s) => { const n = { ...s }; delete n[c.id]; return n; });
        await reloadConnections();
      },
    });
  }

  function openTable(connId: string, db: string, table: string) {
    const conn = connById(connId);
    if (!conn) return;
    const sql = conn.type === 'mysql'
      ? `SELECT * FROM \`${db}\`.\`${table}\``
      : `SELECT TOP 200 * FROM [${db}].${table.split('.').map((p) => `[${p}]`).join('.')}`;
    openTab(connId, sql, true, table);
  }

  const insertIntoEditor = (text: string) => {
    if (activeTabId) editors.current.get(activeTabId)?.insert(text);
  };

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">LumenSQL</span>
        <button onClick={() => openTab(currentConnId ?? null)} title="New query tab (Ctrl+E)">+ Query tab</button>
        <button onClick={openFile} title="Open a .sql file (Ctrl+O)">Open…</button>
        <button onClick={() => saveFile(false)} disabled={!activeTabId} title="Save to a .sql file (Ctrl+S, Ctrl+Shift+S = Save as)">Save</button>
        <button className={showHistory ? 'active' : ''} onClick={() => setShowHistory((v) => !v)}>History</button>
        <button onClick={() => setProfilesDialog({})} title="Saved SSH bastions shared by many connections">SSH profiles</button>
        <button onClick={() => setShowSettings(true)}>Settings</button>
        <span className="spacer" />
        <span className="muted small">Auto-LIMIT: {settings.selectLimit || 'off'}</span>
        <button title="Theme: click to switch System → Light → Dark" onClick={() => changeTheme(THEME_NEXT[theme])}>{THEME_LABEL[theme]}</button>
      </div>
      <div className="main">
        <Sidebar
          connections={connections}
          sessions={sessions}
          connecting={connecting}
          shared={shares}
          activeConnId={currentConnId ?? null}
          onSelect={setActiveConnId}
          onConnect={(id) => connect(id)}
          onDisconnect={disconnect}
          onNew={() => setEditing('new')}
          onExport={() => setShowExport(true)}
          onImport={async () => {
            try {
              const p = await unwrap(api.connections.importPreview());
              if (p) setImportPreview(p);
            } catch (e) {
              setAlert({ title: 'Import failed', text: errorText(e) });
            }
          }}
          onEdit={(c) => setEditing(c)}
          onDelete={deleteConnection}
          onNewTab={(id) => openTab(id)}
          onOpenTable={openTable}
          onTableDetails={(connId, db, table) => setDetails({ connId, db, table })}
          onInsert={insertIntoEditor}
        />
        <div className="workspace">
          <div className="tabbar">
            {tabs.map((t) => {
              const conn = connById(t.connId);
              const ro = sessions[t.connId]?.readOnly ?? conn?.readOnly;
              return (
                <div key={t.id} className={'tab' + (t.id === activeTabId ? ' active' : '') + (ro ? '' : ' writable')}
                  style={connectionColor(conn?.color) ? { borderTop: `3px solid ${connectionColor(conn?.color)}` } : undefined}
                  onClick={() => { setActiveTabId(t.id); setActiveConnId(t.connId); }}
                  onAuxClick={(e) => e.button === 1 && closeTab(t.id)}>
                  <span className={'dot ' + (sessions[t.connId] ? 'on' : 'off')} />
                  <span title={t.filePath ?? undefined}>{t.title}{dirty[t.id] ? ' •' : ''}</span>
                  <button className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</button>
                </div>
              );
            })}
          </div>
          <div className="tab-content">
            {tabs.length === 0 && (
              <div className="empty">
                <h2>LumenSQL</h2>
                <p>1. Add a connection with <b>+ New</b> in the sidebar (SSH tunnel optional).</p>
                <p>2. Click <b>Connect</b>. A query tab opens automatically.</p>
                <p>Ctrl+E new tab · Ctrl+Enter run · Ctrl+W close tab · Ctrl+O open · Ctrl+S save · Ctrl+Shift+F format</p>
              </div>
            )}
            {tabs.map((t) => {
              const conn = connById(t.connId);
              if (!conn) return null;
              return (
                <QueryTab
                  key={t.id}
                  tab={t}
                  active={t.id === activeTabId}
                  conn={conn}
                  session={sessions[t.connId]}
                  onNewTab={() => shortcuts.current.newTab()}
                  onToggleReadOnly={() => toggleReadOnly(t.connId)}
                  onRegister={(id, h) => (h ? editors.current.set(id, h) : editors.current.delete(id))}
                  onTextChange={onTextChange}
                  onStatus={setStatus}
                  onHistoryChanged={() => setHistoryVersion((v) => v + 1)}
                  onShare={() => setShareFor(t.connId)}
                  shared={!!shares[t.connId]}
                />
              );
            })}
          </div>
        </div>
        {showHistory && (
          <HistoryPanel
            connId={currentConnId ?? null}
            connName={connById(currentConnId ?? null)?.name ?? ''}
            version={historyVersion}
            onInsert={insertIntoEditor}
            onClose={() => setShowHistory(false)}
          />
        )}
      </div>
      <div className="statusbar">
        <span>{status}</span>
        <span className="spacer" />
        <span>{Object.keys(sessions).length} connected</span>
      </div>

      {editing && (
        <ConnectionDialog
          initial={editing === 'new' ? undefined : editing}
          profiles={profiles}
          onManageProfiles={(selectId) => setProfilesDialog({ selectId })}
          onProfilesChanged={reloadProfiles}
          onClose={() => setEditing(null)}
          onSaved={async (c) => {
            setEditing(null);
            await reloadConnections();
            setActiveConnId(c.id);
            if (sessions[c.id]) setStatus('Saved. Disconnect and connect again to apply connection changes.');
          }}
        />
      )}
      {profilesDialog && (
        <SshProfilesDialog profiles={profiles} initialId={profilesDialog.selectId}
          onChanged={async () => { await reloadProfiles(); await reloadConnections(); }}
          onClose={() => setProfilesDialog(null)} />
      )}
      {pwPrompt && (
        <PasswordPrompt conn={pwPrompt.conn} needs={pwPrompt.needs} onCancel={() => setPwPrompt(null)}
          onSubmit={(s) => { const id = pwPrompt.conn.id; setPwPrompt(null); connect(id, s); }} />
      )}
      {sshPrompts[0] && (
        <SshPromptDialog key={sshPrompts[0].requestId} req={sshPrompts[0]} onAnswer={(a) => {
          api.ssh.answerPrompt(sshPrompts[0].requestId, a);
          setSshPrompts((q) => q.slice(1));
        }} />
      )}
      {shareFor && connById(shareFor) && (
        <ShareDialog
          conn={connById(shareFor)!}
          info={shares[shareFor]}
          onClose={() => setShareFor(null)}
          onStart={async () => {
            const info = await unwrap(api.mcp.start(shareFor));
            setShares((s) => ({ ...s, [shareFor]: info }));
            setStatus(`Sharing ${connById(shareFor)?.name} with Claude (read-only)`);
          }}
          onStop={async () => {
            await unwrap(api.mcp.stop(shareFor));
            setShares((s) => { const n = { ...s }; delete n[shareFor]; return n; });
            setStatus('Stopped sharing with Claude');
          }}
        />
      )}
      {details && (
        <TableDetailsDialog connId={details.connId} database={details.db} table={details.table}
          onClose={() => setDetails(null)}
          onOpenSql={(sql, title) => openTab(details.connId, sql, false, title)} />
      )}
      {showExport && (
        <ExportDialog connections={connections} onCancel={() => setShowExport(false)}
          onDone={(msg) => { setShowExport(false); setStatus(msg); }} />
      )}
      {importPreview && (
        <ImportDialog preview={importPreview} onCancel={() => setImportPreview(null)}
          onDone={async (msg) => { setImportPreview(null); setStatus(msg); await reloadConnections(); }} />
      )}
      {showSettings && (
        <SettingsDialog settings={settings} theme={theme} onTheme={changeTheme} onCancel={() => setShowSettings(false)}
          onSave={async (s) => { setSettings(await unwrap(api.settings.save(s))); setShowSettings(false); }} />
      )}
      {confirm && <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} />}
      {alert && <ConfirmDialog title={alert.title} text={alert.text} okText="OK" alertOnly onOk={() => setAlert(null)} onCancel={() => setAlert(null)} />}
    </div>
  );
}
