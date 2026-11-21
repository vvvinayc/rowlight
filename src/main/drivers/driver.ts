// Common interface implemented by the MySQL and SQL Server drivers.

import type { ColumnInfo, TableDetails, TableInfo } from '../../shared/types';

export interface ConnectParams {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  readOnly: boolean;
  mssqlEncrypt?: boolean;
  mssqlTrustCert?: boolean;
}

/** Origin of a result column (MySQL reports this per column). */
export interface ColumnSource {
  db: string;
  table: string;
  column: string;
}

export interface ExecOutput {
  resultSets: { columns: string[]; rows: unknown[][]; sources?: (ColumnSource | null)[] }[];
  affectedRows?: number;
}

/** One parameterised statement of a change set. expectOne: must affect exactly one row. */
export interface ParamStatement {
  sql: string;
  params: unknown[];
  expectOne: boolean;
}

/** Tab ids starting with this prefix always run READ ONLY (used by the Claude MCP share). */
export const AI_TAB_PREFIX = 'ai:';

export interface Driver {
  serverVersion(): Promise<string>;
  listDatabases(): Promise<string[]>;
  listTables(database: string): Promise<TableInfo[]>;
  listColumns(database: string, table: string): Promise<ColumnInfo[]>;
  tableDetails(database: string, table: string): Promise<TableDetails>;
  /** Runs ONE statement (MySQL) or ONE batch (SQL Server) on the tab's dedicated connection. */
  exec(tabId: string, sql: string): Promise<ExecOutput>;
  cancel(tabId: string): Promise<void>;
  /** Runs statements in ONE transaction on a separate connection of the tab; rolls back on any failure. */
  applyStatements(tabId: string, statements: ParamStatement[]): Promise<number>;
  currentDatabase(tabId: string): Promise<string>;
  useDatabase(tabId: string, database: string): Promise<void>;
  setReadOnly(readOnly: boolean): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  close(): Promise<void>;
}

/** Converts driver values into plain values that are cheap to send to the UI. */
export function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return String(v);
    // Drivers give us UTC-based Dates for zone-less DB values, so format the UTC parts.
    return v.toISOString().replace('T', ' ').replace('Z', '').replace(/\.000$/, '');
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v as Uint8Array);
    if (b.length === 1 && (b[0] === 0 || b[0] === 1)) return b[0]; // BIT(1)
    const hex = b.subarray(0, 64).toString('hex');
    return '0x' + hex.toUpperCase() + (b.length > 64 ? `… (${b.length} bytes)` : '');
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function normalizeRows(rows: unknown[][]): unknown[][] {
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) row[i] = normalizeValue(row[i]);
  }
  return rows;
}
