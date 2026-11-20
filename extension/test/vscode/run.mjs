// Launch a real VS Code with the built extension and run test/vscode/suite.ts inside it.
// Needs: TrueForge running, scripts/mock-llm.mjs on 7900 and a failing one on 7901,
// scripts/setup-mock-providers.mjs run once, and a Flask 3.1.3 checkout (ANVIL_FIXTURE).
//   ANVIL_FIXTURE=../../flask-3.1.3 VSCODE_PATH=/usr/share/code/code node test/vscode/run.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as esbuild from 'esbuild';
import { runTests } from '@vscode/test-electron';

const ext = resolve('.');
const fixture = resolve(process.env.ANVIL_FIXTURE ?? '../../flask-3.1.3');
const REAL = !!process.env.ANVIL_REAL;
let work = fixture;
if (!REAL) {
  // Fresh git copy of the fixture (without its virtualenv), so tests can check `git status`.
  work = mkdtempSync(join(tmpdir(), 'anvil-ws-'));
  execFileSync('git', ['clone', '-q', fixture, work]);
  mkdirSync(join(work, '.vscode'), { recursive: true });
  writeFileSync(join(work, '.vscode', 'settings.json'), JSON.stringify({ 'anvil.models': ['mock/mock-coder'], 'anvil.mcpPort': 7811, 'anvil.retriesPerModel': 1 }, null, 2));
  writeFileSync(join(work, '.git', 'info', 'exclude'), '.vscode/\n');
}

await esbuild.build({
  entryPoints: [REAL ? 'test/vscode/real.ts' : 'test/vscode/suite.ts'],
  outfile: 'dist/test/suite.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  tsconfig: 'tsconfig.json',
  logLevel: 'error',
});

const userData = mkdtempSync(join(tmpdir(), 'anvil-ud-'));
try {
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH,
    extensionDevelopmentPath: ext,
    extensionTestsPath: join(ext, 'dist', 'test', 'suite.js'),
    launchArgs: [work, '--disable-extensions', '--user-data-dir', userData, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
  });
  console.log(`workspace used: ${work}`);
} catch (e) {
  console.error(`in-editor tests failed (workspace: ${work})`);
  process.exit(1);
}
