// Build script (esbuild). Usage:
//   node scripts/build.mjs          production build into dist/
//   node scripts/build.mjs --dev    build with source maps, watch for changes and launch Electron
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const dev = process.argv.includes('--dev');
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });

const common = { bundle: true, sourcemap: dev, minify: !dev, logLevel: 'info' };

const configs = [
  {
    ...common,
    entryPoints: { 'main/main': 'src/main/main.ts', 'preload/preload': 'src/preload/preload.ts', 'bridge/bridge': 'src/bridge/bridge.ts' },
    outdir: out,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    packages: 'external', // ssh2, mysql2, mssql, exceljs and electron are loaded from node_modules
  },
  {
    ...common,
    entryPoints: {
      'renderer/app': 'src/renderer/main.tsx',
      'renderer/editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
    },
    outdir: out,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    loader: { '.ttf': 'file' },
    assetNames: 'renderer/[name]-[hash]',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  },
];

function copyStatic() {
  fs.mkdirSync(path.join(out, 'renderer'), { recursive: true });
  fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(out, 'renderer/index.html'));
}

if (!dev) {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  copyStatic();
} else {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.rebuild()));
  copyStatic();
  await Promise.all(contexts.map((c) => c.watch()));
  const electron = createRequire(import.meta.url)('electron');
  console.log('\nRenderer changes: press Ctrl+Shift+R in the app window (F12 = DevTools). Main-process changes: restart npm run dev.\n');
  const child = spawn(electron, ['.'], { stdio: 'inherit', cwd: root });
  child.on('exit', (code) => process.exit(code ?? 0));
}
