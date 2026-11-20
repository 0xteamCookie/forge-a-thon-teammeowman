#!/usr/bin/env node
// Registers the mock model providers in a local TrueForge (dev/testing only):
//   mock/mock-coder    -> scripts/mock-llm.mjs on :7900 (works)
//   broken/mock-coder  -> :7901 with MOCK_FAIL=401 (always fails; used to test fallback)
const TF = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';

async function upsert(name, port) {
  const manifest = {
    type: 'custom',
    name,
    base_url: `http://127.0.0.1:${port}/v1`,
    auth: { api_key: 'not-a-real-key' },
    models: [{ name: 'mock-coder', model_id: 'mock-coder', properties: { context_length: 128000, max_output_tokens: 4096 } }],
  };
  const res = await fetch(`${TF}/api/v1/settings/model-providers`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
  console.log(`${name}: HTTP ${res.status} ${res.ok ? '' : await res.text()}`);
}

await upsert('mock', 7900);
await upsert('broken', 7901);
