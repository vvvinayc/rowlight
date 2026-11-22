// An open connection = optional SSH tunnel + DB driver. One session per saved connection.
// Also contains the script runner (read-only checks, auto-LIMIT, timing, history).

import type { ChangeSet, ConnectionConfig, QueryRunResult, ResultSet, Secrets, SessionInfo, StatementMessage } from '../shared/types';
import { AppFailure, toAppError } from './errors';
import { openTunnel, type Tunnel } from './sshTunnel';
import type { ColumnSource, Driver } from './drivers/driver';
import { buildEditInfo, buildStatements, isPlainSelect, previewStatements, simpleSelectTable } from './editing';
import { createMysqlDriver } from './drivers/mysql';
import { createMssqlDriver } from './drivers/mssql';
import { applyMssqlRowcount, applyMysqlLimit, checkReadOnly, splitStatements } from './sqlSafety';
import * as store from './store';

export interface SessionHooks {
  askSshPrompts: (connectionName: string, instructions: string, prompts: { prompt: string; echo: boolean }[]) => Promise<string[] | null>;
  onClosed: (connectionId: string, reason: string) => void;
}

export interface RunOptions {
  source?: 'user' | 'ai';
  /** Always apply read-only checks, whatever the connection setting (used for Claude). */
  forceReadOnly?: boolean;
}

export class DbSession {
  private busyTabs = new Set<string>();
  private cancelledTabs = new Set<string>();

  private constructor(
    public config: ConnectionConfig,
    public readOnly: boolean,
    public driver: Driver,
    private tunnel: Tunnel | undefined,
  ) {}

  /** Opens tunnel + DB. Errors are AppFailure with a kind telling SSH / DB / network problems apart. */
  static async open(config: ConnectionConfig, secrets: Secrets, hooks: SessionHooks): Promise<{ session: DbSession; fingerprint?: string }> {
    let tunnel: Tunnel | undefined;
    let host = config.host;
    let port = config.port;
    let session: DbSession | undefined;

    if (config.ssh.enabled) {
      tunnel = await openTunnel({
        host: config.ssh.host,
        port: config.ssh.port || 22,
        user: config.ssh.user,
        auth: config.ssh.auth,
        password: secrets.sshPassword,
        keyPath: config.ssh.keyPath,
        passphrase: secrets.sshPassphrase,
        knownFingerprint: config.ssh.hostFingerprint,
        dstHost: config.host,
        dstPort: config.port,
        askPrompts: (instr, prompts) => hooks.askSshPrompts(config.name, instr, prompts),
        onClose: (reason) => {
          if (session) {
            session.driver.close().catch(() => {});
            hooks.onClosed(config.id, reason);
          }
        },
      });
      host = '127.0.0.1';
      port = tunnel.localPort;
    }

    const where = config.ssh.enabled ? `${config.host}:${config.port} (via SSH ${config.ssh.host})` : `${config.host}:${config.port}`;
    const params = {
      host, port,
      user: config.user,
      password: secrets.dbPassword ?? '',
      database: config.database,
      readOnly: config.readOnly,
      mssqlEncrypt: config.mssqlEncrypt,
      mssqlTrustCert: config.mssqlTrustCert,
    };
    let driver: Driver;
    try {
      driver = config.type === 'mysql' ? await createMysqlDriver(params, where) : await createMssqlDriver(params, where);
    } catch (e) {
      tunnel?.close();
      throw e;
    }
    session = new DbSession(config, config.readOnly, driver, tunnel);
    return { session, fingerprint: tunnel?.fingerprint };
  }

  info(currentDatabase = this.config.database): SessionInfo {
    return { connectionId: this.config.id, readOnly: this.readOnly, type: this.config.type, currentDatabase };
  }

  async setReadOnly(ro: boolean): Promise<void> {
    this.readOnly = ro;
    await this.driver.setReadOnly(ro);
  }

  async close(): Promise<void> {
    await this.driver.close().catch(() => {});
    this.tunnel?.close();
  }

  async cancel(tabId: string): Promise<void> {
    if (!this.busyTabs.has(tabId)) return;
    this.cancelledTabs.add(tabId);
    await this.driver.cancel(tabId);
  }

  /**
   * Runs a script in a tab. In read-only mode every statement is checked first and
   * nothing runs if any statement is blocked.
   */
  async run(tabId: string, script: string, selectLimit: number, opts: RunOptions = {}): Promise<QueryRunResult> {
    const source = opts.source ?? 'user';
    const readOnly = this.readOnly || !!opts.forceReadOnly;
    if (this.busyTabs.has(tabId)) throw new AppFailure('db-error', 'A query is already running in this tab.');
    const dialect = this.config.type;
    const statements = splitStatements(script, dialect);
    const started = Date.now();
    const out: QueryRunResult = { results: [], messages: [], totalMs: 0, cancelled: false, currentDatabase: '' };
    if (statements.length === 0) return out;

    if (readOnly) {
      for (const s of statements) {
        const reason = checkReadOnly(s, dialect);
        if (reason) {
          const error = { kind: 'readonly-blocked' as const, message: `Blocked by read-only mode: ${reason}. Nothing was executed.${opts.forceReadOnly ? '' : ' Turn off "Read-only" for this connection to run it.'}` };
          out.messages.push({ sql: s, durationMs: 0, error });
          this.log(script, 0, undefined, error.message, source);
          return out;
        }
      }
    }

    this.busyTabs.add(tabId);
    this.cancelledTabs.delete(tabId);
    let totalRows = 0;
    let firstError: string | undefined;
    const editCandidates: { set: ResultSet; stmt: string; sources?: (ColumnSource | null)[]; single: boolean }[] = [];
    try {
      for (const stmt of statements) {
        if (this.cancelledTabs.has(tabId)) { out.cancelled = true; break; }
        const { sql, applied } = dialect === 'mysql' ? applyMysqlLimit(stmt, selectLimit) : applyMssqlRowcount(stmt, selectLimit);
        const t0 = Date.now();
        const msg: StatementMessage = { sql: stmt, durationMs: 0 };
        try {
          const r = await this.driver.exec(tabId, sql);
          msg.durationMs = Date.now() - t0;
          for (const [setIndex, rs] of r.resultSets.entries()) {
            const set: ResultSet = {
              sql: stmt, columns: rs.columns, rows: rs.rows, limitApplied: applied && rs.rows.length >= selectLimit,
              pageLimit: applied ? selectLimit : undefined, setIndex,
            };
            out.results.push(set);
            totalRows += rs.rows.length;
            editCandidates.push({ set, stmt, sources: rs.sources, single: r.resultSets.length === 1 });
          }
          if (r.resultSets.length) msg.rowCount = r.resultSets.reduce((a, b) => a + b.rows.length, 0);
          if (r.affectedRows !== undefined && !r.resultSets.length) msg.affectedRows = r.affectedRows;
          if (applied && r.resultSets.some((rs) => rs.rows.length >= selectLimit)) {
            msg.note = `Result capped at ${selectLimit} rows (auto-limit). Add your own LIMIT/TOP or change it in Settings.`;
          }
          out.messages.push(msg);
        } catch (e) {
          msg.durationMs = Date.now() - t0;
          msg.error = toAppError(e);
          if (this.cancelledTabs.has(tabId)) { msg.error = { kind: 'cancelled', message: 'Query cancelled.' }; out.cancelled = true; }
          out.messages.push(msg);
          firstError = msg.error.message;
          break; // stop the script on the first error
        }
      }
    } finally {
      this.busyTabs.delete(tabId);
      this.cancelledTabs.delete(tabId);
    }
    out.totalMs = Date.now() - started;
    out.currentDatabase = await this.driver.currentDatabase(tabId).catch(() => '');
    if (source === 'user') {
      for (const c of editCandidates) await this.detectEditable(c, out.currentDatabase);
    }
    this.log(script, out.totalMs, totalRows, firstError, source);
    return out;
  }

  /** Marks a result as editable when it maps to one table with a primary key. */
  private async detectEditable(c: { set: ResultSet; stmt: string; sources?: (ColumnSource | null)[]; single: boolean }, currentDb: string) {
    const dialect = this.config.type;
    try {
      if (!isPlainSelect(c.stmt, dialect)) { c.set.editBlocked = 'only plain SELECT results can be edited'; return; }
      let database: string;
      let table: string;
      let resultColumns: (string | null)[];
      if (dialect === 'mysql' && c.sources) {
        const tables = new Set(c.sources.filter(Boolean).map((s) => s!.db + '|' + s!.table));
        if (tables.size === 0) { c.set.editBlocked = 'the result has no table columns'; return; }
        if (tables.size > 1) { c.set.editBlocked = 'the result combines several tables'; return; }
        const src = c.sources.find(Boolean)!;
        database = src.db || currentDb;
        table = src.table;
        resultColumns = c.sources.map((s) => s?.column ?? null);
      } else {
        if (!c.single) { c.set.editBlocked = 'the batch returned several results'; return; }
        const t = simpleSelectTable(c.stmt, dialect);
        if (typeof t === 'string') { c.set.editBlocked = t; return; }
        database = t.database ?? currentDb;
        table = t.table;
        resultColumns = c.set.columns;
      }
      if (!database) { c.set.editBlocked = 'no database selected'; return; }
      const info = buildEditInfo(database, table, await this.driver.listColumns(database, table), resultColumns);
      if (typeof info === 'string') c.set.editBlocked = info;
      else c.set.edit = info;
    } catch (e) {
      c.set.editBlocked = 'could not read table metadata: ' + toAppError(e).message;
    }
  }

  /**
   * "Load more": fetches the next page of a result that was cut by the auto-LIMIT.
   * MySQL re-runs the statement with LIMIT n OFFSET k; SQL Server re-reads with a larger ROWCOUNT
   * and returns only the new rows. Only for statements the auto-LIMIT applies to (plain reads).
   */
  async fetchMore(tabId: string, stmt: string, setIndex: number, offset: number, limit: number): Promise<{ rows: unknown[][]; hasMore: boolean }> {
    if (this.busyTabs.has(tabId)) throw new AppFailure('db-error', 'A query is still running in this tab.');
    const dialect = this.config.type;
    const page = Math.max(1, Math.floor(limit));
    const prepared = dialect === 'mysql' ? applyMysqlLimit(stmt, page, offset) : applyMssqlRowcount(stmt, offset + page);
    if (!prepared.applied) throw new AppFailure('db-error', 'This result cannot be paged (it is not a plain SELECT).');
    if (this.readOnly && checkReadOnly(stmt, dialect)) throw new AppFailure('readonly-blocked', 'Blocked by read-only mode.');
    this.busyTabs.add(tabId);
    try {
      const r = await this.driver.exec(tabId, prepared.sql);
      const all = r.resultSets[dialect === 'mysql' ? 0 : setIndex]?.rows ?? [];
      const rows = dialect === 'mysql' ? all : all.slice(offset);
      return { rows, hasMore: rows.length >= page };
    } finally {
      this.busyTabs.delete(tabId);
    }
  }

  previewChanges(changes: ChangeSet): string[] {
    return previewStatements(this.config.type, changes);
  }

  /** Saves grid edits in one transaction on a separate connection of the tab. */
  async saveChanges(tabId: string, changes: ChangeSet): Promise<number> {
    if (this.readOnly) throw new AppFailure('readonly-blocked', 'Read-only mode is on: changes cannot be saved. Turn off Read-only first.');
    const statements = buildStatements(this.config.type, changes);
    if (!statements.length) return 0;
    const preview = previewStatements(this.config.type, changes).join('\n');
    const t0 = Date.now();
    try {
      const n = await this.driver.applyStatements(tabId + ':edit', statements);
      this.log(preview, Date.now() - t0, n, undefined, 'user');
      return n;
    } catch (e) {
      this.log(preview, Date.now() - t0, undefined, toAppError(e).message, 'user');
      throw e;
    }
  }

  private log(sql: string, durationMs: number, rows: number | undefined, error: string | undefined, source: 'user' | 'ai') {
    try {
      store.addHistory(this.config.id, { ts: Date.now(), sql, durationMs, rows, ok: !error, error, source });
    } catch { /* history is best-effort */ }
  }
}
