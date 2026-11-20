// Pure hunk model: no vscode imports, so it is unit-testable under plain node.
//
// A hunk is a contiguous replacement expressed in ORIGINAL coordinates. Because hunks never
// overlap and always refer to the original text, any subset of them can be applied
// independently. That property is what makes per-hunk accept/reject exact.
import { diffArrays } from 'diff';

export type HunkStatus = 'pending' | 'accepted' | 'rejected';

export interface Hunk {
  id: number;
  /** 0-based index of the first original line this hunk replaces. */
  origStart: number;
  /** Original lines removed (may be empty for a pure insertion). */
  oldLines: string[];
  /** Lines inserted in their place (may be empty for a pure deletion). */
  newLines: string[];
  status: HunkStatus;
}

export interface TextShape {
  lines: string[];
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
}

export function splitText(text: string): TextShape {
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = text.replace(/\r\n/g, '\n');
  const trailingNewline = normalized.endsWith('\n');
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  return { lines: body.length === 0 && !trailingNewline ? [] : body.split('\n'), eol, trailingNewline };
}

export function joinText(shape: TextShape): string {
  const body = shape.lines.join(shape.eol);
  return shape.trailingNewline && shape.lines.length > 0 ? body + shape.eol : body;
}

/** Line-level diff of original vs proposed, grouped into hunks. */
export function computeHunks(originalText: string, proposedText: string): Hunk[] {
  const a = splitText(originalText).lines;
  const b = splitText(proposedText).lines;
  const parts = diffArrays(a, b);
  const hunks: Hunk[] = [];
  let origIndex = 0;
  let current: Hunk | undefined;
  const flush = (): void => {
    if (current) {
      hunks.push(current);
      current = undefined;
    }
  };
  for (const part of parts) {
    const values = part.value as string[];
    if (!part.added && !part.removed) {
      flush();
      origIndex += values.length;
      continue;
    }
    current ??= { id: hunks.length, origStart: origIndex, oldLines: [], newLines: [], status: 'pending' };
    if (part.removed) {
      current.oldLines.push(...values);
      origIndex += values.length;
    } else {
      current.newLines.push(...values);
    }
  }
  flush();
  return hunks;
}

/** Original text with the given hunks applied. Other hunks are left as original. */
export function applyHunks(originalText: string, hunks: readonly Hunk[], include: (h: Hunk) => boolean): string {
  const shape = splitText(originalText);
  const out: string[] = [];
  const chosen = hunks.filter(include).sort((x, y) => x.origStart - y.origStart);
  let cursor = 0;
  for (const h of chosen) {
    out.push(...shape.lines.slice(cursor, h.origStart));
    out.push(...h.newLines);
    cursor = h.origStart + h.oldLines.length;
  }
  out.push(...shape.lines.slice(cursor));
  // An empty original that gains content should end with a newline, like most source files.
  const trailingNewline = shape.lines.length === 0 ? true : shape.trailingNewline;
  return joinText({ ...shape, lines: out, trailingNewline });
}

/** Left side of the review: original + accepted hunks. */
export function stagedText(originalText: string, hunks: readonly Hunk[]): string {
  return applyHunks(originalText, hunks, h => h.status === 'accepted');
}

/** Right side of the review: original + accepted + still-pending hunks. */
export function proposedText(originalText: string, hunks: readonly Hunk[]): string {
  return applyHunks(originalText, hunks, h => h.status !== 'rejected');
}

/**
 * 0-based line in the proposed (right-hand) text where each pending hunk starts, so a CodeLens
 * can sit directly above it.
 */
export function pendingHunkAnchors(hunks: readonly Hunk[]): Array<{ hunk: Hunk; line: number }> {
  const anchors: Array<{ hunk: Hunk; line: number }> = [];
  let shift = 0;
  for (const h of [...hunks].sort((x, y) => x.origStart - y.origStart)) {
    if (h.status === 'rejected') continue;
    if (h.status === 'pending') anchors.push({ hunk: h, line: h.origStart + shift });
    shift += h.newLines.length - h.oldLines.length;
  }
  return anchors;
}

export function summarizeHunk(h: Hunk): string {
  return `+${h.newLines.length} -${h.oldLines.length} at line ${h.origStart + 1}`;
}

/** A unified-diff style rendering for tool results and the webview. */
export function renderHunk(h: Hunk): string {
  const header = `@@ -${h.origStart + 1},${h.oldLines.length} +${h.origStart + 1},${h.newLines.length} @@`;
  return [header, ...h.oldLines.map(l => `-${l}`), ...h.newLines.map(l => `+${l}`)].join('\n');
}
