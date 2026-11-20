// Live end-to-end check against a running TrueForge and scripts/mock-llm.mjs.
// Not part of `npm test`; run with `npm run e2e` (see README). Exercises:
//   TrueForge session -> deferred/preloaded MCP tools on our server -> approval pause on
//   edit_file -> resume -> MCP execution, plus automatic fallback from a failing model.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import coder from '../agents/anvil-coder.json';
import inline from '../agents/anvil-inline.json';
import { callKey, type EditorBridge, SERVER_NAME, startMcpHttp } from '../src/mcp/server';
import { applyEdits, type Edit } from '../src/review/edits';
import { type AgentTemplate, ResilientConversation, TrueForgeService } from '../src/trueforge/service';

const TF = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
const WORK = process.env.E2E_WORKDIR ?? mkdtempSync(path.join(tmpdir(), 'anvil-e2e-'));
writeFileSync(path.join(WORK, 'README.md'), '# Sample project\n\nHello.\n');
const approved = new Set<string>();
const calls: string[] = [];

const bridge: EditorBridge = {
  async readFile(p, s, e) {
    const lines = readFileSync(path.join(WORK, p), 'utf8').split('\n');
    const a = s ?? 1;
    const b = e ?? lines.length;
    return { text: `${p}\n${lines.slice(a - 1, b).map((l, i) => `${String(a + i).padStart(5)}| ${l}`).join('\n')}` };
  },
  async listFiles() {
    return { text: (await fs.readdir(WORK)).join('\n') };
  },
  async searchCode(q) {
    return { text: `no matches for ${q}` };
  },
  async findSymbol(n) {
    return { text: `no symbol ${n}` };
  },
  async retrieveContext(q) {
    return { text: `context for: ${q}` };
  },
  async executeWrite(tool, args) {
    if (!approved.has(callKey(tool, args))) return { text: 'Refused: no review on record', isError: true };
    const p = path.join(WORK, String(args.path));
    const r = applyEdits(readFileSync(p, 'utf8'), args.edits as Edit[]);
    if (!r.ok) return { text: r.error, isError: true };
    await fs.writeFile(p, r.text);
    return { text: `Updated ${args.path}: applied 1 of 1 hunk(s).` };
  },
  async runCommand(c) {
    return { text: `ran ${c}` };
  },
  onToolCall(name) {
    calls.push(name);
  },
};

test('live: agent turn pauses on edit_file, resumes after approval, writes via MCP', async () => {
  const svc = new TrueForgeService(TF, { coder: coder as AgentTemplate, inline: inline as AgentTemplate }, m => console.log('  [svc]', m));
  await svc.ping();
  const mcp = await startMcpHttp(bridge, 0, m => console.log('  [mcp]', m));
  try {
    await svc.registerMcp(SERVER_NAME, mcp.url, mcp.token);
    const conv = new ResilientConversation(svc, 'coder', () => ['mock/mock-coder'], () => 0);
    const events: string[] = [];
    let out = await conv.send([{ type: 'user.message', content: 'Mark the README title as edited.' }], {
      onEvent: e => events.push(e.type),
      onSession: (id, model, agent) => console.log(`  session ${id} model=${model} agent=${agent} -> ${svc.sessionUrl(id)}`),
    });
    console.log('  first turn:', out.status, out.pending.map(p => p.toolName), out.error ?? '');
    assert.equal(out.status, 'paused', `expected an approval pause, got ${out.status}: ${out.error ?? out.text}`);
    const p = out.pending[0];
    assert.equal(p.toolName, 'edit_file');
    approved.add(callKey(p.toolName, p.args));
    out = await conv.send([{ type: 'user.tool_approval', threadId: p.threadId, toolCallId: p.toolCallId, approval: { status: 'allow' } }], {});
    console.log('  resumed turn:', out.status, out.text.slice(0, 160));
    assert.equal(out.status, 'done');
    assert.match(readFileSync(path.join(WORK, 'README.md'), 'utf8'), /edited by mock-llm/);
    assert.ok(calls.includes('read_file') && calls.includes('edit_file'), `MCP calls seen: ${calls.join(',')}`);
    console.log('  event types:', [...new Set(events)].join(', '));
  } finally {
    await mcp.close();
  }
});

test('live: a failing primary model falls back automatically', async () => {
  const svc = new TrueForgeService(TF, { coder: coder as AgentTemplate, inline: inline as AgentTemplate }, () => {});
  const statuses: string[] = [];
  const conv = new ResilientConversation(svc, 'inline', () => ['broken/mock-coder', 'mock/mock-coder'], () => 1);
  const out = await conv.send(
    [{ type: 'user.message', content: 'File: a.py\n<selection>\nx = 1\n</selection>\nReply with code.' }],
    { onStatus: m => statuses.push(m) },
  );
  statuses.forEach(s => console.log('  status:', s));
  assert.equal(out.status, 'done', out.error);
  assert.equal(out.model, 'mock/mock-coder');
  assert.ok(statuses.some(s => /Retrying/.test(s)), 'expected a retry with backoff');
  assert.ok(statuses.some(s => /Falling back/.test(s)), 'expected an automatic fallback');
});
