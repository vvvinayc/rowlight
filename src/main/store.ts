// Local persistence: connections.json, settings.json and per-connection query history.
// Everything lives in %APPDATA%\Rowlight. Passwords are encrypted with Electron safeStorage
// (Windows DPAPI, tied to your Windows user account) and never sent to the renderer.

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ConnectionConfig, HistoryEntry, Secrets, Settings, SshProfile } from '../shared/types';
import { DEFAULT_SELECT_LIMIT } from '../shared/defaults';

interface StoredConnection extends Omit<ConnectionConfig, 'hasSaved'> {
  /** base64 of safeStorage.encryptString(...) */
  secrets: { dbPassword?: string; sshPassword?: string; sshPassphrase?: string };
}

const HISTORY_MAX = 1000;

function dataDir(): string {
  return app.getPath('userData');
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write to a temp file then rename, so a crash never leaves a half-written file. */
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

async function encrypt(plain: string): Promise<string> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('Windows encryption (DPAPI) is not available, so passwords cannot be saved. Use "Ask password every time".');
  }
  return (await safeStorage.encryptStringAsync(plain)).toString('base64');
}

async function decrypt(b64: string | undefined): Promise<string | undefined> {
  if (!b64) return undefined;
  try {
    return (await safeStorage.decryptStringAsync(Buffer.from(b64, 'base64'))).result;
  } catch {
    return undefined; // e.g. file copied from another Windows user
  }
}

// ---------- connections ----------

const connectionsFile = () => path.join(dataDir(), 'connections.json');

function loadStored(): StoredConnection[] {
  return readJson<StoredConnection[]>(connectionsFile(), []);
}

function toPublic(c: StoredConnection): ConnectionConfig {
  const { secrets, ...rest } = c;
  return {
    ...rest,
    hasSaved: {
      dbPassword: !!secrets?.dbPassword,
      sshPassword: !!secrets?.sshPassword,
      sshPassphrase: !!secrets?.sshPassphrase,
    },
  };
}

export function listConnections(): ConnectionConfig[] {
  return loadStored().map(toPublic);
}

export function getConnection(id: string): ConnectionConfig | undefined {
  const c = loadStored().find((x) => x.id === id);
  return c && toPublic(c);
}

export async function getSavedSecrets(id: string): Promise<Secrets> {
  const c = loadStored().find((x) => x.id === id);
  if (!c || c.askPassword) return {};
  return {
    dbPassword: await decrypt(c.secrets?.dbPassword),
    sshPassword: await decrypt(c.secrets?.sshPassword),
    sshPassphrase: await decrypt(c.secrets?.sshPassphrase),
  };
}

/**
 * Saves a connection. For each secret: a string replaces it, undefined keeps the saved one,
 * and an empty string clears it. With "ask password every time" nothing is stored.
 */
export async function saveConnection(input: ConnectionConfig, secrets: Secrets): Promise<ConnectionConfig> {
  const id = input.id || crypto.randomUUID();
  const existing = loadStored().find((x) => x.id === id);
  const { hasSaved: _ignored, ...cfg } = input;

  const nextSecrets: StoredConnection['secrets'] = {};
  if (!cfg.askPassword) {
    for (const key of ['dbPassword', 'sshPassword', 'sshPassphrase'] as const) {
      const v = secrets[key];
      if (v === undefined) nextSecrets[key] = existing?.secrets?.[key];
      else if (v !== '') nextSecrets[key] = await encrypt(v);
    }
  }
  // The trusted host key is managed by the main process: keep it unless the bastion address changed.
  const sameBastion = existing && existing.ssh.host === cfg.ssh.host && existing.ssh.port === cfg.ssh.port;
  cfg.ssh = { ...cfg.ssh, hostFingerprint: sameBastion ? existing.ssh.hostFingerprint : undefined };

  const stored: StoredConnection = { ...cfg, id, secrets: nextSecrets };
  const all = loadStored(); // re-read after the async encryption
  const idx = all.findIndex((x) => x.id === id);
  if (idx >= 0) all[idx] = stored;
  else all.push(stored);
  writeJson(connectionsFile(), all);
  return toPublic(stored);
}

export function deleteConnection(id: string): void {
  writeJson(connectionsFile(), loadStored().filter((x) => x.id !== id));
  try { fs.rmSync(historyFile(id)); } catch { /* none */ }
}

export function patchConnection(id: string, patch: Partial<StoredConnection>): void {
  const all = loadStored();
  const c = all.find((x) => x.id === id);
  if (!c) return;
  Object.assign(c, patch);
  writeJson(connectionsFile(), all);
}

export function setHostFingerprint(id: string, fingerprint: string): void {
  const all = loadStored();
  const c = all.find((x) => x.id === id);
  if (!c) return;
  c.ssh.hostFingerprint = fingerprint;
  writeJson(connectionsFile(), all);
}

// ---------- saved SSH profiles (shared bastions) ----------

interface StoredProfile extends Omit<SshProfile, 'hasSaved'> {
  secrets: { sshPassword?: string; sshPassphrase?: string };
}

const profilesFile = () => path.join(dataDir(), 'ssh-profiles.json');
const loadProfiles = () => readJson<StoredProfile[]>(profilesFile(), []);

function profileToPublic(p: StoredProfile): SshProfile {
  const { secrets, ...rest } = p;
  return { ...rest, hasSaved: { sshPassword: !!secrets?.sshPassword, sshPassphrase: !!secrets?.sshPassphrase } };
}

export function listProfiles(): SshProfile[] {
  return loadProfiles().map(profileToPublic);
}

export function getProfile(id: string): SshProfile | undefined {
  const p = loadProfiles().find((x) => x.id === id);
  return p && profileToPublic(p);
}

/** Same secret rules as saveConnection: string = replace, undefined = keep, '' = clear. */
export async function saveProfile(input: SshProfile, secrets: Secrets): Promise<SshProfile> {
  const id = input.id || crypto.randomUUID();
  const existing = loadProfiles().find((x) => x.id === id);
  const { hasSaved: _h, ...p } = input;
  const next: StoredProfile['secrets'] = {};
  if (!p.askPassword) {
    for (const key of ['sshPassword', 'sshPassphrase'] as const) {
      const v = secrets[key];
      if (v === undefined) next[key] = existing?.secrets?.[key];
      else if (v !== '') next[key] = await encrypt(v);
    }
  }
  const sameHost = existing && existing.host === p.host && existing.port === p.port;
  const stored: StoredProfile = { ...p, id, hostFingerprint: sameHost ? existing.hostFingerprint : undefined, secrets: next };
  let all = loadProfiles();
  if (stored.isDefault) all = all.map((x) => ({ ...x, isDefault: false })); // only one default
  const idx = all.findIndex((x) => x.id === id);
  if (idx >= 0) all[idx] = stored;
  else all.push(stored);
  writeJson(profilesFile(), all);
  return profileToPublic(stored);
}

/** Names of connections that use the profile (a used profile cannot be deleted). */
export function connectionsUsingProfile(id: string): string[] {
  return loadStored().filter((c) => c.ssh?.enabled && c.ssh.profileId === id).map((c) => c.name);
}

export function deleteProfile(id: string): void {
  const users = connectionsUsingProfile(id);
  if (users.length) throw new Error(`This SSH profile is used by: ${users.join(', ')}.\nSwitch those connections to another profile (or Custom) first.`);
  writeJson(profilesFile(), loadProfiles().filter((x) => x.id !== id));
}

export function setProfileFingerprint(id: string, fingerprint: string | undefined): void {
  const all = loadProfiles();
  const p = all.find((x) => x.id === id);
  if (!p) return;
  p.hostFingerprint = fingerprint;
  writeJson(profilesFile(), all);
}

export async function getProfileSecrets(id: string): Promise<Secrets> {
  const p = loadProfiles().find((x) => x.id === id);
  if (!p || p.askPassword) return {};
  return { sshPassword: await decrypt(p.secrets?.sshPassword), sshPassphrase: await decrypt(p.secrets?.sshPassphrase) };
}

/**
 * The connection as it is actually used: when it points to an SSH profile, the SSH settings
 * (and remembered host key) come from that profile.
 */
export function resolveConnection(cfg: ConnectionConfig): { cfg: ConnectionConfig; profile?: SshProfile } {
  if (!cfg.ssh?.enabled || !cfg.ssh.profileId) return { cfg };
  const p = getProfile(cfg.ssh.profileId);
  if (!p) throw new Error(`The SSH profile used by "${cfg.name}" no longer exists. Edit the connection and pick another SSH profile.`);
  return {
    cfg: { ...cfg, ssh: { ...cfg.ssh, host: p.host, port: p.port, user: p.user, auth: p.auth, keyPath: p.keyPath, hostFingerprint: p.hostFingerprint } },
    profile: p,
  };
}

/** Passwords to use for a connect/test: typed ones win, then the saved ones (SSH from the profile when used). */
export async function resolveSecrets(cfg: ConnectionConfig, typed: Secrets | undefined): Promise<Secrets> {
  const t = typed ?? {};
  const own = cfg.id ? await getSavedSecrets(cfg.id) : {};
  const prof = cfg.ssh?.enabled && cfg.ssh.profileId ? await getProfileSecrets(cfg.ssh.profileId) : {};
  // Order: typed now → the profile's saved secret → the connection's own saved secret
  // (fallback, e.g. a profile created from this connection before its password was copied).
  return {
    dbPassword: t.dbPassword || own.dbPassword,
    sshPassword: t.sshPassword || prof.sshPassword || own.sshPassword,
    sshPassphrase: t.sshPassphrase || prof.sshPassphrase || own.sshPassphrase,
  };
}

// ---------- repair of secrets encrypted by an older install ----------

/**
 * Re-encrypts saved secrets that this app's key cannot read but an older install's key can
 * (see secretRepair.ts). `getLegacyKeys` is only called when such a secret exists.
 * Returns how many secrets were repaired and how many stay unreadable.
 */
export async function repairSecrets(
  getLegacyKeys: () => Buffer[],
  decryptLegacy: (b64: string, key: Buffer) => string | undefined,
): Promise<{ repaired: number; unreadable: number }> {
  let keys: Buffer[] | undefined;
  let repaired = 0;
  let unreadable = 0;
  const fix = async (bag: Record<string, string | undefined> | undefined): Promise<boolean> => {
    let changed = false;
    for (const k of Object.keys(bag ?? {})) {
      const b64 = bag![k];
      if (!b64 || (await decrypt(b64)) !== undefined) continue;
      keys ??= getLegacyKeys();
      const plain = keys.map((key) => decryptLegacy(b64, key)).find((x) => x !== undefined);
      if (plain === undefined) { unreadable++; continue; }
      bag![k] = await encrypt(plain);
      repaired++;
      changed = true;
    }
    return changed;
  };
  const conns = loadStored();
  let connsChanged = false;
  for (const c of conns) if (await fix(c.secrets as Record<string, string | undefined>)) connsChanged = true;
  if (connsChanged) writeJson(connectionsFile(), conns);
  const profiles = loadProfiles();
  let profChanged = false;
  for (const p of profiles) if (await fix(p.secrets as Record<string, string | undefined>)) profChanged = true;
  if (profChanged) writeJson(profilesFile(), profiles);
  return { repaired, unreadable };
}

// ---------- settings ----------

const settingsFile = () => path.join(dataDir(), 'settings.json');

export function getSettings(): Settings {
  const s = readJson<Partial<Settings>>(settingsFile(), {});
  return {
    selectLimit: typeof s.selectLimit === 'number' ? s.selectLimit : DEFAULT_SELECT_LIMIT,
    zoomLevel: typeof s.zoomLevel === 'number' ? s.zoomLevel : 0,
    autoUpdate: s.autoUpdate === 'notify' || s.autoUpdate === 'off' ? s.autoUpdate : 'auto',
  };
}

export function saveSettings(s: Partial<Settings>): Settings {
  const cur = getSettings();
  const clean: Settings = {
    selectLimit: s.selectLimit === undefined ? cur.selectLimit : Math.max(0, Math.floor(Number(s.selectLimit) || 0)),
    zoomLevel: s.zoomLevel === undefined ? cur.zoomLevel : Math.max(-3, Math.min(5, Number(s.zoomLevel) || 0)),
    autoUpdate: s.autoUpdate === 'auto' || s.autoUpdate === 'notify' || s.autoUpdate === 'off' ? s.autoUpdate : cur.autoUpdate,
  };
  writeJson(settingsFile(), clean);
  return clean;
}

// ---------- history ----------

function historyFile(connectionId: string): string {
  return path.join(dataDir(), 'history', connectionId.replace(/[^\w-]/g, '_') + '.json');
}

export function getHistory(connectionId: string): HistoryEntry[] {
  return readJson<HistoryEntry[]>(historyFile(connectionId), []);
}

export function addHistory(connectionId: string, entry: HistoryEntry): void {
  const list = getHistory(connectionId);
  list.unshift(entry);
  writeJson(historyFile(connectionId), list.slice(0, HISTORY_MAX));
}

export function clearHistory(connectionId: string): void {
  writeJson(historyFile(connectionId), []);
}
