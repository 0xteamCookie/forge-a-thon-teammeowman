#!/usr/bin/env node
// Register model providers in the local TrueForge, reading API keys from the environment.
//
// Profile (which providers/models) is chosen in this order:
//   --profile anthropic|openai  >  config/models.json (your own)  >  ANTHROPIC_API_KEY set  >  OPENAI_API_KEY set
//
//   node scripts/setup-models.mjs                        # register, check models exist for your key
//   node scripts/setup-models.mjs --workspace ../flask   # also write anvil.models into that workspace
//   node scripts/setup-models.mjs --break primary        # Task C: invalidate the primary model's key (no key needed)
//
// Rerun without --break to restore the real key. Model ids in the OpenAI profile can be overridden with
// OPENAI_PRIMARY_MODEL / OPENAI_FALLBACK_MODEL.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const configDir = join(here, '..', 'config');
const stateFile = join(configDir, '.active-profile');
const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const breakArg = flag('--break');
const PROFILES = { anthropic: 'models.example.json', openai: 'models.openai.example.json' };

function pickConfig() {
  const forced = flag('--profile') ?? process.env.ANVIL_PROFILE;
  if (forced) {
    if (!PROFILES[forced]) throw new Error(`unknown profile "${forced}" (use anthropic or openai)`);
    return { file: PROFILES[forced], profile: forced };
  }
  if (existsSync(join(configDir, 'models.json'))) return { file: 'models.json', profile: 'custom' };
  // --break needs no key, so reuse whatever profile was last registered.
  if (breakArg && existsSync(stateFile)) {
    const last = readFileSync(stateFile, 'utf8').trim();
    if (PROFILES[last]) return { file: PROFILES[last], profile: last };
  }
  if (process.env.ANTHROPIC_API_KEY) return { file: PROFILES.anthropic, profile: 'anthropic' };
  if (process.env.OPENAI_API_KEY) return { file: PROFILES.openai, profile: 'openai' };
  throw new Error('No API key found. Export ANTHROPIC_API_KEY or OPENAI_API_KEY first.');
}

let picked;
try {
  picked = pickConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const cfgPath = join(configDir, picked.file);
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const env = name => process.env[name] || cfg.defaults?.[name] || '';
const slug = id => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Resolve $VARS in model ids and "auto" names.
for (const p of cfg.providers) {
  p.id = p.type === 'custom' ? p.name : p.type;
  for (const m of p.models) {
    m.model_id = m.model_id.replace(/^\$([A-Z0-9_]+)$/, (_, v) => env(v));
    if (m.name === 'auto') m.name = slug(m.model_id);
  }
}
if (cfg.anvilModels === 'auto') cfg.anvilModels = cfg.providers.map(p => `${p.id}/${p.models[0].name}`);

const TF = (process.env.TRUEFORGE_URL ?? cfg.trueforgeUrl ?? 'http://localhost:8790').replace(/\/$/, '');
const breakId = breakArg === 'primary' ? cfg.providers[0].id : breakArg;
console.log(`TrueForge: ${TF}   profile: ${picked.profile} (${picked.file})`);

/** Ask the provider which models this key can use, so a wrong id fails now, not on camera. */
async function checkModels(p, key) {
  const base = (p.base_url ?? '').replace(/\/$/, '');
  let url;
  let headers;
  if (p.type === 'openai' || base === 'https://api.openai.com/v1') {
    url = 'https://api.openai.com/v1/models';
    headers = { authorization: `Bearer ${key}` };
  } else if (p.type === 'anthropic' || base === 'https://api.anthropic.com/v1') {
    url = 'https://api.anthropic.com/v1/models?limit=100';
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  } else return true; // other endpoints: nothing to check against
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.log(`  FAIL ${p.id}: the key was rejected (HTTP ${res.status}). Check ${p.apiKeyEnv}.`);
    return false;
  }
  const ids = ((await res.json()).data ?? []).map(m => m.id);
  const missing = p.models.filter(m => !ids.includes(m.model_id));
  for (const m of missing) {
    const near = ids.filter(i => /^(gpt|o\d|claude)/.test(i)).sort().slice(-25);
    console.log(`  FAIL ${p.id}: model "${m.model_id}" is not available to this key.`);
    console.log(`       Available: ${near.join(', ')}`);
    if (p.type === 'openai' || p.name === 'openai-compat') console.log('       Pick one with: export OPENAI_PRIMARY_MODEL=... OPENAI_FALLBACK_MODEL=...');
  }
  return missing.length === 0;
}

let ok = 0;
let failed = 0;
for (const p of cfg.providers) {
  // --break only touches the primary provider and needs no real key, so it is safe on camera.
  if (breakId && breakId !== p.id) continue;
  const key = breakId ? 'invalid-key-for-task-c' : p.apiKeyEnv ? process.env[p.apiKeyEnv] : 'local';
  if (!key) {
    console.log(`  FAIL ${p.id}: ${p.apiKeyEnv} is not set`);
    failed++;
    continue;
  }
  if (!breakId && !args.includes('--no-check') && !(await checkModels(p, key))) {
    failed++;
    continue;
  }
  const manifest = {
    type: p.type,
    ...(p.type === 'custom' ? { name: p.name } : {}),
    ...(p.base_url ? { base_url: p.base_url } : {}),
    auth: { api_key: key },
    models: p.models.map(m => ({
      name: m.name,
      model_id: m.model_id,
      properties: { context_length: m.context_length, max_output_tokens: m.max_output_tokens },
    })),
  };
  let res;
  try {
    res = await fetch(`${TF}/api/v1/settings/model-providers`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest }) });
  } catch {
    console.log(`  FAIL TrueForge is not running at ${TF}. Start it with scripts/start-trueforge.sh`);
    process.exit(1);
  }
  if (res.ok) {
    ok++;
    console.log(`  ${breakId ? 'BROKE' : 'ok  '} ${p.id}: ${p.models.map(m => `${p.id}/${m.name} (${m.model_id})`).join(', ')}`);
  } else {
    failed++;
    console.log(`  FAIL ${p.id}: HTTP ${res.status} ${await res.text()}`);
  }
}
if (!breakId && picked.profile !== 'custom') writeFileSync(stateFile, picked.profile + '\n');
console.log(`\n${ok} provider(s) registered${failed ? `, ${failed} FAILED` : ''}.`);
if (breakId) process.exit(failed ? 1 : 0);
console.log(`Anvil model order (primary first, then automatic fallback):\n  "anvil.models": ${JSON.stringify(cfg.anvilModels)}`);

const ws = flag('--workspace');
if (ws && !failed) {
  const dir = join(resolve(ws), '.vscode');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  current['anvil.models'] = cfg.anvilModels;
  current['anvil.trueforgeUrl'] = TF;
  writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  console.log(`Wrote ${file}`);
}
process.exit(failed ? 1 : 0);
