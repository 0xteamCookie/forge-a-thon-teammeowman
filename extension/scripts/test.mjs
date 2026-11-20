// Bundle each test with esbuild (handles TS + extensionless imports), then run with node:test.
import * as esbuild from 'esbuild';
import { readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), 'anvil-tests');
mkdirSync(out, { recursive: true });
const files = readdirSync('test').filter(f => f.endsWith('.test.ts'));
const built = [];
for (const f of files) {
  const outfile = join(out, f.replace(/\.ts$/, '.cjs'));
  await esbuild.build({ entryPoints: [join('test', f)], bundle: true, platform: 'node', format: 'cjs', outfile, tsconfig: 'tsconfig.json', logLevel: 'error', external: ['vscode'] });
  built.push(outfile);
}
const r = spawnSync(process.execPath, ['--test', ...built], { stdio: 'inherit', env: { ...process.env, ANVIL_FIXTURE: process.env.ANVIL_FIXTURE ?? '' } });
process.exit(r.status ?? 1);
