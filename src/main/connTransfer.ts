// Export / import connections as a JSON file.
//
// Saved passwords are DPAPI-encrypted (tied to this Windows user), so they cannot simply be copied.
// An export either has NO passwords (safe to give to colleagues), or includes them encrypted with a
// passphrase you choose: scrypt key derivation + AES-256-GCM. Without the passphrase the file is useless.

import { BrowserWindow, dialog } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { ConnectionConfig, Secrets, SshProfile } from '../shared/types';
import * as store from './store';

const FORMAT = 'sqlclient-connections';
const LEGACY_FORMATS = [FORMAT, 'litesql-connections'];

interface ExportFile {
  format: string;
  version: 1;
  exportedAt: string;
  connections: Omit<ConnectionConfig, 'hasSaved'>[];
  /** SSH profiles used by the exported connections. */
  sshProfiles?: Omit<SshProfile, 'hasSaved' | 'hostFingerprint' | 'isDefault'>[];
  /** Present only when passwords were included. */
  secrets?: { kdf: 'scrypt'; salt: string; iv: string; tag: string; data: string };
}

export interface ImportPreview {
  filePath: string;
  names: string[];
  encryptedPasswords: boolean;
}

const deriveKey = (passphrase: string, salt: Buffer) => crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export async function exportConnections(win: BrowserWindow, ids: string[], passphrase: string | null): Promise<string | null> {
  const all = store.listConnections().filter((c) => ids.includes(c.id));
  if (!all.length) throw new Error('Select at least one connection to export.');
  if (passphrase !== null && passphrase.length < 8) throw new Error('The passphrase must be at least 8 characters.');

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export connections',
    defaultPath: `connections-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'Connections (JSON)', extensions: ['json'] }],
  });
  if (canceled || !filePath) return null;

  const out: ExportFile = {
    format: FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    connections: all.map(({ hasSaved: _h, ...c }) => c),
  };
  const profileIds = [...new Set(all.filter((c) => c.ssh.enabled && c.ssh.profileId).map((c) => c.ssh.profileId!))];
  const profiles = profileIds.map((id) => store.getProfile(id)).filter((p): p is SshProfile => !!p);
  if (profiles.length) out.sshProfiles = profiles.map(({ hasSaved: _h, hostFingerprint: _f, isDefault: _d, ...p }) => p);
  if (passphrase !== null) {
    const secrets: Record<string, Secrets> = {};
    for (const c of all) {
      const s = await store.getSavedSecrets(c.id);
      if (s.dbPassword || s.sshPassword || s.sshPassphrase) secrets[c.id] = s;
    }
    for (const p of profiles) {
      const s = await store.getProfileSecrets(p.id);
      if (s.sshPassword || s.sshPassphrase) secrets['profile:' + p.id] = s;
    }
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
    out.secrets = { kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2), 'utf8');
  return filePath;
}

function readExportFile(filePath: string): ExportFile {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error('This file is not a connections export (not valid JSON).');
  }
  if (!parsed || !LEGACY_FORMATS.includes(parsed.format) || !Array.isArray(parsed.connections)) {
    throw new Error('This file is not a connections export from this app.');
  }
  return parsed as ExportFile;
}

/** Step 1: pick a file and show what is in it. */
export async function previewImport(win: BrowserWindow): Promise<ImportPreview | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import connections',
    filters: [{ name: 'Connections (JSON)', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  const f = readExportFile(filePaths[0]);
  return { filePath: filePaths[0], names: f.connections.map((c) => String(c.name ?? '(unnamed)')), encryptedPasswords: !!f.secrets };
}

/** Only copy known fields with the right types, so a crafted file cannot inject anything odd. */
function clean(c: any): ConnectionConfig {
  const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
  const num = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536 ? (v as number) : d);
  const type = c?.type === 'mssql' ? 'mssql' : 'mysql';
  const ssh = c?.ssh ?? {};
  return {
    id: '',
    name: str(c?.name, 'Imported connection').slice(0, 100),
    type,
    host: str(c?.host),
    port: num(c?.port, type === 'mysql' ? 3306 : 1433),
    database: str(c?.database),
    user: str(c?.user),
    readOnly: c?.readOnly !== false, // imported connections are read-only unless explicitly not
    askPassword: !!c?.askPassword,
    color: typeof c?.color === 'string' ? c.color : undefined,
    mssqlEncrypt: c?.mssqlEncrypt !== false,
    mssqlTrustCert: c?.mssqlTrustCert !== false,
    ssh: {
      enabled: !!ssh.enabled,
      host: str(ssh.host),
      port: num(ssh.port, 22),
      user: str(ssh.user),
      auth: ssh.auth === 'key' ? 'key' : 'password',
      keyPath: typeof ssh.keyPath === 'string' ? ssh.keyPath : undefined,
    },
  };
}

function cleanProfile(p: any): SshProfile {
  const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
  return {
    id: '',
    name: str(p?.name, 'Imported SSH profile').slice(0, 100),
    host: str(p?.host),
    port: Number.isInteger(p?.port) && p.port > 0 && p.port < 65536 ? p.port : 22,
    user: str(p?.user),
    auth: p?.auth === 'key' ? 'key' : 'password',
    keyPath: typeof p?.keyPath === 'string' ? p.keyPath : undefined,
    askPassword: !!p?.askPassword,
    isDefault: false,
  };
}

/** Step 2: import. passphrase null = import without passwords. */
export async function importConnections(filePath: string, passphrase: string | null): Promise<{ imported: string[] }> {
  const f = readExportFile(filePath);
  let secrets: Record<string, Secrets> = {};
  if (f.secrets && passphrase !== null) {
    try {
      const s = f.secrets;
      const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, Buffer.from(s.salt, 'base64')), Buffer.from(s.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
      secrets = JSON.parse(Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch {
      throw new Error('Wrong passphrase (or the file was changed). Nothing was imported.');
    }
  }
  // SSH profiles: reuse an identical existing profile, otherwise create one. Old id → new id.
  const profileMap = new Map<string, string>();
  const known = store.listProfiles();
  for (const raw of Array.isArray(f.sshProfiles) ? f.sshProfiles : []) {
    const p = cleanProfile(raw);
    const same = known.find((k) => k.host === p.host && k.port === p.port && k.user === p.user && k.auth === p.auth && (k.keyPath ?? '') === (p.keyPath ?? ''));
    if (same) { profileMap.set(String((raw as any)?.id), same.id); continue; }
    let name = p.name;
    for (let i = 2; known.some((k) => k.name.toLowerCase() === name.toLowerCase()); i++) name = `${p.name} (${i})`;
    const s = secrets['profile:' + String((raw as any)?.id)] ?? {};
    const created = await store.saveProfile({ ...p, name }, p.askPassword ? {} : {
      sshPassword: typeof s.sshPassword === 'string' ? s.sshPassword : undefined,
      sshPassphrase: typeof s.sshPassphrase === 'string' ? s.sshPassphrase : undefined,
    });
    known.push(created);
    profileMap.set(String((raw as any)?.id), created.id);
  }

  const existingNames = new Set(store.listConnections().map((c) => c.name.toLowerCase()));
  const imported: string[] = [];
  for (const raw of f.connections) {
    const c = clean(raw);
    const oldProfile = (raw as any)?.ssh?.profileId;
    if (c.ssh.enabled && oldProfile && profileMap.has(String(oldProfile))) c.ssh.profileId = profileMap.get(String(oldProfile));
    let name = c.name;
    for (let i = 2; existingNames.has(name.toLowerCase()); i++) name = `${c.name} (${i})`;
    c.name = name;
    existingNames.add(name.toLowerCase());
    const s = secrets[String((raw as any)?.id)] ?? {};
    await store.saveConnection(c, c.askPassword ? {} : {
      dbPassword: typeof s.dbPassword === 'string' ? s.dbPassword : undefined,
      sshPassword: typeof s.sshPassword === 'string' ? s.sshPassword : undefined,
      sshPassphrase: typeof s.sshPassphrase === 'string' ? s.sshPassphrase : undefined,
    });
    imported.push(name);
  }
  return { imported };
}
