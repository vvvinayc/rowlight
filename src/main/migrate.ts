// One-time migration from the old app names (LumenSQL, LiteSQL) to Rowlight.
//
// 1. Data: %APPDATA%\LumenSQL (or LiteSQL) → %APPDATA%\Rowlight (connections, SSH profiles, settings,
//    history, open tabs / theme).
//    Must run BEFORE the app is ready, so Chromium has not opened "Local Storage" yet.
//    Saved passwords keep working: DPAPI encryption is tied to the Windows user, not to the app.
// 2. Claude links: entries in Claude Desktop / Claude Code that still start the OLD exe (or point at the
//    old shares file) are rewritten to this app. Only in the installed app (never from `npm run dev`).

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store';
import { addToDesktop, desktopStatus } from './claudeDesktop';
import { addToCode, codeStatus } from './claudeCode';

const OLD_NAMES = ['LumenSQL', 'LiteSQL']; // newest first
// 'Local State' holds the key that encrypts saved passwords: without it they cannot be decrypted.
const COPY = ['Local State', 'connections.json', 'ssh-profiles.json', 'settings.json', 'history', 'Local Storage'];

export function migrateOldData(): string | null {
  const target = app.getPath('userData');
  // Only for the normal data folder: a custom one (tests, portable setups) must never pull in real data.
  if (path.resolve(target) !== path.resolve(path.join(app.getPath('appData'), app.getName()))) return null;
  if (fs.existsSync(path.join(target, 'connections.json'))) return null; // already has its own data
  for (const old of OLD_NAMES) {
    const src = path.join(app.getPath('appData'), old);
    if (!fs.existsSync(path.join(src, 'connections.json'))) continue;
    fs.mkdirSync(target, { recursive: true });
    for (const item of COPY) {
      const from = path.join(src, item);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(target, item), { recursive: true, force: false, errorOnExist: false });
    }
    fs.writeFileSync(path.join(target, 'migrated-from.txt'), `${src}\n${new Date().toISOString()}\n`);
    return src;
  }
  return null;
}

/** Re-points Claude Desktop / Claude Code entries that were made by an older install. */
export async function relinkClaudeEntries(log: (msg: string) => void): Promise<void> {
  if (!app.isPackaged && !process.env.ROWLIGHT_FORCE_RELINK) return; // dev runs must not touch real configs
  for (const c of store.listConnections()) {
    try {
      const d = desktopStatus(c.id);
      if (d.serverName && !d.installed) {
        addToDesktop(c.id, c.name);
        log(`Updated Claude Desktop entry for "${c.name}"`);
      }
    } catch (e) {
      log(`Could not update Claude Desktop entry for "${c.name}": ${(e as Error).message}`);
    }
    try {
      const k = codeStatus(c.id);
      if (k.serverName && !k.installed && k.cliFound) {
        await addToCode(c.id, c.name);
        log(`Updated Claude Code entry for "${c.name}"`);
      }
    } catch (e) {
      log(`Could not update Claude Code entry for "${c.name}": ${(e as Error).message}`);
    }
  }
}
