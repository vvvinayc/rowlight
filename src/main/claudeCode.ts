// Connects LumenSQL shares to Claude Code: the VS Code extension, the terminal CLI and the
// Code tab of the Claude desktop app all read the same user-level MCP list in %USERPROFILE%\.claude.json.
//
// We never edit .claude.json ourselves (Claude Code rewrites it constantly); we call Claude Code's
// own CLI:  claude mcp add-json <name> <json> --scope user
// The entry starts the same token-free bridge as Claude Desktop.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeEntry, isBridgeFor } from './claudeDesktop';
import { mcpServerName } from './mcpTools';

export interface CodeStatus {
  /** A Claude Code CLI was found (VS Code extension, standalone or npm install). */
  cliFound: boolean;
  cliPath?: string;
  installed: boolean;
  serverName?: string;
}

const home = () => process.env.USERPROFILE ?? os.homedir();

/** Newest claude.exe bundled with a VS Code-family editor extension. */
function editorBundledCli(): string | undefined {
  const found: { file: string; mtime: number }[] = [];
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const extDir = path.join(home(), editor, 'extensions');
    let names: string[] = [];
    try { names = fs.readdirSync(extDir); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith('anthropic.claude-code')) continue;
      const file = path.join(extDir, n, 'resources', 'native-binary', 'claude.exe');
      try { found.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch { /* no binary */ }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.file;
}

export function findClaudeCli(): string | undefined {
  if (process.env.LITESQL_CLAUDE_CLI) return process.env.LITESQL_CLAUDE_CLI;
  const candidates = [path.join(home(), '.local', 'bin', 'claude.exe')];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, 'claude.exe'));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return editorBundledCli();
}

function run(cli: string, args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cli, args, { cwd, timeout: 30_000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }));
  });
}

function readClaudeJson(): any {
  const file = process.env.LITESQL_CLAUDE_JSON ?? path.join(home(), '.claude.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export function codeStatus(connectionId: string): CodeStatus {
  const cliPath = findClaudeCli();
  const servers = readClaudeJson().mcpServers ?? {};
  for (const [name, e] of Object.entries<any>(servers)) {
    if (isBridgeFor(e, connectionId)) return { cliFound: !!cliPath, cliPath, installed: e.command === process.execPath, serverName: name };
  }
  return { cliFound: !!cliPath, cliPath, installed: false };
}

/**
 * Old versions (when the app was called LiteSQL) told you to run "claude mcp add --transport http litesql-… --header Bearer …".
 * Those project-level entries hold a dead token and would hide the new user-level one, so remove them.
 */
async function removeLegacyHttpEntries(cli: string, name: string) {
  const projects = readClaudeJson().projects ?? {};
  for (const [projectPath, p] of Object.entries<any>(projects)) {
    for (const [key, e] of Object.entries<any>(p?.mcpServers ?? {})) {
      const legacy = (key === name || key.startsWith('litesql-') || key.startsWith('lumensql-')) && e?.type === 'http' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/mcp$/.test(String(e?.url ?? ''));
      if (legacy && fs.existsSync(projectPath)) await run(cli, ['mcp', 'remove', key, '--scope', 'local'], projectPath);
    }
  }
}

export async function addToCode(connectionId: string, connectionName: string): Promise<CodeStatus> {
  const cli = findClaudeCli();
  if (!cli) {
    throw new Error('Claude Code was not found. Install the "Claude Code" extension in VS Code (or the Claude Code CLI), then try again.');
  }
  const name = mcpServerName(connectionName);
  const entry = { type: 'stdio', ...bridgeEntry(connectionId, connectionName) };
  const previous = codeStatus(connectionId).serverName; // e.g. the old litesql-… name
  if (previous && previous !== name) await run(cli, ['mcp', 'remove', previous, '--scope', 'user']);
  await run(cli, ['mcp', 'remove', name, '--scope', 'user']); // replace an older entry, if any
  const r = await run(cli, ['mcp', 'add-json', name, JSON.stringify(entry), '--scope', 'user']);
  if (!r.ok) throw new Error('Claude Code could not add the server:\n' + r.out);
  await removeLegacyHttpEntries(cli, name);
  return codeStatus(connectionId);
}

export async function removeFromCode(connectionId: string): Promise<CodeStatus> {
  const cli = findClaudeCli();
  const st = codeStatus(connectionId);
  if (cli && st.serverName) await run(cli, ['mcp', 'remove', st.serverName, '--scope', 'user']);
  return codeStatus(connectionId);
}
