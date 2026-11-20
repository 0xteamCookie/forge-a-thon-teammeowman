#!/usr/bin/env node
// A scripted OpenAI-compatible model for developing and testing Anvil without spending credits.
// It is NOT used in the demo; it exists so the loop (TrueForge -> MCP tools -> approval -> review)
// can be exercised deterministically.
//
//   node scripts/mock-llm.mjs                 # listens on 127.0.0.1:7900
//   MOCK_FAIL=401 node scripts/mock-llm.mjs   # every request fails (rehearse Task C)
//   MOCK_EDIT_PATH=README.md                  # file the scripted agent edits
//
// Register it in TrueForge as a custom provider with base URL http://127.0.0.1:7900/v1.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 7900);
const FAIL = process.env.MOCK_FAIL;
const EDIT_PATH = process.env.MOCK_EDIT_PATH ?? 'README.md';
const DELAY = Number(process.env.MOCK_TOKEN_DELAY_MS ?? 15);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const textOf = m => (typeof m.content === 'string' ? m.content : (m.content ?? []).map(p => p.text ?? '').join(''));

function plan(body) {
  const msgs = body.messages ?? [];
  const system = msgs.filter(m => m.role === 'system').map(textOf).join('\n');
  const tools = (body.tools ?? []).map(t => t.function?.name).filter(Boolean);
  const user = [...msgs].reverse().find(m => m.role === 'user');
  // Only this request's tool results: count after the latest user message.
  const lastUser = msgs.map(m => m.role).lastIndexOf('user');
  const toolResults = msgs.slice(lastUser + 1).filter(m => m.role === 'tool');
  const pick = suffix => tools.find(t => t === suffix || t.endsWith(suffix));

  if (/rewrite one selected region/i.test(system)) {
    const u = textOf(user ?? {});
    const sel = /<selection>\n([\s\S]*?)\n<\/selection>/.exec(u)?.[1] ?? '';
    const lines = sel.split('\n');
    const indent = (lines.find(l => l.trim()) ?? '').match(/^\s*/)[0];
    const out = [...lines.slice(0, 1), `${indent}# edited by mock-llm`, ...lines.slice(1)].join('\n');
    return { text: '```\n' + out + '\n```' };
  }

  const step = toolResults.length;
  const last = toolResults[toolResults.length - 1];
  if (step === 0 && pick('retrieve_context')) return { tool: pick('retrieve_context'), args: { query: textOf(user ?? {}).slice(0, 200) } };
  if (step <= 1 && pick('read_file')) return { tool: pick('read_file'), args: { path: EDIT_PATH, start_line: 1, end_line: 5 } };
  if (step === 2 && pick('edit_file')) {
    const first = /\n\s*1\| (.*)/.exec(textOf(last ?? {}))?.[1] ?? '';
    if (first) return { tool: pick('edit_file'), args: { path: EDIT_PATH, edits: [{ old_string: first, new_string: `${first} (edited by mock-llm)` }], explanation: 'Scripted mock edit.' } };
  }
  return { text: `Done. Tools offered: ${tools.join(', ') || '(none)'}. Tool results seen: ${step}.` };
}

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const tools = (body.tools ?? []).map(t => t.function?.name);
  console.error(`[mock] ${req.method} ${req.url} model=${body.model} msgs=${body.messages?.length ?? 0} tools=[${tools.join(',')}]`);

  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'mock-coder', object: 'model' }] }));
    return;
  }
  if (FAIL) {
    res.writeHead(Number(FAIL), { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `mock failure ${FAIL}`, type: 'invalid_request_error', code: 'invalid_api_key' } }));
    return;
  }
  const p = plan(body);
  const id = `chatcmpl-${Date.now()}`;
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
  if (!body.stream) {
    const message = p.tool
      ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${Date.now()}`, type: 'function', function: { name: p.tool, arguments: JSON.stringify(p.args) } }] }
      : { role: 'assistant', content: p.text };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: p.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  if (p.tool) {
    send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: p.tool, arguments: '' } }] }, finish_reason: null }] });
    const args = JSON.stringify(p.args);
    for (let i = 0; i < args.length; i += 40) {
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 40) } }] }, finish_reason: null }] });
      await sleep(DELAY);
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    for (const piece of p.text.match(/[\s\S]{1,6}/g) ?? []) {
      send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      await sleep(DELAY);
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  send({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  res.end('data: [DONE]\n\n');
});

server.listen(PORT, '127.0.0.1', () => console.error(`[mock] OpenAI-compatible mock on http://127.0.0.1:${PORT}/v1 ${FAIL ? `(failing with ${FAIL})` : ''}`));
