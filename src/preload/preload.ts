// Exposes a small, typed API to the renderer. The renderer has no Node.js access.

import { contextBridge, ipcRenderer } from 'electron';

const call = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api = {
  connections: {
    list: () => call('connections:list'),
    save: (cfg: unknown, secrets: unknown) => call('connections:save', cfg, secrets),
    delete: (id: string) => call('connections:delete', id),
    test: (cfg: unknown, secrets: unknown) => call('connections:test', cfg, secrets),
    pickKeyFile: () => call('connections:pickKeyFile'),
    forgetHostKey: (id: string) => call('connections:forgetHostKey', id),
    exportFile: (ids: string[], passphrase: string | null) => call('connections:export', ids, passphrase),
    importPreview: () => call('connections:importPreview'),
    importFile: (filePath: string, passphrase: string | null) => call('connections:import', filePath, passphrase),
  },
  ssh: {
    profiles: () => call('ssh:profiles'),
    saveProfile: (p: unknown, secrets: unknown, fromConnectionId?: string) => call('ssh:saveProfile', p, secrets, fromConnectionId),
    deleteProfile: (id: string) => call('ssh:deleteProfile', id),
    profileUsage: (id: string) => call('ssh:profileUsage', id),
    forgetProfileHostKey: (id: string) => call('ssh:forgetProfileHostKey', id),
    testProfile: (p: unknown, secrets: unknown) => call('ssh:testProfile', p, secrets),
    answerPrompt: (requestId: string, answers: string[] | null) => call('ssh:answerPrompt', requestId, answers),
  },
  session: {
    connect: (id: string, secrets?: unknown) => call('session:connect', id, secrets),
    disconnect: (id: string) => call('session:disconnect', id),
    setReadOnly: (id: string, ro: boolean) => call('session:setReadOnly', id, ro),
    list: () => call('session:list'),
  },
  meta: {
    databases: (id: string) => call('meta:databases', id),
    tables: (id: string, db: string) => call('meta:tables', id, db),
    columns: (id: string, db: string, table: string) => call('meta:columns', id, db, table),
    tableDetails: (id: string, db: string, table: string) => call('meta:tableDetails', id, db, table),
  },
  query: {
    run: (id: string, tabId: string, sql: string) => call('query:run', id, tabId, sql),
    cancel: (id: string, tabId: string) => call('query:cancel', id, tabId),
    closeTab: (id: string, tabId: string) => call('query:closeTab', id, tabId),
    useDatabase: (id: string, tabId: string, db: string) => call('query:useDatabase', id, tabId, db),
  },
  edit: {
    preview: (id: string, changes: unknown) => call('edit:preview', id, changes),
    save: (id: string, tabId: string, changes: unknown) => call('edit:save', id, tabId, changes),
  },
  mcp: {
    start: (id: string) => call('mcp:start', id),
    stop: (id: string) => call('mcp:stop', id),
    list: () => call('mcp:list'),
    desktopStatus: (id: string) => call('mcp:desktopStatus', id),
    addDesktop: (id: string) => call('mcp:addDesktop', id),
    removeDesktop: (id: string) => call('mcp:removeDesktop', id),
    codeStatus: (id: string) => call('mcp:codeStatus', id),
    addCode: (id: string) => call('mcp:addCode', id),
    removeCode: (id: string) => call('mcp:removeCode', id),
  },
  history: {
    get: (id: string) => call('history:get', id),
    clear: (id: string) => call('history:clear', id),
  },
  settings: {
    get: () => call('settings:get'),
    save: (s: unknown) => call('settings:save', s),
  },
  copyText: (text: string) => call('clipboard:write', text),
  openFile: () => call('file:open'),
  saveFile: (filePath: string | null, content: string, suggestedName: string) => call('file:save', filePath, content, suggestedName),
  exportResult: (format: 'csv' | 'xlsx', columns: string[], rows: unknown[][], name: string) =>
    call('export:result', format, columns, rows, name),
  on: (event: 'ssh:prompt' | 'session:closed' | 'history:changed' | 'mcp:changed', cb: (payload: any) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
