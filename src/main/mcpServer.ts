// "Share with Claude": a tiny MCP server (Streamable HTTP transport, JSON responses) for ONE open connection.
//
// Security:
// - listens on 127.0.0.1 only, random port
// - random bearer token per share; requests without it get 401
// - Host header must be 127.0.0.1/localhost (DNS-rebinding protection); browser Origins are refused
// - every query goes through the read-only checker AND (MySQL) a READ ONLY session, whatever the
//   connection's own read-only setting
// - row cap 500, timeout 15 s, every query logged in the app's history (source "ai")

import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { McpShareInfo } from '../shared/types';
import type { DbSession } from './session';
import { AI_TAB_PREFIX } from './drivers/driver';
import { toAppError } from './errors';
import { mcpServerName, pickProtocolVersion, ROW_CAP, SERVER_VERSION, TIMEOUT_MS, TOOLS } from './mcpTools';

const MAX_BODY = 1_000_000;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

export class McpShare {
  private server?: http.Server;
  private token = crypto.randomBytes(32).toString('base64url');
  private queue: Promise<unknown> = Promise.resolve(); // one AI query at a time
  private tabId = AI_TAB_PREFIX + crypto.randomUUID();
  info?: McpShareInfo;

  constructor(private session: DbSession, private onActivity: () => void) {}

  async start(): Promise<McpShareInfo> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e?.message ?? e) } }));
      });
    });
    const port = await new Promise<number>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve((this.server!.address() as AddressInfo).port));
    });
    const url = `http://127.0.0.1:${port}/mcp`;
    const serverName = mcpServerName(this.session.config.name);
    this.info = {
      connectionId: this.session.config.id,
      url,
      token: this.token,
      serverName,
      command: `claude mcp add --transport http ${serverName} ${url} --header "Authorization: Bearer ${this.token}"`,
      startedAt: Date.now(),
      queries: 0,
    };
    return this.info;
  }

  async stop(): Promise<void> {
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = undefined;
    await this.session.driver.closeTab(this.tabId).catch(() => {});
  }

  // ---------- HTTP ----------

  private send(res: http.ServerResponse, status: number, body?: unknown) {
    res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const expected = Buffer.from('Bearer ' + this.token);
    const got = Buffer.from(header);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const port = (this.server!.address() as AddressInfo).port;
    const host = String(req.headers.host ?? '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return this.send(res, 403, { error: 'bad host' });
    if (req.headers.origin && req.headers.origin !== 'null') return this.send(res, 403, { error: 'browser origins are not allowed' });
    if (!this.authorized(req)) return this.send(res, 401, { error: 'missing or wrong bearer token' });
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') return this.send(res, 404, { error: 'not found' });
    if (req.method === 'DELETE') return this.send(res, 200);
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return this.send(res, 405, { error: 'only POST is supported' });
    }

    const raw = await readBody(req);
    let msg: JsonRpcRequest | JsonRpcRequest[];
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const batch = Array.isArray(msg) ? msg : [msg];
    const replies = (await Promise.all(batch.map((m) => this.dispatch(m)))).filter(Boolean);
    if (replies.length === 0) return this.send(res, 202); // only notifications
    this.send(res, 200, Array.isArray(msg) ? replies : replies[0]);
  }

  // ---------- JSON-RPC ----------

  private async dispatch(m: JsonRpcRequest): Promise<unknown | null> {
    const isNotification = m.id === undefined || m.id === null;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id ?? null, error: { code, message } });
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return fail(-32600, 'Invalid request');
    if (isNotification) return null; // notifications/initialized etc.

    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion;
        const c = this.session.config;
        return ok({
          protocolVersion: pickProtocolVersion(asked),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'rowlight', version: SERVER_VERSION },
          instructions:
            `Read-only access to the ${c.type === 'mysql' ? 'MySQL' : 'SQL Server'} connection "${c.name}"` +
            (c.database ? ` (default database: ${c.database})` : '') +
            `. Use list_tables and describe_table before writing queries. Max ${ROW_CAP} rows per query, ${TIMEOUT_MS / 1000}s timeout.`,
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call':
        return ok(await this.callTool(String(m.params?.name ?? ''), m.params?.arguments ?? {}));
      case 'resources/list':
        return ok({ resources: [] });
      case 'prompts/list':
        return ok({ prompts: [] });
      default:
        return fail(-32601, `Method not found: ${m.method}`);
    }
  }

  private async callTool(name: string, args: Record<string, unknown>) {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], isError });
    try {
      // The timer starts when the tool actually runs; the next call waits until the DB call has
      // really finished (after a timeout we cancel it, which ends it quickly).
      let inner: Promise<string> | undefined;
      const work = this.queue.then(() => {
        inner = this.runTool(name, args);
        return withTimeout(inner, TIMEOUT_MS, () => this.session.cancel(this.tabId));
      });
      this.queue = work.catch(() => {}).then(() => inner?.catch(() => {}));
      return text(await work);
    } catch (e) {
      return text(toAppError(e).message, true);
    } finally {
      if (this.info) this.info.queries++;
      this.onActivity();
    }
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<string> {
    const s = this.session;
    const db = typeof args.database === 'string' && args.database ? args.database : s.config.database;
    switch (name) {
      case 'list_tables': {
        if (!db) return 'No default database. Databases:\n' + (await s.driver.listDatabases()).join('\n');
        const tables = await s.driver.listTables(db);
        return `Tables in ${db} (${tables.length}):\n` + tables.map((t) => t.name + (t.kind === 'view' ? ' (view)' : '')).join('\n');
      }
      case 'describe_table': {
        const table = String(args.table ?? '');
        if (!table) throw new Error('"table" is required');
        if (!db) throw new Error('No database given and the connection has no default database');
        const cols = await s.driver.listColumns(db, table);
        if (!cols.length) throw new Error(`Table ${db}.${table} not found`);
        return `${db}.${table}\n` + cols.map((c) => `${c.name}\t${c.type}\t${c.nullable ? 'NULL' : 'NOT NULL'}${c.key === 'PRI' ? '\tPRIMARY KEY' : ''}`).join('\n');
      }
      case 'query': {
        const sql = String(args.sql ?? '');
        if (!sql.trim()) throw new Error('"sql" is required');
        if (typeof args.database === 'string' && args.database) await s.driver.useDatabase(this.tabId, args.database);
        const r = await s.run(this.tabId, sql, ROW_CAP, { source: 'ai', forceReadOnly: true });
        const err = r.messages.find((m) => m.error)?.error;
        if (err) throw new Error(err.message);
        if (r.results.length === 0) return `OK (${r.totalMs} ms, no rows returned)`;
        let budget = ROW_CAP;
        const sets = r.results.map((rs) => {
          const rows = rs.rows.slice(0, Math.max(0, budget));
          budget -= rows.length;
          return { columns: rs.columns, rows, rowCount: rows.length, truncated: rows.length < rs.rows.length || rs.limitApplied };
        });
        const body = sets.length === 1 ? sets[0] : { resultSets: sets };
        return JSON.stringify(body) + (sets.some((x) => x.truncated) ? `\n(Result capped at ${ROW_CAP} rows.)` : '');
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => unknown): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Query timed out after ${ms / 1000}s and was cancelled. Add a LIMIT or a more selective WHERE.`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
