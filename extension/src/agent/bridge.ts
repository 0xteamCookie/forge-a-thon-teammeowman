// The editor side of the MCP tools. Reads are served from disk/open buffers and the index;
// writes only execute when a matching, user-decided review exists for that exact call.
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type WorkspaceIndex } from '../context/index';
import { assembleContext, renderPack, type ContextPack } from '../context/retrieve';
import { callKey, type EditorBridge, type ToolResult } from '../mcp/server';
import { renderHunk } from '../review/hunks';
import { type ReviewManager, type ReviewResult } from '../review/reviewManager';

export interface WriteDecision {
  result: ReviewResult;
  uri: vscode.Uri;
  relPath: string;
  original: string;
  isNew: boolean;
  runId?: string;
  explanation?: string;
}

const MAX_OUT = 12_000;

export class Bridge implements EditorBridge {
  /** Reviewed write decisions, keyed by callKey(tool, args). Consumed on execution. */
  readonly decisions = new Map<string, WriteDecision>();
  private readonly children = new Set<ChildProcess>();
  onRetrieve?: (pack: ContextPack, origin: 'tool') => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onWrite?: (relPath: string, summary: string) => void;

  constructor(
    private readonly root: vscode.Uri,
    private readonly getIndex: () => WorkspaceIndex | undefined,
    private readonly reviews: ReviewManager,
    private readonly cfg: () => vscode.WorkspaceConfiguration,
  ) {}

  resolve(rel: string): vscode.Uri {
    const clean = rel.replace(/^[/\\]+/, '').replace(/^\.\//, '');
    const abs = path.resolve(this.root.fsPath, clean);
    const rootPath = this.root.fsPath.endsWith(path.sep) ? this.root.fsPath : this.root.fsPath + path.sep;
    if (abs !== this.root.fsPath && !abs.startsWith(rootPath)) throw new Error(`path escapes the workspace: ${rel}`);
    return vscode.Uri.file(abs);
  }

  async currentText(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    try {
      return await fs.readFile(uri.fsPath, 'utf8');
    } catch {
      return undefined;
    }
  }

  async readFile(p: string, start?: number, end?: number): Promise<ToolResult> {
    const text = await this.currentText(this.resolve(p));
    if (text === undefined) return { text: `File not found: ${p}`, isError: true };
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const s = Math.max(1, start ?? 1);
    const e = Math.min(lines.length, end ?? Math.min(lines.length, s + 799));
    const body = lines
      .slice(s - 1, e)
      .map((l, i) => `${String(s + i).padStart(5)}| ${l}`)
      .join('\n');
    const more = e < lines.length ? `\n... (${lines.length - e} more lines; call read_file with start_line=${e + 1})` : '';
    return { text: `${p} (lines ${s}-${e} of ${lines.length})\n${body}${more}` };
  }

  async listFiles(dir?: string, pattern?: string): Promise<ToolResult> {
    const idx = this.getIndex();
    let files = idx ? [...idx.files.keys()] : [];
    if (dir) {
      const d = dir.replace(/^\.?\//, '').replace(/\/$/, '');
      files = files.filter(f => f === d || f.startsWith(d + '/'));
    }
    if (pattern) {
      const re = globToRegExp(pattern);
      files = files.filter(f => re.test(f) || re.test(path.posix.basename(f)));
    }
    const shown = files.slice(0, 400);
    return { text: `${files.length} files${files.length > shown.length ? ` (showing ${shown.length})` : ''}\n${shown.join('\n')}` };
  }

  async searchCode(query: string, isRegex: boolean, pathGlob?: string, maxResults = 60): Promise<ToolResult> {
    const idx = this.getIndex();
    if (!idx) return { text: 'Index is still building; try again in a moment.', isError: true };
    let re: RegExp;
    try {
      re = isRegex ? new RegExp(query, 'i') : new RegExp(escapeRe(query), 'i');
    } catch (e) {
      return { text: `Invalid regex: ${(e as Error).message}`, isError: true };
    }
    const glob = pathGlob ? globToRegExp(pathGlob) : undefined;
    const hits: string[] = [];
    let total = 0;
    for (const f of idx.files.values()) {
      if (glob && !glob.test(f.path) && !glob.test(path.posix.basename(f.path))) continue;
      const text = (await this.currentText(this.resolve(f.path))) ?? f.text;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          total++;
          if (hits.length < maxResults) hits.push(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
    return { text: total ? `${total} matches${total > hits.length ? ` (showing ${hits.length})` : ''}\n${hits.join('\n')}` : `No matches for ${JSON.stringify(query)}` };
  }

  async findSymbol(name: string): Promise<ToolResult> {
    const idx = this.getIndex();
    if (!idx) return { text: 'Index is still building.', isError: true };
    const base = name.includes('.') ? name.split('.').pop()! : name;
    const defs = idx.findSymbols(base);
    if (!defs.length) {
      const near = idx.searchSymbols(base, 10);
      return { text: `No definition named ${name}.${near.length ? ` Similar: ${near.map(s => `${s.name} (${s.file}:${s.line + 1})`).join(', ')}` : ''}` };
    }
    const re = new RegExp(`\\b${escapeRe(base)}\\b`);
    const refs = new Map<string, number>();
    for (const f of idx.files.values()) {
      const n = f.lines.filter(l => re.test(l)).length;
      if (n) refs.set(f.path, n);
    }
    const out = defs.map(s => `${s.kind} ${s.container ? s.container + '.' : ''}${s.name} at ${s.file}:${s.line + 1}\n    ${s.signature}`);
    const refList = [...refs].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, n]) => `${f} (${n})`);
    return { text: `${out.join('\n')}\nReferenced in: ${refList.join(', ')}` };
  }

  async retrieveContext(query: string, budget?: number): Promise<ToolResult> {
    const idx = this.getIndex();
    if (!idx) return { text: 'Index is still building.', isError: true };
    const pack = assembleContext(idx, query, { budget: budget ?? 6000 });
    this.onRetrieve?.(pack, 'tool');
    const header = pack.items.map(i => `- ${i.file} [${i.mode}${i.startLine != null ? ` ${i.startLine + 1}-${(i.endLine ?? 0) + 1}` : ''}, ${i.tokens} tok]: ${i.reasons.join('; ')}`).join('\n');
    return { text: `Selected ${pack.items.length} views, ${pack.used}/${pack.budget} tokens.\n${header}\n\n${renderPack(pack)}` };
  }

  async executeWrite(tool: 'edit_file' | 'write_file', args: Record<string, unknown>): Promise<ToolResult> {
    const key = callKey(tool, args);
    const d = this.decisions.get(key);
    if (!d) {
      return { text: 'Refused: this write has no user review on record. Writes only happen after the user reviews each hunk.', isError: true };
    }
    this.decisions.delete(key);
    const { accepted, rejected } = d.result;
    if (!accepted.length) return { text: `The user rejected every hunk for ${d.relPath}. Nothing was written.`, isError: true };
    try {
      await this.reviews.write(d, d.result.finalText, `${tool} ${d.relPath}`);
    } catch (e) {
      return { text: `Write failed: ${(e as Error).message}`, isError: true };
    }
    const summary = `${d.isNew ? 'Created' : 'Updated'} ${d.relPath}: applied ${accepted.length} of ${accepted.length + rejected.length} hunk(s).`;
    this.onWrite?.(d.relPath, summary);
    const rej = rejected.length
      ? `\nThe user REJECTED these hunks; they are not in the file. Do not re-propose them unchanged:\n${rejected.map(renderHunk).join('\n')}`
      : '';
    return { text: summary + rej };
  }

  async runCommand(command: string, cwd?: string): Promise<ToolResult> {
    const dir = cwd ? this.resolve(cwd).fsPath : this.root.fsPath;
    const timeoutMs = (this.cfg().get<number>('commandTimeoutSeconds') ?? 120) * 1000;
    const env = { ...process.env };
    // Prefer the workspace virtualenv so `pytest`/`python` mean the project's interpreter.
    for (const venv of ['.venv', 'venv']) {
      const bin = path.join(this.root.fsPath, venv, process.platform === 'win32' ? 'Scripts' : 'bin');
      try {
        await fs.access(bin);
        env.PATH = `${bin}${path.delimiter}${env.PATH ?? ''}`;
        env.VIRTUAL_ENV = path.join(this.root.fsPath, venv);
        break;
      } catch {
        // no venv here
      }
    }
    return new Promise(resolve => {
      const child = spawn(command, { cwd: dir, shell: true, env });
      this.children.add(child);
      let out = '';
      const onData = (b: Buffer): void => {
        out += b.toString('utf8');
        if (out.length > MAX_OUT * 2) out = out.slice(0, MAX_OUT) + '\n...[truncated]...\n' + out.slice(-MAX_OUT / 2);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        this.children.delete(child);
        const trimmed = out.length > MAX_OUT ? out.slice(0, MAX_OUT / 2) + '\n...[truncated]...\n' + out.slice(-MAX_OUT / 2) : out;
        resolve({ text: `$ ${command}\nexit code: ${code ?? signal}\n${trimmed}`, isError: code !== 0 });
      });
      child.on('error', e => {
        clearTimeout(timer);
        this.children.delete(child);
        resolve({ text: `Failed to start: ${e.message}`, isError: true });
      });
    });
  }

  killAll(): void {
    for (const c of this.children) c.kill('SIGKILL');
    this.children.clear();
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}
