// Automatic updates from GitHub Releases (electron-updater).
//
// Settings → Updates:
//   auto   – check on start and every 6 h, download in the background, install on restart (default)
//   notify – check, but ask before downloading
//   off    – never check automatically ("Check for updates now" still works)
// Only active in the installed app. The update files (latest.yml + installer) are published with each release.

import { app, BrowserWindow, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateMode, UpdateStatus } from '../shared/types';

const RELEASES_URL = 'https://github.com/vvvinayc/rowlight/releases';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let getWin: () => BrowserWindow | null = () => null;
let last: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() };
let timer: NodeJS.Timeout | undefined;

function send(s: Partial<UpdateStatus>) {
  last = { ...last, ...s, currentVersion: app.getVersion() };
  getWin()?.webContents.send('update:status', last);
  if (process.env.ROWLIGHT_UPDATE_DEBUG) console.log('[update]', JSON.stringify(last));
}

export function updateStatus(): UpdateStatus {
  return last;
}

const enabled = () => app.isPackaged || !!process.env.ROWLIGHT_UPDATE_URL;

export function initUpdater(win: () => BrowserWindow | null, mode: UpdateMode) {
  getWin = win;
  if (!enabled()) return;
  // Test hook: a local folder/server with latest.yml instead of GitHub.
  if (process.env.ROWLIGHT_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.ROWLIGHT_UPDATE_URL });
  autoUpdater.autoInstallOnAppQuit = !process.env.ROWLIGHT_UPDATE_NO_INSTALL;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => send({ state: 'checking', error: undefined }));
  autoUpdater.on('update-available', (i) => send({ state: autoUpdater.autoDownload ? 'downloading' : 'available', version: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => send({ state: 'up-to-date', version: undefined }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => send({ state: 'downloaded', version: i.version, percent: 100 }));
  autoUpdater.on('error', (e) => send({ state: 'error', error: friendly(e) }));

  setMode(mode);
}

/** Applies the Settings choice (also when it changes while running). */
export function setMode(mode: UpdateMode) {
  if (!enabled()) return;
  autoUpdater.autoDownload = mode === 'auto';
  clearInterval(timer);
  timer = undefined;
  if (mode === 'off') return;
  setTimeout(() => checkNow(false), 8_000); // shortly after start-up, not during it
  timer = setInterval(() => checkNow(false), CHECK_EVERY_MS);
}

export async function checkNow(manual = true): Promise<UpdateStatus> {
  if (!enabled()) {
    send({ state: 'error', error: 'Updates only work in the installed app.' });
    return last;
  }
  if (last.state === 'downloading' || last.state === 'downloaded') return last;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    if (manual) send({ state: 'error', error: friendly(e) });
  }
  return last;
}

export async function download(): Promise<void> {
  send({ state: 'downloading', percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    send({ state: 'error', error: friendly(e) });
  }
}

/** Closes Rowlight, runs the installer silently and starts the new version. */
export function installNow() {
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

export function openReleases() {
  return shell.openExternal(RELEASES_URL);
}

function friendly(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|net::/i.test(msg)) return 'Could not reach GitHub to check for updates (offline or blocked by a proxy).';
  if (/404/.test(msg)) return 'No update information found on GitHub yet.';
  return 'Update check failed: ' + msg.split('\n')[0];
}
