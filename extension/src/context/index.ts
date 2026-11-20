// Workspace index: files -> chunks -> BM25, plus a symbol table and an import graph.
// Pure node (fs + git); no vscode imports, so it runs in tests and benchmarks unchanged.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ChunkKind = 'preamble' | 'function' | 'class' | 'method' | 'section' | 'window';

export interface Chunk {
  id: number;
  file: string; // workspace-relative, forward slashes
  startLine: number; // 0-based inclusive
  endLine: number; // 0-based inclusive
  kind: ChunkKind;
  symbol?: string;
  text: string;
  tokens: string[];
}

export interface SymbolEntry {
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable';
  file: string;
  line: number; // 0-based
  container?: string;
  signature: string;
}

export interface FileEntry {
  path: string;
  text: string;
  lines: string[];
  chunkIds: number[];
  pathTokens: Set<string>;
  imports: string[]; // workspace-relative files this file imports
}

const INDEXED_EXT = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.rs', '.java', '.rb',
  '.md', '.rst', '.txt', '.toml', '.cfg', '.ini', '.json', '.yaml', '.yml', '.html', '.css',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', 'out']);
const MAX_FILE_BYTES = 400_000;
const MAX_CHUNK_LINES = 120;
const WINDOW_LINES = 60;

const STOPWORDS = new Set(
  ('a an and are as at be by for from has have if in into is it its of on or that the this to was were will with ' +
    'should must can could would add new make all any each every other others also use using used than then them they ' +
    'their there these those which while when where what who how not only same as but do does done so such very just')
    .split(' '),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    const lower = raw.toLowerCase();
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[_\s]+/)
      .map(p => p.toLowerCase())
      .filter(Boolean);
    if (parts.length > 1 && lower.length > 2 && !STOPWORDS.has(lower)) out.push(lower);
    for (const p of parts) {
      if (p.length > 1 && !STOPWORDS.has(p)) out.push(stem(p));
    }
  }
  return out;
}

/** Tiny suffix stemmer: enough to match "commands"/"command", "masking"/"mask". */
export function stem(word: string): string {
  if (word.length <= 4) return word;
  for (const suffix of ['ings', 'ing', 'ies', 'es', 's', 'ed']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      if (suffix === 'ies') return word.slice(0, -3) + 'y';
      if (suffix === 'es' && !/(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -1);
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

export class WorkspaceIndex {
  readonly files = new Map<string, FileEntry>();
  readonly chunks: Chunk[] = [];
  readonly symbols: SymbolEntry[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  builtAt = 0;
  buildMs = 0;

  constructor(readonly root: string) {}

  static async build(root: string): Promise<WorkspaceIndex> {
    const idx = new WorkspaceIndex(root);
    await idx.rebuild();
    return idx;
  }

  async rebuild(): Promise<void> {
    const started = Date.now();
    this.files.clear();
    this.chunks.length = 0;
    this.symbols.length = 0;
    this.df.clear();
    const paths = await listFiles(this.root);
    for (const rel of paths) {
      await this.addFile(rel);
    }
    this.finish();
    this.builtAt = Date.now();
    this.buildMs = this.builtAt - started;
  }

  /** Re-index one file after a write (cheap enough to just recompute global stats). */
  async refreshFile(rel: string): Promise<void> {
    const norm = rel.split(path.sep).join('/');
    const existing = this.files.get(norm);
    if (existing) {
      for (const id of existing.chunkIds) this.chunks[id] = { ...this.chunks[id], tokens: [], text: '' };
      this.files.delete(norm);
      for (let i = this.symbols.length - 1; i >= 0; i--) if (this.symbols[i].file === norm) this.symbols.splice(i, 1);
    }
    await this.addFile(norm);
    this.finish();
  }

  private async addFile(rel: string): Promise<void> {
    const ext = path.extname(rel).toLowerCase();
    if (!INDEXED_EXT.has(ext)) return;
    const abs = path.join(this.root, rel);
    let text: string;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_FILE_BYTES) return;
      text = await fs.readFile(abs, 'utf8');
    } catch {
      return;
    }
    if (text.includes('\u0000')) return;
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const entry: FileEntry = {
      path: rel,
      text,
      lines,
      chunkIds: [],
      pathTokens: new Set(tokenize(rel.replace(/[/.]/g, ' '))),
      imports: [],
    };
    this.files.set(rel, entry);
    const { chunks, symbols } = chunkFile(rel, lines);
    for (const c of chunks) {
      const id = this.chunks.length;
      const chunk: Chunk = { ...c, id, tokens: tokenize(c.text) };
      this.chunks.push(chunk);
      entry.chunkIds.push(id);
    }
    this.symbols.push(...symbols);
    entry.imports = ext === '.py' ? pythonImports(lines) : [];
  }

  private finish(): void {
    // Resolve python module imports to files now that every file is known.
    for (const f of this.files.values()) {
      f.imports = f.imports.map(m => this.resolveModule(m, f.path)).filter((x): x is string => !!x);
    }
    this.df.clear();
    let total = 0;
    let n = 0;
    for (const c of this.chunks) {
      if (c.tokens.length === 0) continue;
      total += c.tokens.length;
      n++;
      for (const t of new Set(c.tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = n ? total / n : 1;
  }

  private resolveModule(mod: string, fromFile: string): string | undefined {
    if (mod.startsWith('.')) {
      const dots = mod.match(/^\.+/)![0].length;
      let base = path.posix.dirname(fromFile);
      for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
      const rest = mod.slice(dots).replace(/\./g, '/');
      const cand = rest ? `${base}/${rest}` : base;
      return this.pickModuleFile(cand);
    }
    const rel = mod.replace(/\./g, '/');
    for (const prefix of ['', 'src/', 'lib/']) {
      const hit = this.pickModuleFile(prefix + rel);
      if (hit) return hit;
    }
    return undefined;
  }

  private pickModuleFile(cand: string): string | undefined {
    if (this.files.has(`${cand}.py`)) return `${cand}.py`;
    if (this.files.has(`${cand}/__init__.py`)) return `${cand}/__init__.py`;
    return undefined;
  }

  get chunkCount(): number {
    return this.chunks.filter(c => c.tokens.length > 0).length;
  }

  /** BM25 score of every live chunk against the query terms. */
  bm25(queryTerms: string[]): Map<number, { score: number; matched: string[] }> {
    const k1 = 1.2;
    const b = 0.75;
    const N = Math.max(1, this.chunkCount);
    const unique = [...new Set(queryTerms)];
    const out = new Map<number, { score: number; matched: string[] }>();
    for (const c of this.chunks) {
      if (c.tokens.length === 0) continue;
      const tf = new Map<string, number>();
      for (const t of c.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      const matched: string[] = [];
      for (const q of unique) {
        const f = tf.get(q);
        if (!f) continue;
        const df = this.df.get(q) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * c.tokens.length) / this.avgLen));
        matched.push(q);
      }
      if (score > 0) out.set(c.id, { score, matched });
    }
    return out;
  }

  findSymbols(name: string): SymbolEntry[] {
    const lower = name.toLowerCase();
    const exact = this.symbols.filter(s => s.name === name);
    if (exact.length) return exact;
    return this.symbols.filter(s => s.name.toLowerCase() === lower);
  }

  searchSymbols(prefix: string, limit = 30): SymbolEntry[] {
    const lower = prefix.toLowerCase();
    const starts = this.symbols.filter(s => s.name.toLowerCase().startsWith(lower));
    const contains = this.symbols.filter(s => !s.name.toLowerCase().startsWith(lower) && s.name.toLowerCase().includes(lower));
    return [...starts, ...contains].slice(0, limit);
  }

  /** Signatures only: the cheap way to show a file the model did not get in full. */
  outline(file: string): string {
    const syms = this.symbols.filter(s => s.file === file).sort((x, y) => x.line - y.line);
    return syms.map(s => `${String(s.line + 1).padStart(5)}: ${s.signature}`).join('\n');
  }

  /** Files that import `file` (reverse edges of the import graph). */
  importers(file: string): string[] {
    const out: string[] = [];
    for (const f of this.files.values()) if (f.imports.includes(file)) out.push(f.path);
    return out;
  }
}

export async function listFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = stdout.split('\n').filter(Boolean);
    if (files.length) return files;
  } catch {
    // not a git repo; fall through to a manual walk
  }
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(abs);
      } else if (e.isFile()) {
        out.push(path.relative(root, abs).split(path.sep).join('/'));
      }
      if (out.length > 20_000) return;
    }
  }
  await walk(root);
  return out;
}

type RawChunk = Omit<Chunk, 'id' | 'tokens'>;

export function chunkFile(file: string, lines: string[]): { chunks: RawChunk[]; symbols: SymbolEntry[] } {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.py') return chunkPython(file, lines);
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return chunkJs(file, lines);
  if (ext === '.rst' || ext === '.md') return { chunks: chunkDocs(file, lines, ext), symbols: [] };
  return { chunks: windows(file, lines, 0, lines.length - 1, 'window'), symbols: [] };
}

function windows(file: string, lines: string[], start: number, end: number, kind: ChunkKind, symbol?: string): RawChunk[] {
  const out: RawChunk[] = [];
  for (let s = start; s <= end; s += WINDOW_LINES) {
    const e = Math.min(end, s + WINDOW_LINES - 1);
    out.push({ file, startLine: s, endLine: e, kind, symbol, text: lines.slice(s, e + 1).join('\n') });
  }
  return out;
}

function pushBlock(out: RawChunk[], file: string, lines: string[], start: number, end: number, kind: ChunkKind, symbol?: string): void {
  if (end < start) return;
  const text = lines.slice(start, end + 1).join('\n');
  if (!text.trim()) return;
  if (end - start + 1 > MAX_CHUNK_LINES) {
    out.push(...windows(file, lines, start, end, kind, symbol));
  } else {
    out.push({ file, startLine: start, endLine: end, kind, symbol, text });
  }
}

const PY_DEF = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)\s*[(:]/;
const PY_ASSIGN = /^([A-Z_][A-Z0-9_]*|[a-z_]\w*)\s*(?::[^=]+)?=\s*/;

function chunkPython(file: string, lines: string[]): { chunks: RawChunk[]; symbols: SymbolEntry[] } {
  const symbols: SymbolEntry[] = [];
  // Block starts at indent 0 (functions/classes) and indent 4 inside classes (methods).
  interface Start { line: number; indent: number; kind: 'function' | 'class' | 'method'; name: string; container?: string }
  const starts: Start[] = [];
  let currentClass: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = PY_DEF.exec(line);
    if (m) {
      const indent = m[1].length;
      if (indent === 0) {
        const kind = m[2] === 'class' ? 'class' : 'function';
        currentClass = kind === 'class' ? m[3] : undefined;
        starts.push({ line: i, indent, kind, name: m[3] });
        symbols.push({ name: m[3], kind, file, line: i, signature: signatureAt(lines, i) });
      } else if (indent === 4 && currentClass && m[2] === 'def') {
        starts.push({ line: i, indent, kind: 'method', name: m[3], container: currentClass });
        symbols.push({ name: m[3], kind: 'method', file, line: i, container: currentClass, signature: `${currentClass}.${signatureAt(lines, i).trim()}` });
      }
      continue;
    }
    if (line.length && !/^\s/.test(line) && !line.startsWith('#') && !line.startsWith('@')) {
      if (!/^(def|class|async)\b/.test(line)) currentClass = undefined;
      const a = PY_ASSIGN.exec(line);
      if (a && !/^(if|for|while|with|try|return|import|from|elif|else|except|finally)\b/.test(line)) {
        symbols.push({ name: a[1], kind: 'variable', file, line: i, signature: line.slice(0, 100) });
      }
    }
  }
  // Pull decorators and leading comments into the block they annotate.
  const blockStart = (s: Start): number => {
    let j = s.line - 1;
    while (j >= 0 && (lines[j].trim().startsWith('@') || lines[j].trim().startsWith('#')) && leadingSpaces(lines[j]) === s.indent) j--;
    return j + 1;
  };
  const chunks: RawChunk[] = [];
  const firstStart = starts.length ? blockStart(starts[0]) : lines.length;
  pushBlock(chunks, file, lines, 0, firstStart - 1, 'preamble');
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const begin = blockStart(s);
    const next = starts[k + 1];
    let end = next ? blockStart(next) - 1 : lines.length - 1;
    // A class chunk covers only its header/attributes when methods are chunked separately.
    if (s.kind === 'class' && next && next.kind === 'method' && next.container === s.name) end = blockStart(next) - 1;
    // Trailing module-level code after a top-level def belongs in a separate window, not the def.
    pushBlock(chunks, file, lines, begin, end, s.kind, s.container ? `${s.container}.${s.name}` : s.name);
  }
  return { chunks, symbols };
}

function signatureAt(lines: string[], i: number): string {
  let sig = lines[i].trim();
  let j = i;
  while (!/:\s*(#.*)?$/.test(sig) && j + 1 < lines.length && j - i < 8) {
    j++;
    sig += ' ' + lines[j].trim();
  }
  return sig.length > 160 ? sig.slice(0, 157) + '...' : sig;
}

function leadingSpaces(s: string): number {
  return s.length - s.trimStart().length;
}

const JS_DEF =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:(function)\s*\*?\s*([A-Za-z_$][\w$]*)|(class)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/;

function chunkJs(file: string, lines: string[]): { chunks: RawChunk[]; symbols: SymbolEntry[] } {
  const symbols: SymbolEntry[] = [];
  const starts: Array<{ line: number; name: string; kind: 'function' | 'class' | 'variable' }> = [];
  lines.forEach((line, i) => {
    const m = JS_DEF.exec(line);
    if (!m) return;
    const name = m[2] ?? m[4] ?? m[5];
    const kind = m[1] ? 'function' : m[3] ? 'class' : 'variable';
    starts.push({ line: i, name, kind });
    symbols.push({ name, kind, file, line: i, signature: line.trim().slice(0, 160) });
  });
  const chunks: RawChunk[] = [];
  pushBlock(chunks, file, lines, 0, (starts[0]?.line ?? lines.length) - 1, 'preamble');
  starts.forEach((s, k) => {
    const end = (starts[k + 1]?.line ?? lines.length) - 1;
    pushBlock(chunks, file, lines, s.line, end, s.kind === 'class' ? 'class' : 'function', s.name);
  });
  return { chunks, symbols };
}

function chunkDocs(file: string, lines: string[], ext: string): RawChunk[] {
  const heads: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (ext === '.md' && /^#{1,4}\s/.test(lines[i])) heads.push(i);
    if (ext === '.rst' && i > 0 && /^([=\-~^"'`#*+])\1{2,}\s*$/.test(lines[i]) && lines[i - 1].trim() && !/^([=\-~^])\1+$/.test(lines[i - 1].trim())) {
      heads.push(i - 1);
    }
  }
  const out: RawChunk[] = [];
  const bounds = [0, ...heads.filter(h => h > 0), lines.length];
  for (let k = 0; k < bounds.length - 1; k++) {
    const start = bounds[k];
    const end = bounds[k + 1] - 1;
    pushBlock(out, file, lines, start, end, 'section', lines[start]?.replace(/^#+\s*/, '').trim().slice(0, 80));
  }
  return out;
}

function pythonImports(lines: string[]): string[] {
  const mods: string[] = [];
  for (const line of lines) {
    let m = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(line);
    if (m) {
      mods.push(m[1]);
      // `from . import cli` imports a submodule
      if (/^\.+$/.test(m[1])) for (const name of m[2].split(',')) mods.push(m[1] + name.trim().split(/\s+/)[0]);
      continue;
    }
    m = /^\s*import\s+([\w.]+)/.exec(line);
    if (m) mods.push(m[1]);
  }
  return mods;
}
