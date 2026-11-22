// Types shared between the main process, the preload bridge and the renderer.

export type DbType = 'mysql' | 'mssql';
export type SshAuth = 'password' | 'key';

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  keyPath?: string;
  /** SHA-256 fingerprint of the bastion host key, remembered on first connect (trust on first use). */
  hostFingerprint?: string;
  /**
   * When set, the SSH settings (host, user, password/key, host key) come from this saved SSH profile,
   * and the host/port/user/auth/keyPath fields above are ignored.
   */
  profileId?: string;
}

/** A saved SSH bastion that many connections can share. */
export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  keyPath?: string;
  /** Ask for the SSH password / key passphrase on every connect instead of saving it. */
  askPassword: boolean;
  /** New connections use this profile by default. Only one profile is the default. */
  isDefault: boolean;
  hostFingerprint?: string;
  hasSaved?: { sshPassword: boolean; sshPassphrase: boolean };
}

/** A connection as stored on disk / shown in the UI. Never contains plain-text secrets. */
export interface ConnectionConfig {
  id: string;
  name: string;
  type: DbType;
  host: string;
  port: number;
  database: string;
  user: string;
  readOnly: boolean;
  askPassword: boolean;
  ssh: SshConfig;
  /** Colour name from CONNECTION_COLORS (e.g. "red" for prod), shown on tabs and toolbar. */
  color?: string;
  /** SQL Server only. */
  mssqlEncrypt?: boolean;
  mssqlTrustCert?: boolean;
  /** Which secrets are saved (encrypted). The values themselves never leave the main process. */
  hasSaved?: { dbPassword: boolean; sshPassword: boolean; sshPassphrase: boolean };
}

export interface Secrets {
  dbPassword?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

export interface Settings {
  /** Rows to auto-LIMIT SELECTs to. 0 = off. */
  selectLimit: number;
  /** Electron zoom level (0 = 100%, each step ≈ 10%). Set with Ctrl +/−/0 or Ctrl+mouse wheel. */
  zoomLevel?: number;
}

export type ErrorKind =
  | 'ssh-auth'
  | 'ssh-unreachable'
  | 'ssh-hostkey'
  | 'ssh-key'
  | 'ssh-forward'
  | 'db-auth'
  | 'db-unreachable'
  | 'db-unknown-database'
  | 'db-error'
  | 'readonly-blocked'
  | 'cancelled'
  | 'not-connected'
  | 'unknown';

export interface AppError {
  kind: ErrorKind;
  message: string;
  detail?: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  key?: string;
}

export interface TableInfo {
  /** For SQL Server this is "schema.table". */
  name: string;
  kind: 'table' | 'view';
}

export interface ResultSet {
  /** The statement that produced this result. */
  sql?: string;
  columns: string[];
  rows: unknown[][];
  /** True when the app appended LIMIT / SET ROWCOUNT and the cap was hit. */
  limitApplied: boolean;
  /** Rows per page when the auto-LIMIT was applied (used by "load more"). */
  pageLimit?: number;
  /** Position of this result among the results of its statement / batch. */
  setIndex?: number;
  /** Set when the rows come from one table with a primary key, so they can be edited. */
  edit?: EditInfo;
  /** Why the result cannot be edited (shown in the grid toolbar). */
  editBlocked?: string;
}

/** Where an editable result comes from. */
export interface EditInfo {
  database: string;
  /** Table name; for SQL Server "schema.table". */
  table: string;
  /** Table column for each result column, or null for expressions (read-only cells). */
  columnMap: (string | null)[];
  /** Primary key column names (table columns). */
  keyColumns: string[];
}

export type RowValues = Record<string, unknown>;

/** Pending grid edits sent to the main process for saving in one transaction. */
export interface ChangeSet {
  edit: EditInfo;
  updates: { key: RowValues; set: RowValues }[];
  inserts: RowValues[];
  deletes: { key: RowValues }[];
}

export interface McpShareInfo {
  connectionId: string;
  url: string;
  token: string;
  serverName: string;
  command: string;
  startedAt: number;
  queries: number;
}

export interface StatementMessage {
  sql: string;
  durationMs: number;
  rowCount?: number;
  affectedRows?: number;
  error?: AppError;
  note?: string;
}

export interface QueryRunResult {
  results: ResultSet[];
  messages: StatementMessage[];
  totalMs: number;
  cancelled: boolean;
  /** Database the tab connection is using after the run (USE statements change it). */
  currentDatabase: string;
}

export interface HistoryEntry {
  ts: number;
  sql: string;
  durationMs: number;
  rows?: number;
  ok: boolean;
  error?: string;
  source: 'user' | 'ai';
}

export interface SessionInfo {
  connectionId: string;
  readOnly: boolean;
  type: DbType;
  currentDatabase: string;
}

/** Keyboard-interactive prompt forwarded to the UI (e.g. OTP codes on the bastion). */
export interface SshPromptRequest {
  requestId: string;
  connectionName: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
}

/** Everything shown in the table details view. */
export interface TableDetails {
  database: string;
  table: string;
  /** Engine, approx. rows, sizes, created… */
  info: { label: string; value: string }[];
  columns: { name: string; type: string; nullable: boolean; key: string; default: string | null; extra: string; comment: string }[];
  indexes: { name: string; columns: string; unique: boolean; primary: boolean; type: string }[];
  /** out = this table points to another; in = another table points to this one. */
  foreignKeys: { name: string; direction: 'out' | 'in'; table: string; columns: string; refTable: string; refColumns: string; onDelete: string; onUpdate: string }[];
  ddl: string;
  ddlNote?: string;
}
