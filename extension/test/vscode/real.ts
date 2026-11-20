// The three fixed tasks, with the exact PS wording, on a REAL model, inside VS Code, on the real
// Flask checkout. Auto-accepts every hunk and approval, then runs each on-screen verification.
// Run via: ANVIL_REAL=1 node test/vscode/run.mjs  (uses ANVIL_FIXTURE in place, resets it after)
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AnvilApi } from '../../src/extension';

const LOG = process.env.ANVIL_REAL_LOG ?? '/tmp/anvil-real.log';
const log = (m: string): void => {
  appendFileSync(LOG, m + '\n');
  console.log(m);
};
const ws = (): string => vscode.workspace.workspaceFolders![0].uri.fsPath;
const sh = (cmd: string, cwd = ws()): string => {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FLASK_DEBUG: undefined } as NodeJS.ProcessEnv });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}[exit != 0]`;
  }
};
const ANVIL = path.resolve(__dirname, '..', '..', '..');

async function waitFor<T>(what: string, fn: () => T | undefined | false, ms: number): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise(r => setTimeout(r, 200));
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

const TASK_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'anvil-agent')!;
  const api = (await ext.activate()) as AnvilApi;
  await api.ready();
  const which = (process.env.ANVIL_TASKS ?? 'A,B,C').split(',');
  const panelLog: string[] = [];
  const origPost = api.panel.post.bind(api.panel);
  api.panel.post = m => {
    if (m.type !== 'text') panelLog.push(JSON.stringify(m).slice(0, 700));
    origPost(m);
  };
  sh('git checkout -- . && git clean -fdq -e .venv -e .vscode');

  if (which.includes('A')) {
    log('\n=== TASK A (inline) ===');
    const t0 = Date.now();
    await selectFunction('src/flask/helpers.py', 'get_debug_flag');
    void vscode.commands.executeCommand('anvil.inlineEdit', TASK_A);
    const review = await waitFor('inline review', () => api.reviews.pending.find(r => !r.streaming && r.hunks.length > 0), 180000);
    log(`review ready in ${Date.now() - t0}ms with ${review.hunks.length} hunk(s)`);
    await vscode.commands.executeCommand('anvil.acceptAll', review.id);
    await waitFor('written', () => sh('git status --short').includes('helpers.py'), 20000);
    log(sh('git diff'));
    log(`VERIFY: ${sh(`FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`).trim()}`);
    for (const v of ['OFF', 'n', 'N', 'no', 'false', '0', '1', 'yes', 'on']) {
      log(`  FLASK_DEBUG=${v} -> ${sh(`FLASK_DEBUG=${v} .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`).trim()}`);
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    sh('git checkout -- .');
  }

  if (which.includes('B')) {
    log('\n=== TASK B (agent) ===');
    const t0 = Date.now();
    api.agent.newChat();
    panelLog.length = 0;
    let finished = false;
    const done = api.agent.run(TASK_B).finally(() => (finished = true));
    while (!finished && Date.now() - t0 < 15 * 60000) {
      for (const r of api.reviews.pending) if (!r.streaming && r.hunks.length) {
        log(`  review ${r.relPath}: ${r.hunks.length} hunk(s) -> accept all`);
        await vscode.commands.executeCommand('anvil.acceptAll', r.id);
      }
      for (const id of api.panel.pendingApprovals()) {
        log(`  approval ${id} -> allow`);
        api.panel.answer(id, true);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    await done;
    log(`agent finished in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    for (const m of panelLog) if (/"type":"(context|tool|thread|status|done|session|review|applied)"/.test(m)) log(`  panel: ${m}`);
    log(sh('git status --short'));
    log(sh('git diff --stat'));
    log(`VERIFY pytest: ${sh('.venv/bin/python -m pytest tests/test_cli.py -q 2>&1 | tail -3')}`);
    log(`VERIFY --help: ${sh('.venv/bin/flask --help 2>&1 | grep -iE "config|routes|shell|run"')}`);
    log(`VERIFY config: ${sh('../../.venv/bin/flask --app flaskr config 2>&1 | head -40', path.join(ws(), 'examples', 'tutorial'))}`);
    log('--- full diff ---\n' + sh('git diff'));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    sh('git checkout -- . && git clean -fdq -e .venv -e .vscode');
  }

  if (which.includes('C')) {
    log('\n=== TASK C (resilience) ===');
    log(sh('node scripts/setup-models.mjs --break anthropic 2>&1 | grep -E "BROKE|ok"', ANVIL));
    try {
      const t0 = Date.now();
      await selectFunction('src/flask/helpers.py', 'get_debug_flag');
      void vscode.commands.executeCommand('anvil.inlineEdit', TASK_A);
      const review = await waitFor('review after fallback', () => api.reviews.pending.find(r => !r.streaming && r.hunks.length > 0), 180000);
      log(`review arrived via fallback in ${Date.now() - t0}ms with ${review.hunks.length} hunk(s)`);
      await vscode.commands.executeCommand('anvil.rejectAll', review.id);
      await waitFor('closed', () => api.reviews.pending.length === 0, 10000);
      log(`VERIFY git status: "${sh('git status --short').trim()}" (empty = clean)`);
    } finally {
      log(sh('node scripts/setup-models.mjs 2>&1 | grep -E "ok|FAIL"', ANVIL));
    }
  }
  sh('git checkout -- . && git clean -fdq -e .venv -e .vscode');
  log('\n=== real run complete ===');
}
