import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    // The SDK publishes a CJS build; prefer it so the extension host loads one module system.
    mainFields: ['main', 'module'],
    conditions: ['require', 'node'],
  },
  {
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

for (const b of builds) {
  const opts = { bundle: true, sourcemap: true, logLevel: 'info', tsconfig: 'tsconfig.json', ...b };
  if (watch) await (await esbuild.context(opts)).watch();
  else await esbuild.build(opts);
}
