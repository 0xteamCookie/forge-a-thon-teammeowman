// Context assembly: explicit @mentions first, then ranked automatic retrieval, packed under a
// token budget. Every selected item carries the reasons it was chosen, and everything that
// was considered but cut is reported too, so the user can see the decision, not just the result.
import * as path from 'node:path';
import { type Chunk, stem, tokenize, type WorkspaceIndex } from './index';

export interface Mention {
  kind: 'file' | 'symbol';
  value: string;
}

export interface ContextItem {
  file: string;
  mode: 'full' | 'chunks' | 'outline';
  startLine?: number;
  endLine?: number;
  text: string;
  tokens: number;
  score: number;
  reasons: string[];
  source: 'mention' | 'retrieval';
}

export interface ContextPack {
  query: string;
  budget: number;
  used: number;
  items: ContextItem[];
  dropped: Array<{ file: string; score: number; reason: string }>;
  unresolvedMentions: string[];
  elapsedMs: number;
}

export const estimateTokens = (s: string): number => Math.ceil(s.length / 3.6);

const MENTION_RE = /@(file|sym|symbol):([^\s,;]+)/g;

export function parseMentions(text: string): { mentions: Mention[]; clean: string } {
  const mentions: Mention[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    mentions.push({ kind: m[1] === 'file' ? 'file' : 'symbol', value: m[2].replace(/[.)]+$/, '') });
  }
  return { mentions, clean: text };
}

interface Candidate {
  file: string;
  score: number;
  reasons: string[];
  chunks: Array<{ chunk: Chunk; score: number }>;
}

/** Intent cues in the request that should pull in a file's companions. */
function intents(query: string): { tests: boolean; docs: boolean } {
  const q = query.toLowerCase();
  return {
    tests: /\b(test|tests|tested|pytest|covered by a test|coverage)\b/.test(q),
    docs: /\b(doc|docs|document|documented|documentation|readme|changelog)\b/.test(q),
  };
}

export function assembleContext(
  index: WorkspaceIndex,
  query: string,
  opts: { budget: number; mentions?: Mention[]; maxFiles?: number; exclude?: string[] },
): ContextPack {
  const started = Date.now();
  const budget = opts.budget;
  const items: ContextItem[] = [];
  const dropped: ContextPack['dropped'] = [];
  const unresolved: string[] = [];
  let used = 0;
  const taken = new Set<string>(opts.exclude ?? []);

  // 1. Explicit mentions always go in first; they are the user's own choice.
  for (const m of opts.mentions ?? []) {
    if (m.kind === 'file') {
      const f = index.files.get(m.value) ?? [...index.files.values()].find(x => x.path.endsWith(m.value));
      if (!f) {
        unresolved.push(`@file:${m.value}`);
        continue;
      }
      const t = estimateTokens(f.text);
      const full = t <= Math.max(budget * 0.6, 4000);
      const text = full ? f.text : index.outline(f.path);
      items.push({ file: f.path, mode: full ? 'full' : 'outline', text, tokens: estimateTokens(text), score: Infinity, reasons: [full ? 'mentioned with @file' : `mentioned with @file (outline only: ${t} tokens is over the per-file cap)`], source: 'mention' });
      used += estimateTokens(text);
      taken.add(f.path);
    } else {
      const syms = index.findSymbols(m.value.includes('.') ? m.value.split('.').pop()! : m.value);
      if (!syms.length) {
        unresolved.push(`@sym:${m.value}`);
        continue;
      }
      for (const s of syms.slice(0, 3)) {
        const c = index.chunks.find(ch => ch.file === s.file && ch.startLine <= s.line && ch.endLine >= s.line && ch.tokens.length);
        if (!c) continue;
        items.push({ file: c.file, mode: 'chunks', startLine: c.startLine, endLine: c.endLine, text: c.text, tokens: estimateTokens(c.text), score: Infinity, reasons: [`mentioned with @sym (${s.kind} ${s.container ? s.container + '.' : ''}${s.name})`], source: 'mention' });
        used += estimateTokens(c.text);
      }
    }
  }

  // 2. Rank files for automatic retrieval.
  const terms = tokenize(query);
  const bm = index.bm25(terms);
  const byFile = new Map<string, Candidate>();
  const cand = (file: string): Candidate => {
    let c = byFile.get(file);
    if (!c) {
      c = { file, score: 0, reasons: [], chunks: [] };
      byFile.set(file, c);
    }
    return c;
  };
  for (const [id, { score, matched }] of bm) {
    const chunk = index.chunks[id];
    cand(chunk.file).chunks.push({ chunk, score });
    void matched;
  }
  const termSet = new Set(terms);
  for (const c of byFile.values()) {
    c.chunks.sort((a, b) => b.score - a.score);
    const top = c.chunks[0]?.score ?? 0;
    const rest = c.chunks.slice(1, 4).reduce((s, x) => s + x.score, 0);
    c.score = top + 0.35 * rest;
    const matched = new Set<string>();
    for (const { chunk } of c.chunks.slice(0, 4)) for (const t of chunk.tokens) if (termSet.has(t)) matched.add(t);
    if (matched.size) c.reasons.push(`text matches ${[...matched].slice(0, 6).map(t => `"${t}"`).join(', ')}`);
    const f = index.files.get(c.file)!;
    const pathHits = [...f.pathTokens].filter(t => termSet.has(t));
    if (pathHits.length) {
      c.score *= 1 + 0.5 * pathHits.length;
      c.reasons.push(`path matches ${pathHits.map(t => `"${t}"`).join(', ')}`);
    }
  }
  // Symbol-name hits: an identifier in the request that names a definition is a strong signal.
  // Only code-shaped tokens count (snake_case, CamelCase, `backticked`, call()), so the English
  // word "config" does not match `class Config`.
  for (const ident of codeIdentifiers(query)) {
    for (const s of index.findSymbols(ident).slice(0, 5)) {
      const c = cand(s.file);
      c.score += 12;
      c.reasons.push(`defines ${s.kind} \`${s.container ? s.container + '.' : ''}${s.name}\``);
    }
  }
  // Analogues: "add a new <thing>" belongs next to the existing <thing>s. Count definitions per
  // file whose name contains the noun (routes_command, shell_command -> cli.py for "command").
  for (const noun of analogueNouns(query)) {
    const perFile = new Map<string, string[]>();
    for (const s of index.symbols) {
      if (s.kind === 'variable') continue;
      const nameTokens = tokenize(s.name);
      if (nameTokens.includes(noun)) perFile.set(s.file, [...(perFile.get(s.file) ?? []), s.name]);
    }
    const qualifying = [...perFile].filter(([file, names]) => names.length >= 2 && !isTest(file));
    // A noun that names definitions in many files ("flask") says nothing about where to go.
    if (qualifying.length === 0 || qualifying.length > 3) continue;
    for (const [file, names] of qualifying) {
      const c = cand(file);
      c.score = c.score * (1 + 0.4 * Math.min(names.length, 5)) + 4 * Math.min(names.length, 5);
      c.reasons.push(`existing "${noun}" definitions live here: ${[...new Set(names)].slice(0, 4).map(n => `\`${n}\``).join(', ')}`);
    }
  }
  // Generated or vendored files are rarely what a request is about.
  for (const c of byFile.values()) {
    if (/(^|\/)(CHANGES|CHANGELOG|LICENSE)/i.test(c.file) || c.file.endsWith('.lock') || c.file.endsWith('.json')) c.score *= 0.3;
    if (c.file.startsWith('examples/')) c.score *= 0.5;
  }

  let ranked = [...byFile.values()].filter(c => c.score > 0 && !taken.has(c.file)).sort((a, b) => b.score - a.score);

  // 3. Structural expansion around the best source files: tests, docs, importers.
  const want = intents(query);
  const anchors = ranked.filter(c => !isTest(c.file) && !isDoc(c.file)).slice(0, 2);
  for (const a of anchors) {
    if (want.tests) {
      for (const t of testCounterparts(index, a.file)) {
        const c = cand(t);
        c.score = Math.max(c.score, a.score * 0.9);
        c.reasons.push(`test counterpart of ${a.file} (request asks for a test)`);
      }
    }
    if (want.docs) {
      const best = bestDocFor(index, a.file, terms);
      if (best) {
        const c = cand(best.file);
        c.score = Math.max(c.score, a.score * 0.85);
        c.reasons.push(`documentation for ${path.posix.basename(a.file, path.posix.extname(a.file))} (${best.why}; request asks for docs)`);
      }
    }
  }
  ranked = [...byFile.values()].filter(c => c.score > 0 && !taken.has(c.file)).sort((a, b) => b.score - a.score);

  // 4. Pack under budget. Breadth first: every selected file gets its single best view, so a
  //    companion (the docs page, the test file) is never starved by a big first file. Then
  //    depth: more chunks of the top files. Then outlines (signatures) for partially shown files.
  const maxFiles = opts.maxFiles ?? 8;
  const topScore = ranked[0]?.score ?? 0;
  const selected: Candidate[] = [];
  for (const c of ranked) {
    if (selected.length >= maxFiles) dropped.push({ file: c.file, score: c.score, reason: `file limit (${maxFiles}) reached` });
    else if (c.score < topScore * 0.2) dropped.push({ file: c.file, score: c.score, reason: 'below relevance cutoff (20% of top score)' });
    else selected.push(c);
  }
  const perFile = new Map<string, ContextItem[]>();
  const add = (c: Candidate, it: ContextItem): void => {
    perFile.set(c.file, [...(perFile.get(c.file) ?? []), it]);
    used += it.tokens;
  };
  const chunkItem = (c: Candidate, ch: Chunk, extra: string): ContextItem => ({
    file: c.file, mode: 'chunks', startLine: ch.startLine, endLine: ch.endLine, text: ch.text,
    tokens: estimateTokens(ch.text), score: c.score, reasons: dedupe([...c.reasons, extra]), source: 'retrieval',
  });
  const full = new Set<string>();
  const shownChunks = new Map<string, Set<number>>();
  for (const c of selected) {
    const f = index.files.get(c.file)!;
    const fileTokens = estimateTokens(f.text);
    if (fileTokens <= Math.min(budget * 0.12, budget - used)) {
      add(c, { file: c.file, mode: 'full', text: f.text, tokens: fileTokens, score: c.score, reasons: dedupe([...c.reasons, 'small enough to include whole']), source: 'retrieval' });
      full.add(c.file);
      continue;
    }
    const best = c.chunks[0]?.chunk ?? index.chunks[f.chunkIds[0]];
    if (best && estimateTokens(best.text) <= budget - used) {
      add(c, chunkItem(c, best, `best-matching ${best.kind}${best.symbol ? ` \`${best.symbol}\`` : ''}`));
      shownChunks.set(c.file, new Set([best.id]));
    } else {
      dropped.push({ file: c.file, score: c.score, reason: 'best chunk did not fit remaining budget' });
    }
  }
  for (const c of selected.slice(0, 4)) {
    if (full.has(c.file) || !shownChunks.has(c.file)) continue;
    for (const { chunk } of c.chunks.slice(1, 3)) {
      const t = estimateTokens(chunk.text);
      if (used + t > budget * 0.85) break;
      add(c, chunkItem(c, chunk, `also matches: ${chunk.kind}${chunk.symbol ? ` \`${chunk.symbol}\`` : ''}`));
      shownChunks.get(c.file)!.add(chunk.id);
    }
  }
  for (const c of selected) {
    if (full.has(c.file) || !shownChunks.has(c.file)) continue;
    const outline = index.outline(c.file);
    const t = estimateTokens(outline);
    if (outline && used + t <= budget) {
      add(c, { file: c.file, mode: 'outline', text: outline, tokens: t, score: c.score, reasons: ['outline of the rest of the file (signatures only)'], source: 'retrieval' });
    }
  }
  for (const c of selected) {
    const its = perFile.get(c.file);
    if (its) items.push(...its.sort((a, b) => (a.mode === 'outline' ? 1 : 0) - (b.mode === 'outline' ? 1 : 0) || (a.startLine ?? 0) - (b.startLine ?? 0)));
  }

  return { query, budget, used, items, dropped: dropped.slice(0, 12), unresolvedMentions: unresolved, elapsedMs: Date.now() - started };
}

export function codeIdentifiers(query: string): string[] {
  const out = new Set<string>();
  for (const m of query.matchAll(/`([^`]+)`/g)) for (const id of m[1].match(/[A-Za-z_]\w*/g) ?? []) out.add(id);
  for (const m of query.matchAll(/\b([A-Za-z_]\w*)\(/g)) out.add(m[1]);
  for (const id of query.match(/\b[A-Za-z_]\w*\b/g) ?? []) {
    if (/_/.test(id.replace(/^_+/, '')) || /[a-z][A-Z]/.test(id) || /^[A-Z][a-z]+[A-Z]/.test(id)) out.add(id);
  }
  return [...out].filter(x => x.length > 2);
}

/** Nouns the request asks to create more of: "add a new built-in CLI command" -> command. */
export function analogueNouns(query: string): string[] {
  const out = new Set<string>();
  // Take the few words after the verb + article; each is a candidate. A candidate only scores if
  // >= 2 existing definitions in one file share it, so filler words fall away on their own.
  const re = /\b(?:add|create|implement|introduce|write)\s+(?:(?:a|an|another|new|the)\s+)*((?:[\w-]+\s*){1,5})/gi;
  const skip = new Set(['test', 'that', 'which', 'way', 'built', 'in', 'support', 'option', 'flag']);
  for (const m of query.matchAll(re)) {
    for (const w of m[1].split(/[\s-]+/)) {
      const noun = stem(w.toLowerCase());
      if (noun.length > 2 && !skip.has(noun)) out.add(noun);
    }
  }
  return [...out];
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

const isTest = (f: string): boolean => /(^|\/)tests?\//.test(f) || /(^|\/)test_[^/]+\.py$/.test(f) || /\.(test|spec)\.[jt]sx?$/.test(f);
const isDoc = (f: string): boolean => /\.(rst|md)$/.test(f);

function testCounterparts(index: WorkspaceIndex, file: string): string[] {
  const base = path.posix.basename(file, path.posix.extname(file));
  const names = [`test_${base}.py`, `${base}_test.py`, `${base}.test.ts`, `${base}.spec.ts`, `${base}.test.js`];
  return [...index.files.keys()].filter(f => names.includes(path.posix.basename(f)));
}

function bestDocFor(index: WorkspaceIndex, file: string, terms: string[]): { file: string; why: string } | undefined {
  const base = path.posix.basename(file, path.posix.extname(file));
  const docs = [...index.files.keys()].filter(isDoc).filter(f => !/(^|\/)(CHANGES|CHANGELOG)/i.test(f));
  // Prefer a doc named after the module (docs/cli.rst for cli.py), then the one that mentions it most.
  const named = docs.find(d => path.posix.basename(d, path.posix.extname(d)) === base);
  if (named) return { file: named, why: `named after the module` };
  let best: { file: string; hits: number } | undefined;
  const termSet = new Set(terms);
  for (const d of docs) {
    const f = index.files.get(d)!;
    let hits = 0;
    for (const id of f.chunkIds) for (const t of index.chunks[id].tokens) if (termSet.has(t) || t === base) hits++;
    if (!best || hits > best.hits) best = { file: d, hits };
  }
  return best && best.hits > 0 ? { file: best.file, why: `${best.hits} term hits` } : undefined;
}

/** Render the pack as the context block the model sees. */
export function renderPack(pack: ContextPack): string {
  if (!pack.items.length) return '';
  const parts = [
    `<workspace_context budget_tokens="${pack.budget}" used_tokens="${pack.used}">`,
    'Files selected for this request. Line numbers are 1-based. Use read_file for anything not shown in full.',
  ];
  for (const it of pack.items) {
    const range = it.mode === 'chunks' ? ` lines="${(it.startLine ?? 0) + 1}-${(it.endLine ?? 0) + 1}"` : '';
    parts.push(`<file path="${it.file}" view="${it.mode}"${range} why="${it.reasons.join('; ').replace(/"/g, "'")}">`);
    parts.push(it.mode === 'chunks' ? numbered(it.text, (it.startLine ?? 0) + 1) : it.text);
    parts.push('</file>');
  }
  parts.push('</workspace_context>');
  return parts.join('\n');
}

function numbered(text: string, from: number): string {
  return text
    .split('\n')
    .map((l, i) => `${String(from + i).padStart(5)}| ${l}`)
    .join('\n');
}
