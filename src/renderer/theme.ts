// Light / dark / system theme. The choice is remembered per PC (localStorage).
// "system" follows the Windows setting (Settings → Personalization → Colors) and updates live.

import { monaco } from './monacoSetup';

export type ThemePref = 'system' | 'dark' | 'light';
const KEY = 'app.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

monaco.editor.defineTheme('app-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#ffffff' },
});

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function isDark(pref = getThemePref()): boolean {
  return pref === 'system' ? media.matches : pref === 'dark';
}

/** Monaco theme name for the current theme (used when an editor is created). */
export function editorTheme(): string {
  return isDark() ? 'litesql-dark' : 'app-light';
}

export function applyTheme() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  monaco.editor.setTheme(dark ? 'litesql-dark' : 'app-light');
  for (const l of listeners) l();
}

export function setThemePref(pref: ThemePref) {
  try { localStorage.setItem(KEY, pref); } catch { /* ignore */ }
  applyTheme();
}

export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

media.addEventListener('change', () => { if (getThemePref() === 'system') applyTheme(); });
