// Runs INSIDE a real VS Code extension host (see run.mjs). Drives the built extension against a
// throwaway copy of Flask, with TrueForge local and the scripted mock model.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AnvilApi } from '../../src/extension';
import { PROPOSED_SCHEME } from '../../src/review/reviewManager';

const results: Array<{ name: string; ok: boolean; ms: number; err?: string }> = [];
const ws = (): string => vscode.workspace.workspaceFolders![0].uri.fsPath;
const disk = (rel: string): string => readFileSync(path.join(ws(), rel), 'utf8');
const gitStatus = (): string => execFileSync('git', ['status', '--short'], { cwd: ws() }).toString().trim();

async function waitFor<T>(what: string, fn: () => T | undefined | false, ms = 30000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

async function selectFunction(rel: string, name: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(path.join(ws(), rel));
  const ed = await vscode.window.showTextDocument(doc);
  const lines = doc.getText().split('\n');
  const start = lines.findIndex(l => l.startsWith(`def ${name}(`));
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith(' ') || lines[end] === '')) end++;
  while (lines[end - 1] === '') end--;
  ed.selection = new vscode.Selection(start, 0, end - 1, lines[end - 1].length);
}

const diffTabs = (): number =>
  vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === PROPOSED_SCHEME).length;

async function t(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, err: e instanceof Error ? e.stack ?? e.message : String(e) });
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'anvil-agent')!;
  const api = (await ext.activate()) as AnvilApi;
  const cfg = vscode.workspace.getConfiguration('anvil');
  const HELPERS = 'src/flask/helpers.py';

  await t('activation: index built, MCP registered in TrueForge', async () => {
    await api.ready();
    assert.ok(api.indexed(), 'index not built');
  });

  await t('Task A path: inline edit streams into a diff, accept writes, undo restores', async () => {
    const before = disk(HELPERS);
    await selectFunction(HELPERS, 'get_debug_flag');
    void vscode.commands.executeCommand('anvil.inlineEdit', "Treat 'off' and 'n' as false");
    const review = await waitFor('inline review ready', () => api.reviews.pending.find(r => !r.streaming && r.hunks.length > 0));
    assert.ok(diffTabs() >= 1, 'diff editor not open');
    const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: '/' + HELPERS, query: `review=${review.id}` }))) ?? [];
    assert.ok(lenses.some(l => l.command?.command === 'anvil.acceptHunk'), 'no per-hunk Accept CodeLens');
    assert.equal(disk(HELPERS), before, 'file written before review was decided');
    await vscode.commands.executeCommand('anvil.acceptAll', review.id);
    await waitFor('accepted change on disk', () => disk(HELPERS).includes('# edited by mock-llm'));
    await waitFor('diff tab closed', () => diffTabs() === 0);
    await vscode.commands.executeCommand('anvil.undoLastApply');
    await waitFor('undo restored file', () => disk(HELPERS) === before);
    assert.equal(gitStatus(), '', 'git status not clean after undo');
  });

  await t('Per-hunk review: accept one hunk, reject the other, only the accepted one is written', async () => {
    const rel = 'src/flask/__init__.py';
    const uri = vscode.Uri.file(path.join(ws(), rel));
    const original = disk(rel);
    const lines = original.split('\n');
    const proposed = ['# HUNK ONE', ...lines.slice(0, 3), '# HUNK TWO', ...lines.slice(3)].join('\n');
    const review = await api.reviews.open({ uri, original, proposed, isNew: false, title: 'test' });
    assert.equal(review.hunks.length, 2);
    const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: '/' + rel, query: `review=${review.id}` }))) ?? [];
    assert.equal(lenses.filter(l => l.command?.command === 'anvil.acceptHunk').length, 2, 'expected one Accept lens per hunk');
    await vscode.commands.executeCommand('anvil.acceptHunk', review.id, 0);
    await vscode.commands.executeCommand('anvil.rejectHunk', review.id, 1);
    const result = await review.done;
    assert.equal(result.accepted.length, 1);
    await api.reviews.write({ uri, relPath: rel, original, isNew: false }, result.finalText, 'test');
    const now = disk(rel);
    assert.ok(now.includes('# HUNK ONE') && !now.includes('# HUNK TWO'));
    await api.reviews.undoLast();
    assert.equal(disk(rel), original);
  });

  await t('Cancellation: Esc mid-stream leaves no review, no write, clean git status', async () => {
    const before = disk(HELPERS);
    await selectFunction(HELPERS, 'get_debug_flag');
    void vscode.commands.executeCommand('anvil.inlineEdit', 'make it slower please');
    await waitFor('streaming review', () => api.reviews.pending.find(r => r.streaming));
    await vscode.commands.executeCommand('anvil.cancel');
    await waitFor('review discarded', () => api.reviews.pending.length === 0);
    await waitFor('diff closed', () => diffTabs() === 0);
    assert.equal(disk(HELPERS), before);
    assert.ok(!vscode.workspace.textDocuments.some(d => d.isDirty), 'a dirty buffer was left behind');
    assert.equal(gitStatus(), '');
  });

  await t('Agent mode: TrueForge approval opens review; accept -> MCP write; undo', async () => {
    const before = disk('README.md');
    const done = api.agent.run('Mark the README title as edited.');
    const review = await waitFor('agent review for README.md', () => api.reviews.pending.find(r => r.relPath === 'README.md' && r.hunks.length > 0), 60000);
    assert.equal(disk('README.md'), before, 'agent wrote before review');
    await vscode.commands.executeCommand('anvil.acceptAll', review.id);
    await done;
    assert.match(disk('README.md'), /edited by mock-llm/);
    await api.reviews.undoLast();
    assert.equal(disk('README.md'), before);
  });

  await t('Agent mode: rejecting every hunk writes nothing', async () => {
    const before = disk('README.md');
    const done = api.agent.run('Mark the README title as edited.');
    const review = await waitFor('agent review', () => api.reviews.pending.find(r => r.relPath === 'README.md' && r.hunks.length > 0), 60000);
    await vscode.commands.executeCommand('anvil.rejectAll', review.id);
    await done;
    assert.equal(disk('README.md'), before, 'rejected hunks were written');
    assert.equal(gitStatus(), '');
  });

  await t('Agent mode: Stop while a review is open discards it and changes nothing', async () => {
    const before = disk('README.md');
    const done = api.agent.run('Mark the README title as edited.');
    await waitFor('agent review', () => api.reviews.pending.find(r => r.relPath === 'README.md'), 60000);
    await vscode.commands.executeCommand('anvil.cancel');
    await done;
    assert.equal(api.reviews.pending.length, 0);
    assert.equal(disk('README.md'), before);
    assert.equal(gitStatus(), '');
  });

  await t('Task C path: broken primary model -> automatic fallback, workspace unchanged', async () => {
    await cfg.update('models', ['broken/mock-coder', 'mock/mock-coder'], vscode.ConfigurationTarget.Workspace);
    try {
      const before = disk(HELPERS);
      await selectFunction(HELPERS, 'get_debug_flag');
      void vscode.commands.executeCommand('anvil.inlineEdit', "Treat 'off' and 'n' as false");
      const review = await waitFor('review after fallback', () => api.reviews.pending.find(r => !r.streaming && r.hunks.length > 0), 45000);
      await vscode.commands.executeCommand('anvil.rejectAll', review.id);
      await waitFor('review closed', () => api.reviews.pending.length === 0);
      assert.equal(disk(HELPERS), before);
      assert.equal(gitStatus(), '');
    } finally {
      await cfg.update('models', ['mock/mock-coder'], vscode.ConfigurationTarget.Workspace);
    }
  });

  console.log('\n===== Anvil in-editor results =====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms}ms)${r.err ? `\n      ${r.err.split('\n').slice(0, 4).join('\n      ')}` : ''}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(`===== ${results.length - failed} passed, ${failed} failed =====\n`);
  if (failed) throw new Error(`${failed} test(s) failed`);
}
