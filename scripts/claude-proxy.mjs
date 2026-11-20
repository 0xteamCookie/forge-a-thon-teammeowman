#!/usr/bin/env node
// Key-holding proxy for the Anthropic API, so teammates can record the demo without the real key.
//
//   ANTHROPIC_API_KEY=... node scripts/claude-proxy.mjs          # prints a team token
//   cloudflared tunnel --url http://127.0.0.1:8787               # public https URL for teammates
//
// Teammates authenticate with the team token (as x-api-key or Bearer). The proxy swaps it for the
// real key, forwards only the endpoints and models the demo needs, caps request volume, and streams
// responses through unchanged. Stop the process to revoke access instantly.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';

const REAL_KEY = process.env.ANTHROPIC_API_KEY;
if (!REAL_KEY) {
  console.error('ANTHROPIC_API_KEY is not set');
  process.exit(1);
}
const PORT = Number(process.env.PROXY_PORT ?? 8787);
const TOKEN = process.env.PROXY_TOKEN ?? `anvil-${randomBytes(18).toString('hex')}`;
const MODELS = new Set((process.env.PROXY_MODELS ?? 'claude-sonnet-5-5,claude-haiku-5-5').split(','));
const MAX_TOTAL = Number(process.env.PROXY_MAX_REQUESTS ?? 600);
const MAX_PER_MIN = Number(process.env.PROXY_MAX_PER_MINUTE ?? 40);
const UPSTREAM = 'https://api.anthropic.com';
const ALLOWED = [/^\/v1\/messages$/, /^\/v1\/messages\/count_tokens$/, /^\/v1\/models(\/[\w.-]+)?$/, /^\/v1\/chat\/completions$/];
// Forwarded as-is; everything else (host, cookies, cf-* tunnel headers, client auth) is dropped.
const PASS_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'user-agent'];

let total = 0;
const recent = [];

function tokenOk(req) {
  const given = req.headers['x-api-key'] ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(String(given));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message } }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const stamp = new Date().toISOString().slice(11, 19);
  if (url.pathname === '/health') return send(res, 200, 'ok');
  if (!tokenOk(req)) return send(res, 401, 'invalid team token');
  if (!ALLOWED.some(r => r.test(url.pathname))) return send(res, 403, `path not allowed: ${url.pathname}`);

  const now = Date.now();
  while (recent.length && now - recent[0] > 60_000) recent.shift();
  if (recent.length >= MAX_PER_MIN) return send(res, 429, 'proxy rate limit (per minute)');
  if (total >= MAX_TOTAL) return send(res, 429, 'proxy request budget used up');

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.method === 'POST' && body.length) {
    let model;
    try {
      model = JSON.parse(body.toString('utf8')).model;
    } catch {
      return send(res, 400, 'body is not JSON');
    }
    if (!MODELS.has(model)) return send(res, 403, `model not allowed: ${model}`);
  }
  recent.push(now);
  total++;

  const headers = {};
  for (const h of PASS_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
  // OpenAI-compatible calls send Bearer; native Anthropic calls send x-api-key. Answer in kind.
  if (url.pathname === '/v1/chat/completions') headers.authorization = `Bearer ${REAL_KEY}`;
  else headers['x-api-key'] = REAL_KEY;
  headers['anthropic-version'] ??= '2023-06-01';

  try {
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
    const out = {};
    upstream.headers.forEach((v, k) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v;
    });
    res.writeHead(upstream.status, out);
    console.log(`${stamp} #${total} ${req.method} ${url.pathname} -> ${upstream.status}`);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  } catch (e) {
    console.log(`${stamp} upstream error: ${e.message}`);
    if (!res.headersSent) send(res, 502, 'upstream unreachable');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude proxy on http://127.0.0.1:${PORT}  (models: ${[...MODELS].join(', ')}; cap ${MAX_TOTAL} requests, ${MAX_PER_MIN}/min)`);
  console.log(`TEAM TOKEN: ${TOKEN}`);
});
