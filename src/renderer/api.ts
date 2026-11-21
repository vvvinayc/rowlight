// Typed access to the preload API. Every call returns Result<T>; `unwrap` throws an ApiError instead.

import type {
  AppError, ChangeSet, TableDetails, SshProfile, ColumnInfo, McpShareInfo, ConnectionConfig, HistoryEntry, QueryRunResult, Result, Secrets, SessionInfo, Settings, TableInfo,
} from '../shared/types';

type P<T> = Promise<Result<T>>;

export interface ImportPreview {
  filePath: string;
  names: string[];
  encryptedPasswords: boolean;
}

export interface CodeStatus {
  cliFound: boolean;
  cliPath?: string;
  installed: boolean;
  serverName?: string;
}

export interface DesktopStatus {
  /** Claude Desktop is installed on this PC. */
  found: boolean;
  /** LumenSQL is in Claude Desktop's config for this connection. */
  installed: boolean;
  serverName?: string;
  files: string[];
}

interface Api {
  connections: {
    list(): P<ConnectionConfig[]>;
    save(cfg: ConnectionConfig, secrets: Secrets): P<ConnectionConfig>;
    delete(id: string): P<void>;
    test(cfg: ConnectionConfig, secrets: Secrets): P<{ version: string; fingerprint?: string }>;
    pickKeyFile(): P<string | null>;
    forgetHostKey(id: string): P<void>;
    exportFile(ids: string[], passphrase: string | null): P<string | null>;
    importPreview(): P<ImportPreview | null>;
    importFile(filePath: string, passphrase: string | null): P<{ imported: string[] }>;
  };
  session: {
    connect(id: string, secrets?: Secrets): P<SessionInfo>;
    disconnect(id: string): P<void>;
    setReadOnly(id: string, ro: boolean): P<void>;
    list(): P<SessionInfo[]>;
  };
  meta: {
    databases(id: string): P<string[]>;
    tables(id: string, db: string): P<TableInfo[]>;
    columns(id: string, db: string, table: string): P<ColumnInfo[]>;
    tableDetails(id: string, db: string, table: string): P<TableDetails>;
  };
  query: {
    run(id: string, tabId: string, sql: string): P<QueryRunResult>;
    cancel(id: string, tabId: string): P<void>;
    closeTab(id: string, tabId: string): P<void>;
    useDatabase(id: string, tabId: string, db: string): P<void>;
  };
  edit: {
    preview(id: string, changes: ChangeSet): P<string[]>;
    save(id: string, tabId: string, changes: ChangeSet): P<number>;
  };
  mcp: {
    start(id: string): P<McpShareInfo>;
    stop(id: string): P<void>;
    list(): P<McpShareInfo[]>;
    desktopStatus(id: string): P<DesktopStatus>;
    addDesktop(id: string): P<DesktopStatus>;
    removeDesktop(id: string): P<DesktopStatus>;
    codeStatus(id: string): P<CodeStatus>;
    addCode(id: string): P<CodeStatus>;
    removeCode(id: string): P<CodeStatus>;
  };
  history: { get(id: string): P<HistoryEntry[]>; clear(id: string): P<void> };
  settings: { get(): P<Settings>; save(s: Settings): P<Settings> };
  copyText(text: string): P<void>;
  openFile(): P<{ path: string; content: string } | null>;
  saveFile(filePath: string | null, content: string, suggestedName: string): P<string | null>;
  exportResult(format: 'csv' | 'xlsx', columns: string[], rows: unknown[][], name: string): P<string | null>;
  ssh: {
    profiles(): P<SshProfile[]>;
    saveProfile(p: SshProfile, secrets: Secrets, fromConnectionId?: string): P<SshProfile>;
    deleteProfile(id: string): P<void>;
    profileUsage(id: string): P<string[]>;
    forgetProfileHostKey(id: string): P<void>;
    testProfile(p: SshProfile, secrets: Secrets): P<{ fingerprint: string }>;
    answerPrompt(requestId: string, answers: string[] | null): P<void>;
  };
  on(event: 'ssh:prompt' | 'session:closed' | 'history:changed' | 'mcp:changed', cb: (payload: any) => void): () => void;
}

export const api = (window as unknown as { api: Api }).api;

export class ApiError extends Error {
  constructor(public error: AppError) {
    super(error.message);
  }
}

export async function unwrap<T>(p: P<T>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new ApiError(r.error);
  return r.data;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.error.message;
  return String((e as Error)?.message ?? e);
}
