// Parsing the model reply for inline edits. Pure; unit-tested.

/** Code inside the first fence; while streaming, a fence that has opened but not closed. */
export function extractCode(raw: string, final: boolean): string | undefined {
  const open = /```[^\n`]*\n/.exec(raw);
  if (!open) return final ? stripStray(raw) : undefined;
  const body = raw.slice(open.index + open[0].length);
  const close = body.indexOf('\n```');
  if (close >= 0) return body.slice(0, close);
  if (body.endsWith('```')) return body.slice(0, -3).replace(/\n$/, '');
  if (final) return body.replace(/\n$/, '');
  // Mid-stream: only whole lines, so the diff does not flicker on half-typed lines.
  const lastNl = body.lastIndexOf('\n');
  return lastNl >= 0 ? body.slice(0, lastNl) : undefined;
}

/** No fence at all: drop any stray fence lines and surrounding blank lines, keep indentation. */
function stripStray(raw: string): string {
  return raw
    .replace(/^[ \t]*```[^\n]*$/gm, '')
    .replace(/^\s*\n/, '')
    .replace(/\n\s*$/, '');
}

/**
 * Models sometimes drop the selection's base indentation. If every non-blank line of the reply
 * is indented less than the selection's first line, shift it back.
 */
export function fitIndent(code: string, selected: string, final: boolean): string {
  const firstSel = selected.split('\n').find(l => l.trim());
  const firstCode = code.split('\n').find(l => l.trim());
  let out = code;
  if (firstSel && firstCode) {
    const want = firstSel.length - firstSel.trimStart().length;
    const have = firstCode.length - firstCode.trimStart().length;
    if (have < want) {
      const pad = firstSel.slice(0, want - have);
      out = code
        .split('\n')
        .map(l => (l.trim() ? pad + l : l))
        .join('\n');
    }
  }
  // Keep the selection's trailing-newline shape so the hunk does not touch the next line.
  if (final && selected.endsWith('\n') && !out.endsWith('\n')) out += '\n';
  if (final && !selected.endsWith('\n') && out.endsWith('\n')) out = out.replace(/\n+$/, '');
  return out;
}
