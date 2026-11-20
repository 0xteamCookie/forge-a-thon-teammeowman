// Per-hunk review in VS Code's own diff editor.
//
//   left  = anvil-staged:   original + hunks accepted so far
//   right = anvil-proposed: original + accepted + still-pending hunks
//
// Accepting a hunk moves it into the left side; rejecting removes it from the right. Either way
// the two sides converge, and when no hunk is pending the review is decided. Nothing is written
// to disk during review: the decided text is written once, atomically, and recorded for undo.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { computeHunks, type Hunk, pendingHunkAnchors, proposedText, renderHunk, stagedText } from './hunks';

export const PROPOSED_SCHEME = 'anvil-proposed';
export const STAGED_SCHEME = 'anvil-staged';

export interface ReviewResult {
  decided: boolean; // false when cancelled
  accepted: Hunk[];
  rejected: Hunk[];
  finalText: string;
}

export interface Review {
  id: string;
  uri: vscode.Uri; // the real file
  relPath: string;
  original: string;
  isNew: boolean;
  hunks: Hunk[];
  streaming: boolean;
  title: string;
  explanation?: string;
  runId?: string;
  done: Promise<ReviewResult>;
  resolve: (r: ReviewResult) => void;
}

export interface AppliedChange {
  uri: vscode.Uri;
  relPath: string;
  before: string | undefined; // undefined: file did not exist
  after: string;
  label: string;
  runId?: string;
  at: number;
}

let seq = 0;

export class ReviewManager implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable {
  private readonly reviews = new Map<string, Review>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever reviews are opened, decided, or the undo stack changes. */
  readonly onDidChangeState = this.stateEmitter.event;
  readonly applied: AppliedChange[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly root: vscode.Uri,
    private readonly afterWrite: (relPath: string) => void,
  ) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this),
      vscode.workspace.registerTextDocumentContentProvider(STAGED_SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: PROPOSED_SCHEME }, this),
    );
  }

  dispose(): void {
    this.cancelAll('extension shutting down');
    this.disposables.forEach(d => d.dispose());
  }

  get pending(): Review[] {
    return [...this.reviews.values()];
  }

  // ---- virtual documents -------------------------------------------------------------------

  provideTextDocumentContent(uri: vscode.Uri): string {
    const r = this.reviews.get(new URLSearchParams(uri.query).get('review') ?? '');
    if (!r) return '';
    return uri.scheme === STAGED_SCHEME ? stagedText(r.original, r.hunks) : proposedText(r.original, r.hunks);
  }

  private uris(r: Review): { staged: vscode.Uri; proposed: vscode.Uri } {
    const p = '/' + r.relPath;
    const q = `review=${r.id}`;
    return {
      staged: vscode.Uri.from({ scheme: STAGED_SCHEME, path: p, query: q }),
      proposed: vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: p, query: q }),
    };
  }

  private refresh(r: Review): void {
    const { staged, proposed } = this.uris(r);
    this.changeEmitter.fire(staged);
    this.changeEmitter.fire(proposed);
    this.lensEmitter.fire();
    this.stateEmitter.fire();
  }

  // ---- code lenses -------------------------------------------------------------------------

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const r = this.reviews.get(new URLSearchParams(doc.uri.query).get('review') ?? '');
    if (!r) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    const pendingCount = r.hunks.filter(h => h.status === 'pending').length;
    if (r.streaming) return [new vscode.CodeLens(top, { title: '$(sync~spin) Anvil is generating... (Esc to stop)', command: 'anvil.cancel' })];
    const lenses: vscode.CodeLens[] = [
      new vscode.CodeLens(top, { title: `Anvil: ${pendingCount} hunk${pendingCount === 1 ? '' : 's'} to review`, command: '' }),
      new vscode.CodeLens(top, { title: 'Accept all', command: 'anvil.acceptAll', arguments: [r.id] }),
      new vscode.CodeLens(top, { title: 'Reject all', command: 'anvil.rejectAll', arguments: [r.id] }),
    ];
    for (const { hunk, line } of pendingHunkAnchors(r.hunks)) {
      const ln = Math.min(Math.max(0, line), Math.max(0, doc.lineCount - 1));
      const range = new vscode.Range(ln, 0, ln, 0);
      const label = `${hunk.newLines.length ? `+${hunk.newLines.length}` : ''}${hunk.oldLines.length ? ` -${hunk.oldLines.length}` : ''}`.trim();
      lenses.push(
        new vscode.CodeLens(range, { title: `$(check) Accept hunk ${hunk.id + 1} (${label})`, command: 'anvil.acceptHunk', arguments: [r.id, hunk.id] }),
        new vscode.CodeLens(range, { title: '$(close) Reject', command: 'anvil.rejectHunk', arguments: [r.id, hunk.id] }),
      );
    }
    return lenses;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  async open(params: { uri: vscode.Uri; original: string; proposed: string; isNew: boolean; title: string; explanation?: string; streaming?: boolean; runId?: string; preserveFocus?: boolean }): Promise<Review> {
    const id = `r${++seq}`;
    let resolve!: (r: ReviewResult) => void;
    const done = new Promise<ReviewResult>(res => (resolve = res));
    const relPath = vscode.workspace.asRelativePath(params.uri, false).split(path.sep).join('/');
    const review: Review = {
      id,
      uri: params.uri,
      relPath,
      original: params.original,
      isNew: params.isNew,
      hunks: computeHunks(params.original, params.proposed),
      streaming: params.streaming ?? false,
      title: params.title,
      explanation: params.explanation,
      runId: params.runId,
      done,
      resolve,
    };
    this.reviews.set(id, review);
    this.updateContext();
    const { staged, proposed } = this.uris(review);
    await vscode.commands.executeCommand('vscode.diff', staged, proposed, `${path.basename(relPath)} · ${params.title}`, {
      preview: false,
      preserveFocus: params.preserveFocus ?? false,
    });
    this.refresh(review);
    if (!review.streaming && review.hunks.length === 0) this.finish(review, true);
    return review;
  }

  /** Streaming update: recompute hunks against the partial proposal. */
  update(r: Review, proposed: string, streaming: boolean): void {
    if (!this.reviews.has(r.id)) return;
    r.hunks = computeHunks(r.original, proposed);
    r.streaming = streaming;
    this.refresh(r);
    if (!streaming && r.hunks.length === 0) this.finish(r, true);
  }

  decide(reviewId: string, hunkId: number | 'all', status: 'accepted' | 'rejected'): void {
    const r = this.reviews.get(reviewId);
    if (!r || r.streaming) return;
    for (const h of r.hunks) if (h.status === 'pending' && (hunkId === 'all' || h.id === hunkId)) h.status = status;
    this.refresh(r);
    if (r.hunks.every(h => h.status !== 'pending')) this.finish(r, true);
  }

  /** Accept/reject the hunk nearest the cursor in the active review editor (keyboard path). */
  decideAtCursor(status: 'accepted' | 'rejected'): void {
    const ed = vscode.window.activeTextEditor;
    let r: Review | undefined;
    let line = 0;
    if (ed && ed.document.uri.scheme === PROPOSED_SCHEME) {
      r = this.reviews.get(new URLSearchParams(ed.document.uri.query).get('review') ?? '');
      line = ed.selection.active.line;
    }
    r ??= this.pending.find(x => !x.streaming && x.hunks.some(h => h.status === 'pending'));
    if (!r) return;
    const anchors = pendingHunkAnchors(r.hunks);
    if (!anchors.length) return;
    const nearest = anchors.reduce((best, a) => (Math.abs(a.line - line) < Math.abs(best.line - line) ? a : best));
    this.decide(r.id, nearest.hunk.id, status);
  }

  cancel(r: Review, reason: string): void {
    if (!this.reviews.has(r.id)) return;
    for (const h of r.hunks) if (h.status === 'pending') h.status = 'rejected';
    void reason;
    this.finish(r, false);
  }

  cancelAll(reason: string, filter?: (r: Review) => boolean): number {
    let n = 0;
    for (const r of [...this.reviews.values()]) {
      if (filter && !filter(r)) continue;
      this.cancel(r, reason);
      n++;
    }
    return n;
  }

  private finish(r: Review, decided: boolean): void {
    if (!this.reviews.delete(r.id)) return;
    this.updateContext();
    void this.closeTabs(r);
    const accepted = r.hunks.filter(h => h.status === 'accepted');
    const rejected = r.hunks.filter(h => h.status !== 'accepted');
    r.resolve({ decided, accepted: decided ? accepted : [], rejected, finalText: decided ? stagedText(r.original, r.hunks) : r.original });
    this.lensEmitter.fire();
    this.stateEmitter.fire();
  }

  private async closeTabs(r: Review): Promise<void> {
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => {
      const input = t.input;
      return input instanceof vscode.TabInputTextDiff && input.modified.scheme === PROPOSED_SCHEME && new URLSearchParams(input.modified.query).get('review') === r.id;
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }

  private updateContext(): void {
    void vscode.commands.executeCommand('setContext', 'anvil.reviewing', this.reviews.size > 0);
  }

  // ---- disk writes and undo ----------------------------------------------------------------

  /**
   * Write decided text to disk in one WorkspaceEdit and save. Refuses if the file changed on
   * disk since the review started, so a stale review can never clobber newer work.
   */
  async write(r: { uri: vscode.Uri; relPath: string; original: string; isNew: boolean; runId?: string }, finalText: string, label: string): Promise<AppliedChange> {
    const exists = await fileExists(r.uri);
    let before: string | undefined;
    if (exists) {
      const doc = await vscode.workspace.openTextDocument(r.uri);
      before = doc.getText();
      if (!r.isNew && normalize(before) !== normalize(r.original)) {
        throw new Error(`${r.relPath} changed while it was under review; not writing. Re-read the file and propose again.`);
      }
    }
    await writeText(r.uri, finalText, exists);
    const change: AppliedChange = { uri: r.uri, relPath: r.relPath, before, after: finalText, label, runId: r.runId, at: Date.now() };
    this.applied.push(change);
    this.afterWrite(r.relPath);
    this.stateEmitter.fire();
    return change;
  }

  async undo(change: AppliedChange): Promise<void> {
    if (change.before === undefined) {
      const tabs = vscode.window.tabGroups.all
        .flatMap(g => g.tabs)
        .filter(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === change.uri.toString());
      if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
      await vscode.workspace.fs.delete(change.uri, { useTrash: false });
    } else {
      await writeText(change.uri, change.before, true);
    }
    const i = this.applied.indexOf(change);
    if (i >= 0) this.applied.splice(i, 1);
    this.afterWrite(change.relPath);
    this.stateEmitter.fire();
  }

  async undoLast(): Promise<AppliedChange | undefined> {
    const last = this.applied[this.applied.length - 1];
    if (last) await this.undo(last);
    return last;
  }

  /** Roll back everything a run wrote, newest first. */
  async rollbackRun(runId: string): Promise<AppliedChange[]> {
    const mine = this.applied.filter(c => c.runId === runId).reverse();
    for (const c of mine) await this.undo(c);
    return mine;
  }

  describe(h: Hunk): string {
    return renderHunk(h);
  }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

async function writeText(uri: vscode.Uri, text: string, exists: boolean): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  if (!exists) {
    edit.createFile(uri, { ignoreIfExists: true, contents: Buffer.from(text, 'utf8') });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`could not create ${uri.fsPath}`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(uri, full, text);
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`could not edit ${uri.fsPath}`);
  await doc.save();
}
