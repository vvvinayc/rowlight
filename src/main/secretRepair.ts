// Recovers saved passwords that were encrypted by an older install (LiteSQL / LumenSQL).
//
// Electron's safeStorage on Windows does NOT encrypt with DPAPI directly: it encrypts with an AES-256-GCM
// key stored in the app's own "Local State" file, and only that key is DPAPI-protected. Each app name has
// its own data folder and therefore its own key, so passwords copied from the old folder could not be
// decrypted after a rename (and the bastion asked for the password on every connect).
//
// Here we read the old apps' keys (DPAPI-unprotected for the current Windows user), decrypt the old
// "v10" values and store them again under this app's key. Runs once at start-up, only when needed.

import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const OLD_APP_FOLDERS = ['LumenSQL', 'LiteSQL'];

/** DPAPI-unprotects a blob for the current Windows user (via the .NET ProtectedData API). */
function dpapiUnprotect(blob: Buffer): Buffer | undefined {
  try {
    const script =
      'Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String($env:ROWLIGHT_DPAPI_BLOB); ' +
      "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser'))";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, ROWLIGHT_DPAPI_BLOB: blob.toString('base64') },
      windowsHide: true,
      timeout: 20_000,
    }).toString().trim();
    const key = Buffer.from(out, 'base64');
    return key.length === 32 ? key : undefined;
  } catch {
    return undefined;
  }
}

/** AES keys of older installs, read from their "Local State" files. */
export function legacyKeys(): Buffer[] {
  if (process.platform !== 'win32') return [];
  const keys: Buffer[] = [];
  for (const name of OLD_APP_FOLDERS) {
    const dir = path.join(app.getPath('appData'), name);
    if (path.resolve(dir) === path.resolve(app.getPath('userData'))) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8'));
      const enc = Buffer.from(String(state?.os_crypt?.encrypted_key ?? ''), 'base64');
      if (enc.subarray(0, 5).toString() !== 'DPAPI') continue;
      const key = dpapiUnprotect(enc.subarray(5));
      if (key) keys.push(key);
    } catch { /* no such install */ }
  }
  return keys;
}

/** Decrypts a Chromium/Electron "v10" value (AES-256-GCM: "v10" + 12-byte nonce + ciphertext + 16-byte tag). */
export function decryptV10(b64: string, key: Buffer): string | undefined {
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.subarray(0, 3).toString() !== 'v10' || buf.length < 3 + 12 + 16) return undefined;
    const nonce = buf.subarray(3, 15);
    const tag = buf.subarray(buf.length - 16);
    const data = buf.subarray(15, buf.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
