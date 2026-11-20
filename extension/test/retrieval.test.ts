// Retrieval regression test against the pinned Flask checkout (skipped if not present).
// Run: ANVIL_FIXTURE=/path/to/flask-3.1.3 npm test
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { WorkspaceIndex } from '../src/context/index';
import { assembleContext } from '../src/context/retrieve';

const FLASK = process.env.ANVIL_FIXTURE;
const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
const TASK_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";

test('Task B: the three files that must change rank in the top 3, within budget', { skip: !FLASK || !existsSync(FLASK ?? '') }, async () => {
  const idx = await WorkspaceIndex.build(FLASK!);
  const pack = assembleContext(idx, TASK_B, { budget: 10000 });
  const files = [...new Set(pack.items.map(i => i.file))];
  assert.deepEqual(files.slice(0, 3).sort(), ['docs/cli.rst', 'src/flask/cli.py', 'tests/test_cli.py']);
  assert.ok(pack.used <= pack.budget);
  for (const it of pack.items) assert.ok(it.reasons.length > 0, `${it.file} has no reason`);
});

test('Task A: inline context finds get_debug_flag callers without the current file', { skip: !FLASK || !existsSync(FLASK ?? '') }, async () => {
  const idx = await WorkspaceIndex.build(FLASK!);
  const pack = assembleContext(idx, `${TASK_A}\ndef get_debug_flag() -> bool:`, { budget: 2500, maxFiles: 3, exclude: ['src/flask/helpers.py'] });
  assert.ok(pack.used <= 2500);
  assert.ok(!pack.items.some(i => i.file === 'src/flask/helpers.py'));
});
