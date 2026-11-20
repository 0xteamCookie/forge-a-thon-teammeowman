// Inline edit: select code, press the keybinding, type an instruction. The replacement streams
// from a TrueForge turn straight into a per-hunk diff. Nothing is written until hunks are accepted.
import * as vscode from 'vscode';
import { type WorkspaceIndex } from '../context/index';
import { assembleContext, parseMentions, renderPack } from '../context/retrieve';
import { type ReviewManager } from '../review/reviewManager';
import { ResilientConversation, type TrueForgeService } from '../trueforge/service';
import { extractCode, fitIndent } from './parse';

const BEFORE_LINES = 60;
const AFTER_LINES = 40;

export class InlineEditor {
  private abort?: AbortController;
  private readonly status: vscode.StatusBarItem;

  constructor(
    private readonly svc: TrueForgeService,
    private readonly reviews: ReviewManager,
    private readonly getIndex: () => WorkspaceIndex | undefined,
    private readonly cfg: () => vscode.WorkspaceConfiguration,
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  }

  get busy(): boolean {
    return !!this.abort;
  }

  cancel(): boolean {
    if (!this.abort) return false;
    this.abort.abort();
    return true;
  }

  /** `presetInstruction` skips the input box (used by keybinding args and integration tests). */
  async run(presetInstruction?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Anvil: select the code to edit first.');
      return;
    }
    if (this.abort) {
      void vscode.window.showInformationMessage('Anvil: an inline edit is already running (Esc to stop it).');
      return;
    }
    const instruction = presetInstruction ?? await vscode.window.showInputBox({
      title: 'Anvil: edit selection',
      prompt: 'Describe the change. Mention extra context with @file:path or @sym:Name.',
      placeHolder: 'e.g. handle None input and update the docstring',
      ignoreFocusOut: true,
    });
    if (!instruction?.trim()) return;

    const doc = editor.document;
    // Whole lines: partial-line selections make the model's job and the diff needlessly fragile.
    const sel = new vscode.Range(editor.selection.start.line, 0, editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line ? editor.selection.end.line - 1 : editor.selection.end.line, Number.MAX_SAFE_INTEGER);
    const range = doc.validateRange(sel);
    const original = doc.getText();
    const startOff = doc.offsetAt(range.start);
    const endOff = doc.offsetAt(range.end);
    const selected = original.slice(startOff, endOff);
    const head = original.slice(0, startOff);
    const tail = original.slice(endOff);
    const rel = vscode.workspace.asRelativePath(doc.uri, false);

    const prompt = this.buildPrompt(doc, range, selected, instruction, rel);

    this.abort = new AbortController();
    const signal = this.abort.signal;
    void vscode.commands.executeCommand('setContext', 'anvil.generating', true);
    this.setStatus('$(sync~spin) Anvil: connecting to TrueForge...');

    const review = await this.reviews.open({ uri: doc.uri, original, proposed: original, isNew: false, title: 'inline edit (Anvil)', streaming: true });
    const conv = new ResilientConversation(this.svc, 'inline', () => this.cfg().get<string[]>('models') ?? [], () => this.cfg().get<number>('retriesPerModel') ?? 1);
    let raw = '';
    let lastPush = 0;
    const selLines = selected.split('\n');
    // Mid-stream view: lines generated so far, then the part of the selection not yet reached,
    // so the diff grows top-down the way the model writes it.
    const pushPartial = (): void => {
      const code = extractCode(raw, false);
      if (code === undefined) return;
      const fitted = fitIndent(code, selected, false);
      const done = fitted.split('\n');
      const rest = selLines.slice(done.length);
      this.reviews.update(review, head + [...done, ...rest].join('\n') + tail, true);
    };
    try {
      const out = await conv.send(
        [{ type: 'user.message', content: prompt }],
        {
          onSession: (_id, model) => this.setStatus(`$(sync~spin) Anvil: generating with ${model} (Esc to stop)`),
          onStatus: (m, level) => {
            this.setStatus(`$(warning) ${m}`);
            if (level !== 'info') void vscode.window.showWarningMessage(`Anvil: ${m}`);
          },
          onText: d => {
            raw += d;
            const now = Date.now();
            if (now - lastPush > 50) {
              lastPush = now;
              pushPartial();
            }
          },
        },
        signal,
      );
      if (signal.aborted || out.status === 'cancelled') {
        this.reviews.cancel(review, 'stopped');
        void vscode.window.showInformationMessage('Anvil: inline edit stopped. No changes were made.');
        return;
      }
      if (out.status === 'error') {
        this.reviews.cancel(review, 'error');
        void vscode.window.showErrorMessage(`Anvil: inline edit failed. ${out.error ?? ''} No files were changed.`);
        return;
      }
      raw = out.text || raw;
      const code = extractCode(raw, true);
      if (code === undefined || !code.trim()) {
        this.reviews.cancel(review, 'empty');
        void vscode.window.showWarningMessage('Anvil: the model returned no code. No changes were made.');
        return;
      }
      this.reviews.update(review, head + fitIndent(code, selected, true) + tail, false);
      this.setStatus(`$(diff) Anvil: review ${review.hunks.length} hunk(s) (Accept/Reject above each)`);
      void vscode.commands.executeCommand('setContext', 'anvil.generating', false);
      // Generation is over: free the editor for the next inline edit while this review is open.
      this.abort = undefined;
      const result = await review.done;
      if (result.decided && result.accepted.length) {
        const change = await this.reviews.write({ uri: doc.uri, relPath: rel, original, isNew: false }, result.finalText, `inline edit ${rel}`);
        // Not awaited: an undismissed toast must never hold state.
        void vscode.window
          .showInformationMessage(`Anvil: applied ${result.accepted.length} of ${result.accepted.length + result.rejected.length} hunk(s) to ${rel}.`, 'Undo')
          .then(pick => (pick === 'Undo' && this.reviews.applied.includes(change) ? this.reviews.undo(change) : undefined));
      } else if (result.decided) {
        void vscode.window.showInformationMessage(
          result.rejected.length
            ? 'Anvil: all hunks rejected. File unchanged.'
            : 'Anvil: the model returned the selection unchanged, so there was nothing to review. If the file already contains this change, revert it (or run demo-reset.sh) and try again.',
        );
      }
    } catch (e) {
      this.reviews.cancel(review, 'error');
      void vscode.window.showErrorMessage(`Anvil: ${e instanceof Error ? e.message : String(e)} No files were changed.`);
    } finally {
      this.abort = undefined;
      this.status.hide();
      void vscode.commands.executeCommand('setContext', 'anvil.generating', false);
    }
  }

  private buildPrompt(doc: vscode.TextDocument, range: vscode.Range, selected: string, instruction: string, rel: string): string {
    const before = doc.getText(new vscode.Range(Math.max(0, range.start.line - BEFORE_LINES), 0, range.start.line, 0));
    const after = doc.getText(new vscode.Range(range.end.line + 1, 0, Math.min(doc.lineCount, range.end.line + 1 + AFTER_LINES), 0));
    let extra = '';
    const idx = this.getIndex();
    if (idx) {
      const { mentions } = parseMentions(instruction);
      // Small budget: the selection is the subject; retrieval only adds definitions it relies on.
      const pack = assembleContext(idx, `${instruction}\n${selected}`, { budget: 2500, mentions, maxFiles: 3, exclude: [rel] });
      extra = renderPack(pack);
    }
    return [
      `File: ${rel} (${doc.languageId}). Lines ${range.start.line + 1}-${range.end.line + 1} are selected.`,
      `Instruction: ${instruction}`,
      '',
      '<code_before_selection>',
      before,
      '</code_before_selection>',
      '<selection>',
      selected,
      '</selection>',
      '<code_after_selection>',
      after,
      '</code_after_selection>',
      extra,
      '',
      'Reply with ONLY the full replacement for <selection> in a single fenced code block. Keep the original indentation and leave unrelated lines unchanged.',
    ].join('\n');
  }

  private setStatus(text: string): void {
    this.status.text = text;
    this.status.command = 'anvil.cancel';
    this.status.show();
  }
}
