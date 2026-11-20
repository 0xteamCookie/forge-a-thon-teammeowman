#!/usr/bin/env node
// Register model providers in the local TrueForge from config/models.json, reading API keys from
// the environment. Prints the "anvil.models" setting to use, and can write it into a workspace.
//
//   node scripts/setup-models.mjs                         # register providers whose key env var is set
//   node scripts/setup-models.mjs --workspace ../flask    # also write .vscode/settings.json there
//   node scripts/setup-models.mjs --break openai          # Task C: replace that provider's key with an invalid one
//
// Rerun without --break to restore the real key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = join(here, '..', 'config', existsSync(join(here, '..', 'config', 'models.json')) ? 'models.json' : 'models.example.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const TF = (process.env.TRUEFORGE_URL ?? cfg.trueforgeUrl ?? 'http://localhost:8790').replace(/\/$/, '');
const breakName = flag('--break');

console.log(`TrueForge: ${TF}   config: ${cfgPath}`);
let ok = 0;
for (const p of cfg.providers) {
  const id = p.type === 'custom' ? p.name : p.type;
  const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : 'local';
  if (!key) {
    console.log(`  skip ${id}: ${p.apiKeyEnv} is not set`);
    continue;
  }
  const manifest = {
    type: p.type,
    ...(p.type === 'custom' ? { name: p.name } : {}),
    ...(p.base_url ? { base_url: p.base_url } : {}),
    auth: { api_key: breakName === id ? 'invalid-key-for-task-c' : key },
    models: p.models.map(m => ({
      name: m.name,
      model_id: m.model_id,
      properties: { context_length: m.context_length, max_output_tokens: m.max_output_tokens },
    })),
  };
  const res = await fetch(`${TF}/api/v1/settings/model-providers`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
  if (res.ok) {
    ok++;
    console.log(`  ${breakName === id ? 'BROKE' : 'ok  '} ${id}: ${p.models.map(m => `${id}/${m.name}`).join(', ')}`);
  } else {
    console.log(`  FAIL ${id}: HTTP ${res.status} ${await res.text()}`);
  }
}
console.log(`\n${ok} provider(s) registered.`);
console.log(`\nAnvil model order (primary first, then automatic fallbacks):\n  "anvil.models": ${JSON.stringify(cfg.anvilModels)}`);

const ws = flag('--workspace');
if (ws) {
  const dir = join(resolve(ws), '.vscode');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  current['anvil.models'] = cfg.anvilModels;
  current['anvil.trueforgeUrl'] = TF;
  writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  console.log(`\nWrote ${file}`);
}
