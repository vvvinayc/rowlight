// Connects Rowlight shares to the Claude desktop app.
//
// 1. mcp-shares.json (in Rowlight's data folder) holds the address + token of each RUNNING share.
//    The bridge (src/bridge/bridge.ts) reads it on every tool call. Entries are removed when sharing stops.
// 2. "Add to Claude Desktop" writes one entry per connection into claude_desktop_config.json, which
//    starts the bridge. The entry contains no token, so it never has to change.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { mcpServerName } from './mcpTools';

const CONFIG_FILE = 'claude_desktop_config.json';

// ---------- running shares ----------

export function sharesFilePath(): string {
  return path.join(app.getPath('userData'), 'mcp-shares.json');
}

function readShares(): Record<string, { url: string; token: string; name: string }> {
  try {
    return JSON.parse(fs.readFileSync(sharesFilePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeShares(all: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(sharesFilePath()), { recursive: true });
  const tmp = sharesFilePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
  fs.renameSync(tmp, sharesFilePath());
}

export function publishShare(connectionId: string, entry: { url: string; token: string; name: string }) {
  writeShares({ ...readShares(), [connectionId]: entry });
}

export function unpublishShare(connectionId: string) {
  const all = readShares();
  if (!(connectionId in all)) return;
  delete all[connectionId];
  writeShares(all);
}

/** On start-up nothing is shared yet; drop entries left by a crash. */
export function clearShares() {
  try { writeShares({}); } catch { /* ignore */ }
}

// ---------- Claude Desktop config ----------

/**
 * Folders where Claude Desktop reads claude_desktop_config.json:
 * the normal install (%APPDATA%\Claude) and the Microsoft Store install, which keeps its
 * AppData in %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude.
 */
export function claudeConfigDirs(): string[] {
  if (process.env.LITESQL_CLAUDE_CONFIG_DIRS) return process.env.LITESQL_CLAUDE_CONFIG_DIRS.split(';').filter(Boolean);
  const dirs: string[] = [];
  // Current Microsoft Store builds keep their real settings in %LOCALAPPDATA%\Claude-Data\claude_<id>\.
  // This is the one Claude Desktop actually reads, so it goes first.
  const dataRoot = path.join(process.env.LOCALAPPDATA ?? '', 'Claude-Data');
  try {
    for (const d of fs.readdirSync(dataRoot)) {
      const dir = path.join(dataRoot, d);
      if (fs.existsSync(path.join(dir, CONFIG_FILE))) dirs.push(dir);
    }
  } catch { /* not this kind of install */ }
  const roaming = path.join(app.getPath('appData'), 'Claude');
  if (fs.existsSync(roaming)) dirs.push(roaming);
  const packages = path.join(process.env.LOCALAPPDATA ?? '', 'Packages');
  try {
    for (const d of fs.readdirSync(packages)) {
      if (/^Claude_/i.test(d)) dirs.push(path.join(packages, d, 'LocalCache', 'Roaming', 'Claude'));
    }
  } catch { /* no Store apps */ }
  return dirs;
}

function bridgeScriptPath(): string {
  // In the installed app the bridge is unpacked next to app.asar so a plain Node process can run it.
  return path.join(__dirname, '..', 'bridge', 'bridge.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

export interface McpEntry { command: string; args: string[]; env?: Record<string, string> }

/** How to start the bridge for one connection (used for Claude Desktop and Claude Code). No token inside. */
export function bridgeEntry(connectionId: string, connectionName: string): McpEntry {
  return {
    command: process.execPath,
    args: [bridgeScriptPath(), '--connection', connectionId, '--name', connectionName, '--shares', sharesFilePath()],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

export const isBridgeFor = (e: { args?: unknown } | undefined, connectionId: string) =>
  !!e && Array.isArray(e.args) && e.args.includes('--connection') && e.args[e.args.indexOf('--connection') + 1] === connectionId;

function readConfig(file: string): { mcpServers?: Record<string, McpEntry>; [k: string]: unknown } {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Claude Desktop's config file is not valid JSON, so Rowlight did not change it:\n${file}\nFix or delete it, then try again.`);
  }
}

const isOurs = isBridgeFor;

export interface DesktopStatus {
  found: boolean;
  installed: boolean;
  serverName?: string;
  files: string[];
}

export function desktopStatus(connectionId: string): DesktopStatus {
  const dirs = claudeConfigDirs();
  const files = dirs.map((d) => path.join(d, CONFIG_FILE));
  // Only the first (preferred) config counts: an entry in an old/unused location does not help.
  for (const f of files.slice(0, 1)) {
    try {
      const cfg = readConfig(f);
      for (const [name, e] of Object.entries(cfg.mcpServers ?? {})) {
        if (isOurs(e, connectionId)) {
          return { found: true, installed: e.command === process.execPath && e.args[0] === bridgeScriptPath(), serverName: name, files };
        }
      }
    } catch { /* unreadable: treat as not installed */ }
  }
  return { found: dirs.length > 0, installed: false, files };
}

/** Adds (or updates) the Rowlight entry for one connection in every Claude Desktop config found. */
export function addToDesktop(connectionId: string, connectionName: string): DesktopStatus {
  const dirs = claudeConfigDirs();
  if (!dirs.length) throw new Error('Claude Desktop was not found on this PC. Install the Claude desktop app, open it once, then try again.');
  const entry = bridgeEntry(connectionId, connectionName);
  for (const dir of dirs) {
    const file = path.join(dir, CONFIG_FILE);
    const cfg = readConfig(file);
    if (fs.existsSync(file) && !fs.existsSync(file + '.rowlight-backup')) fs.copyFileSync(file, file + '.rowlight-backup');
    const servers = (cfg.mcpServers ??= {});
    for (const [name, e] of Object.entries(servers)) if (isOurs(e, connectionId)) delete servers[name];
    let name = mcpServerName(connectionName);
    if (servers[name]) name += '-' + connectionId.slice(0, 6); // another server already uses this name
    servers[name] = entry;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  }
  return desktopStatus(connectionId);
}

export function removeFromDesktop(connectionId: string): DesktopStatus {
  for (const dir of claudeConfigDirs()) {
    const file = path.join(dir, CONFIG_FILE);
    if (!fs.existsSync(file)) continue;
    const cfg = readConfig(file);
    let changed = false;
    for (const [name, e] of Object.entries(cfg.mcpServers ?? {})) {
      if (isOurs(e, connectionId)) { delete cfg.mcpServers![name]; changed = true; }
    }
    if (changed) fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  }
  return desktopStatus(connectionId);
}
