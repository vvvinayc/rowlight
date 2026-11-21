// Bundles test/*.test.ts with esbuild (so imports work like in the app) and runs them with node:test.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'node_modules', '.cache', 'litesql-tests');
fs.rmSync(out, { recursive: true, force: true });
const entries = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(root, 'test', f));
await esbuild.build({
  entryPoints: entries, outdir: out, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  packages: 'external', outExtension: { '.js': '.cjs' }, logLevel: 'warning',
});
const files = fs.readdirSync(out).filter((f) => f.endsWith('.cjs')).map((f) => path.join(out, f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root, env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') } });
process.exit(r.status ?? 1);
