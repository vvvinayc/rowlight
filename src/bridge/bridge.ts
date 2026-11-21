// Claude Desktop ⇄ Rowlight bridge (MCP over stdio).
//
// Claude Desktop can only start local programs as MCP servers, so its config runs:
//   Rowlight.exe <this file> --connection <id>      (with ELECTRON_RUN_AS_NODE=1)
// The bridge answers initialize / tools/list itself (so the tools are always visible), and forwards
// tool calls to Rowlight's share server. It reads the CURRENT address + token of the share from
// %APPDATA%\Rowlight\mcp-shares.json on every call, so the config never contains a token and you never
// have to copy one. If Rowlight is not sharing the connection, the tool call returns a clear message.
//
// stdout is reserved for JSON-RPC messages; diagnostics go to stderr (Claude Desktop logs it).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pickProtocolVersion, SERVER_VERSION, TOOLS } from '../main/mcpTools';

interface ShareEntry { url: string; token: string; name: string }

const args = process.argv.slice(2);
const argValue = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const connectionId = argValue('--connection') ?? '';
const connectionName = argValue('--name') ?? 'database';
const sharesFile = argValue('--shares') ?? path.join(process.env.APPDATA ?? '', 'Rowlight', 'mcp-shares.json');

const NOT_SHARING =
  `Rowlight is not sharing "${connectionName}" right now. Ask the user to open Rowlight, connect to "${connectionName}", ` +
  'click "✦ Share with Claude" and then "Start sharing". Then try again.';

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function currentShare(): ShareEntry | undefined {
  try {
    const all = JSON.parse(fs.readFileSync(sharesFile, 'utf8')) as Record<string, ShareEntry>;
    return all[connectionId];
  } catch {
    return undefined;
  }
}

async function forward(msg: any): Promise<unknown> {
  const share = currentShare();
  const toolError = (text: string) => ({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: true } });
  if (!share) return toolError(NOT_SHARING);
  try {
    const res = await fetch(share.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + share.token },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401) return toolError(NOT_SHARING); // sharing was restarted with a new token
    const text = await res.text();
    return text ? JSON.parse(text) : toolError(`Rowlight returned HTTP ${res.status}`);
  } catch {
    return toolError(NOT_SHARING); // Rowlight closed or sharing stopped
  }
}

async function handle(msg: any) {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return;
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (!isRequest) return; // notifications (initialized, cancelled …)
  const ok = (result: unknown) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: pickProtocolVersion(msg.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'rowlight', version: SERVER_VERSION },
        instructions: `Read-only SQL access to the Rowlight connection "${connectionName}" (only while it is shared in Rowlight). ` +
          'Use list_tables and describe_table before writing queries.',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'resources/list':
      return ok({ resources: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    case 'tools/call':
      return send(await forward(msg));
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) {
    handle(m).catch((e) => process.stderr.write(`rowlight bridge: ${e?.stack ?? e}\n`));
  }
});
rl.on('close', () => process.exit(0));
process.stderr.write(`rowlight bridge started for connection ${connectionId} (shares file: ${sharesFile})\n`);
