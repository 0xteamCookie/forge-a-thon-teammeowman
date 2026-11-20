import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEdits } from '../src/review/edits';
import { applyHunks, computeHunks, pendingHunkAnchors, proposedText, stagedText } from '../src/review/hunks';
import { extractCode, fitIndent } from '../src/inline/parse';
import { callKey } from '../src/mcp/server';
import { analogueNouns, codeIdentifiers, parseMentions } from '../src/context/retrieve';

const ORIG = ['a', 'b', 'c', 'd', 'e', 'f', 'g', ''].join('\n');
const NEW = ['a', 'B', 'c', 'd', 'e2', 'e3', 'f', 'g', 'h', ''].join('\n');

test('hunks: every subset of hunks applies independently', () => {
  const hunks = computeHunks(ORIG, NEW);
  assert.equal(hunks.length, 3);
  assert.equal(applyHunks(ORIG, hunks, () => true), NEW);
  assert.equal(applyHunks(ORIG, hunks, () => false), ORIG);
  // accept only the middle hunk
  const mid = applyHunks(ORIG, hunks, h => h.id === 1);
  assert.equal(mid, ['a', 'b', 'c', 'd', 'e2', 'e3', 'f', 'g', ''].join('\n'));
});

test('hunks: staged/proposed converge as hunks are decided', () => {
  const hunks = computeHunks(ORIG, NEW);
  hunks[0].status = 'accepted';
  hunks[2].status = 'rejected';
  assert.equal(stagedText(ORIG, hunks), ['a', 'B', 'c', 'd', 'e', 'f', 'g', ''].join('\n'));
  assert.equal(proposedText(ORIG, hunks), ['a', 'B', 'c', 'd', 'e2', 'e3', 'f', 'g', ''].join('\n'));
  hunks[1].status = 'rejected';
  assert.equal(stagedText(ORIG, hunks), proposedText(ORIG, hunks));
});

test('hunks: anchors track line shifts of earlier hunks in the proposed text', () => {
  const hunks = computeHunks(ORIG, NEW);
  const anchors = pendingHunkAnchors(hunks);
  assert.deepEqual(
    anchors.map(a => a.line),
    [1, 4, 8],
  );
});

test('hunks: CRLF and missing trailing newline are preserved', () => {
  const o = 'x\r\ny\r\nz';
  const n = 'x\r\nY\r\nz';
  const h = computeHunks(o, n);
  assert.equal(applyHunks(o, h, () => true), n);
});

test('hunks: new file from empty original', () => {
  const h = computeHunks('', 'one\ntwo\n');
  assert.equal(h.length, 1);
  assert.equal(applyHunks('', h, () => true), 'one\ntwo\n');
});

test('edits: exact unique replacement', () => {
  const r = applyEdits('def f():\n    return 1\n', [{ old_string: '    return 1', new_string: '    return 2' }]);
  assert.ok(r.ok);
  assert.equal(r.ok && r.text, 'def f():\n    return 2\n');
});

test('edits: ambiguous match is refused, not guessed', () => {
  const r = applyEdits('x = 1\nx = 1\n', [{ old_string: 'x = 1', new_string: 'x = 2' }]);
  assert.equal(r.ok, false);
});

test('edits: wrong indentation is matched and re-indented', () => {
  const src = 'class A:\n    def f(self):\n        return 1\n';
  const r = applyEdits(src, [{ old_string: 'def f(self):\n    return 1', new_string: 'def f(self):\n    return 2' }]);
  assert.ok(r.ok, !r.ok ? r.error : '');
  assert.equal(r.ok && r.text, 'class A:\n    def f(self):\n        return 2\n');
});

test('edits: not found gives the model a hint', () => {
  const r = applyEdits('alpha\nbeta\n', [{ old_string: 'gamma beta', new_string: 'x' }]);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /not found/);
});

test('inline parse: fenced, streaming, unfenced', () => {
  assert.equal(extractCode('```python\nx = 1\ny = 2\n```\n', true), 'x = 1\ny = 2');
  assert.equal(extractCode('```python\nx = 1\ny = 2', false), 'x = 1');
  assert.equal(extractCode('```python\n', false), undefined);
  assert.equal(extractCode('x = 1\n', true), 'x = 1');
});

test('inline parse: restores dropped base indentation and newline shape', () => {
  const sel = '    def f():\n        return 1\n';
  assert.equal(fitIndent('def f():\n    return 2', sel, true), '    def f():\n        return 2\n');
});

test('callKey is order-insensitive for object keys', () => {
  assert.equal(callKey('edit_file', { b: 1, a: { y: 2, x: 1 } }), callKey('edit_file', { a: { x: 1, y: 2 }, b: 1 }));
  assert.notEqual(callKey('edit_file', { a: 1 }), callKey('write_file', { a: 1 }));
});

test('mentions and query analysis', () => {
  const { mentions } = parseMentions('fix @file:src/a.py and @sym:Foo.bar please');
  assert.deepEqual(mentions, [
    { kind: 'file', value: 'src/a.py' },
    { kind: 'symbol', value: 'Foo.bar' },
  ]);
  assert.ok(codeIdentifiers('rename get_debug_flag and FlaskGroup, not config').includes('get_debug_flag'));
  assert.ok(!codeIdentifiers('the config value').includes('config'));
  assert.ok(analogueNouns('Add a new built-in CLI command flask config that prints').includes('command'));
});
