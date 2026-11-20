// Apply search/replace edits from the model. Pure, so it is unit-tested directly.
//
// Exact unique match first. If that fails, a whitespace-tolerant line match (weak models often
// get indentation slightly wrong), re-indenting the replacement by the observed offset. Never
// guesses between multiple matches: ambiguity is returned to the model as an error to fix.

export interface Edit {
  old_string: string;
  new_string: string;
}

export type EditResult = { ok: true; text: string; notes: string[] } | { ok: false; error: string };

export function applyEdits(original: string, edits: readonly Edit[]): EditResult {
  const crlf = original.includes('\r\n');
  let text = original.replace(/\r\n/g, '\n');
  const notes: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    const oldS = edits[i].old_string.replace(/\r\n/g, '\n');
    const newS = edits[i].new_string.replace(/\r\n/g, '\n');
    if (!oldS) return { ok: false, error: `edit ${i + 1}: old_string is empty. Use write_file to create a file.` };
    const count = occurrences(text, oldS);
    if (count === 1) {
      text = text.replace(oldS, () => newS);
      continue;
    }
    if (count > 1) {
      return { ok: false, error: `edit ${i + 1}: old_string matches ${count} places. Include more surrounding lines so it is unique.` };
    }
    const fuzzy = fuzzyLineMatch(text, oldS);
    if (fuzzy.kind === 'one') {
      const lines = text.split('\n');
      const replacement = reindent(newS, fuzzy.indentDelta);
      lines.splice(fuzzy.start, fuzzy.length, ...replacement.split('\n'));
      text = lines.join('\n');
      notes.push(`edit ${i + 1}: matched ignoring whitespace at line ${fuzzy.start + 1}`);
      continue;
    }
    if (fuzzy.kind === 'many') {
      return { ok: false, error: `edit ${i + 1}: old_string (ignoring whitespace) matches ${fuzzy.count} places. Include more surrounding lines.` };
    }
    const hint = closestLine(text, oldS);
    return {
      ok: false,
      error: `edit ${i + 1}: old_string was not found in the file. Copy it exactly from read_file output, without line-number prefixes.${hint ? ` Closest line: ${hint}` : ''}`,
    };
  }
  return { ok: true, text: crlf ? text.replace(/\n/g, '\r\n') : text, notes };
}

function occurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

type Fuzzy = { kind: 'none' } | { kind: 'many'; count: number } | { kind: 'one'; start: number; length: number; indentDelta: number };

function fuzzyLineMatch(text: string, oldS: string): Fuzzy {
  const hay = text.split('\n');
  const needle = oldS.replace(/\n+$/, '').split('\n');
  const key = (s: string): string => s.trim();
  const needleKeys = needle.map(key);
  if (needleKeys.every(k => k === '')) return { kind: 'none' };
  const hits: number[] = [];
  for (let s = 0; s + needle.length <= hay.length; s++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (key(hay[s + j]) !== needleKeys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(s);
  }
  if (hits.length === 0) return { kind: 'none' };
  if (hits.length > 1) return { kind: 'many', count: hits.length };
  const firstNonBlank = needle.findIndex(l => l.trim() !== '');
  const indentDelta = indentOf(hay[hits[0] + firstNonBlank]) - indentOf(needle[firstNonBlank]);
  return { kind: 'one', start: hits[0], length: needle.length, indentDelta };
}

function indentOf(s: string): number {
  return s.length - s.trimStart().length;
}

function reindent(s: string, delta: number): string {
  if (delta === 0) return s.replace(/\n$/, '');
  return s
    .replace(/\n$/, '')
    .split('\n')
    .map(l => {
      if (!l.trim()) return l;
      if (delta > 0) return ' '.repeat(delta) + l;
      const remove = Math.min(-delta, indentOf(l));
      return l.slice(remove);
    })
    .join('\n');
}

function closestLine(text: string, oldS: string): string | undefined {
  const first = oldS.split('\n').find(l => l.trim())?.trim();
  if (!first) return undefined;
  const lines = text.split('\n');
  let best: { i: number; score: number } | undefined;
  const words = new Set(first.split(/\W+/).filter(Boolean));
  lines.forEach((l, i) => {
    const w = l.split(/\W+/).filter(Boolean);
    const score = w.filter(x => words.has(x)).length;
    if (score > 0 && (!best || score > best.score)) best = { i, score };
  });
  return best ? `${best.i + 1}: ${lines[best.i].trim().slice(0, 120)}` : undefined;
}
