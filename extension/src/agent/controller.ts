// Agent mode: one request -> a TrueForge turn loop. When TrueForge pauses on a gated tool call
// (edit_file / write_file / run_command) the controller turns the pause into a per-hunk review
// (or a command approval card), then resumes the turn with the user's decisions.
import * as vscode from 'vscode';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { type WorkspaceIndex } from '../context/index';
import { assembleContext, type ContextPack, parseMentions, renderPack } from '../context/retrieve';
import { callKey } from '../mcp/server';
import { applyEdits, type Edit } from '../review/edits';
import { type ReviewManager } from '../review/reviewManager';
import { contentText, type PendingCall, ResilientConversation, type TrueForgeService } from '../trueforge/service';
import { type Bridge } from './bridge';

export type PanelMessage = Record<string, unknown> & { type: string };

export interface PanelSink {
  post(msg: PanelMessage): void;
  askApproval(id: string, title: string, detail: string): Promise<boolean>;
}

type Ev = TrueForgeApi.TurnStreamingEvent;

let runSeq = 0;

export class AgentController {
  private conv: ResilientConversation;
  private abort?: AbortController;
  private runId?: string;
  running = false;

  constructor(
    private readonly svc: TrueForgeService,
    private readonly bridge: Bridge,
    private readonly reviews: ReviewManager,
    private readonly getIndex: () => WorkspaceIndex | undefined,
    private readonly cfg: () => vscode.WorkspaceConfiguration,
    private readonly sink: PanelSink,
  ) {
    this.conv = this.newConversation();
    bridge.onRetrieve = pack => this.sink.post({ type: 'context', origin: 'agent tool: retrieve_context', pack: summarizePack(pack) });
    bridge.onWrite = (rel, summary) => this.sink.post({ type: 'applied', file: rel, summary });
  }

  private newConversation(): ResilientConversation {
    return new ResilientConversation(
      this.svc,
      'coder',
      () => this.cfg().get<string[]>('models') ?? [],
      () => this.cfg().get<number>('retriesPerModel') ?? 1,
    );
  }

  newChat(): void {
    if (this.running) return;
    this.conv = this.newConversation();
    this.sink.post({ type: 'cleared' });
  }

  get sessionId(): string | undefined {
    return this.conv.sessionId;
  }

  async run(userText: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.runId = `run${++runSeq}`;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    void vscode.commands.executeCommand('setContext', 'anvil.generating', true);
    this.sink.post({ type: 'user', text: userText });
    this.sink.post({ type: 'running', running: true });
    const started = Date.now();
    try {
      const idx = this.getIndex();
      const { mentions } = parseMentions(userText);
      let contextBlock = '';
      if (idx) {
        const pack = assembleContext(idx, userText.replace(/@(file|sym|symbol):\S+/g, ' '), {
          budget: this.cfg().get<number>('contextBudgetTokens') ?? 10000,
          mentions,
        });
        this.sink.post({ type: 'context', origin: 'automatic retrieval before the first model call', pack: summarizePack(pack) });
        contextBlock = renderPack(pack);
        if (pack.unresolvedMentions.length) this.sink.post({ type: 'status', level: 'warn', message: `Could not resolve ${pack.unresolvedMentions.join(', ')}` });
      } else {
        this.sink.post({ type: 'status', level: 'warn', message: 'Index still building; sending without pre-retrieved context (the agent can still search).' });
      }
      const content = contextBlock ? `${userText}\n\n${contextBlock}` : userText;
      let out = await this.conv.send([{ type: 'user.message', content }], this.callbacks(), signal);

      while (out.status === 'paused' && !signal.aborted) {
        const decisions: unknown[] = [];
        for (const call of out.pending) {
          if (signal.aborted) break;
          decisions.push(await this.decide(call, signal));
        }
        if (signal.aborted) break;
        this.sink.post({ type: 'phase', text: 'Resuming agent with your decisions...' });
        out = await this.conv.send(decisions, this.callbacks(), signal);
      }

      if (signal.aborted || out.status === 'cancelled') {
        await this.afterCancel();
      } else if (out.status === 'error') {
        this.sink.post({ type: 'status', level: 'error', message: out.error ?? 'Run failed.' });
        this.sink.post({ type: 'done', status: 'error', ms: Date.now() - started });
      } else {
        this.sink.post({ type: 'done', status: 'done', ms: Date.now() - started, model: out.model });
      }
    } catch (e) {
      this.sink.post({ type: 'status', level: 'error', message: e instanceof Error ? e.message : String(e) });
      this.sink.post({ type: 'done', status: 'error', ms: Date.now() - started });
    } finally {
      this.running = false;
      this.abort = undefined;
      void vscode.commands.executeCommand('setContext', 'anvil.generating', false);
      this.sink.post({ type: 'running', running: false });
    }
  }

  /** Stop: cancel the TrueForge turn, kill commands, discard open reviews, roll back the run. */
  stop(): void {
    if (!this.running || !this.abort) return;
    this.abort.abort();
    this.bridge.killAll();
    const runId = this.runId;
    this.reviews.cancelAll('run stopped', r => r.runId === runId);
  }

  private async afterCancel(): Promise<void> {
    const runId = this.runId;
    this.bridge.killAll();
    this.reviews.cancelAll('run stopped', r => r.runId === runId);
    for (const [k, d] of this.bridge.decisions) if (d.runId === runId) this.bridge.decisions.delete(k);
    const rolled = runId ? await this.reviews.rollbackRun(runId) : [];
    this.sink.post({
      type: 'status',
      level: 'info',
      message: rolled.length
        ? `Stopped. Rolled back ${rolled.length} file write(s) from this run: ${rolled.map(r => r.relPath).join(', ')}. Workspace is as it was before the run.`
        : 'Stopped. No files were changed.',
    });
    this.sink.post({ type: 'done', status: 'cancelled' });
  }

  private callbacks() {
    return {
      onText: (d: string) => this.sink.post({ type: 'text', delta: d }),
      onStatus: (message: string, level: 'info' | 'warn' | 'error') => this.sink.post({ type: 'status', level, message }),
      onSession: (sessionId: string, model: string, agent: string) =>
        this.sink.post({ type: 'session', sessionId, model, agent, url: this.svc.sessionUrl(sessionId) }),
      onEvent: (e: Ev, index: Map<string, Ev>) => this.onEvent(e, index),
    };
  }

  private onEvent(e: Ev, index: Map<string, Ev>): void {
    switch (e.type) {
      case 'tool.response': {
        const call = findCall(index, e.toolCallId);
        if (!call) return;
        const info = call.toolInfo as { type: string; name: string };
        this.sink.post({
          type: 'tool',
          id: e.toolCallId,
          thread: e.threadId,
          name: info.name,
          system: info.type !== 'mcp',
          args: shortArgs(call.function.arguments),
          result: e.content.slice(0, 600),
        });
        return;
      }
      case 'thread.created':
        this.sink.post({ type: 'thread', id: e.threadId, title: e.title, status: 'running' });
        return;
      case 'thread.done': {
        const st = e.state as { status: string; output?: { content?: unknown }; error?: string };
        this.sink.post({ type: 'thread', id: e.threadId, title: e.title, status: st.status, summary: (contentText(st.output?.content as never) || st.error || '').slice(0, 400) });
        return;
      }
      case 'thread.context_compaction_started':
        this.sink.post({ type: 'phase', text: 'TrueForge is compacting older context...' });
        return;
      case 'mcp.initialize':
        return;
      default:
        return;
    }
  }

  private async decide(call: PendingCall, signal: AbortSignal): Promise<unknown> {
    const allow = { type: 'user.tool_approval', threadId: call.threadId, toolCallId: call.toolCallId, approval: { status: 'allow' } };
    const deny = (reason: string) => ({ type: 'user.tool_approval', threadId: call.threadId, toolCallId: call.toolCallId, approval: { status: 'deny', reason } });
    if (call.kind === 'response') {
      return { type: 'user.tool_response', threadId: call.threadId, toolCallId: call.toolCallId, content: 'This client cannot answer interactive questions; proceed with your best judgement and state assumptions.' };
    }
    if (call.toolName === 'edit_file' || call.toolName === 'write_file') {
      const r = await this.review(call, signal);
      if (r.ok) return allow;
      return deny(r.reason);
    }
    if (call.toolName === 'run_command') {
      const cmd = String(call.args.command ?? '');
      this.sink.post({ type: 'phase', text: `Waiting for approval to run: ${cmd}` });
      const ok = await this.sink.askApproval(call.toolCallId, 'Run command', cmd);
      return ok ? allow : deny('The user declined to run this command.');
    }
    const ok = await this.sink.askApproval(call.toolCallId, `Allow tool ${call.toolName}?`, JSON.stringify(call.args).slice(0, 400));
    return ok ? allow : deny('The user declined this tool call.');
  }

  private async review(call: PendingCall, signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
    const rel = String(call.args.path ?? '');
    let uri: vscode.Uri;
    try {
      uri = this.bridge.resolve(rel);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    const current = await this.bridge.currentText(uri);
    let proposed: string;
    const isNew = current === undefined;
    if (call.toolName === 'edit_file') {
      if (isNew) return { ok: false, reason: `${rel} does not exist. Use write_file to create it.` };
      const res = applyEdits(current, (call.args.edits as Edit[]) ?? []);
      if (!res.ok) {
        this.sink.post({ type: 'status', level: 'warn', message: `Edit to ${rel} could not be applied (${res.error}). Sent back to the agent to fix.` });
        return { ok: false, reason: res.error };
      }
      proposed = res.text;
    } else {
      proposed = String(call.args.content ?? '');
    }
    if (current !== undefined && proposed.replace(/\r\n/g, '\n') === current.replace(/\r\n/g, '\n')) {
      return { ok: false, reason: `That ${call.toolName} would not change ${rel}. Re-read the file; the change may already be there.` };
    }
    const explanation = String(call.args.explanation ?? '');
    this.sink.post({ type: 'phase', text: `Review ${rel}: accept or reject each hunk in the diff editor.` });
    const review = await this.reviews.open({ uri, original: current ?? '', proposed, isNew, title: isNew ? 'new file (Anvil)' : 'proposed by Anvil', explanation, runId: this.runId });
    this.sink.post({ type: 'review', id: review.id, file: rel, hunks: review.hunks.length, isNew, explanation, state: 'open' });
    const onAbort = (): void => this.reviews.cancel(review, 'stopped');
    signal.addEventListener('abort', onAbort, { once: true });
    const result = await review.done;
    signal.removeEventListener('abort', onAbort);
    this.sink.post({ type: 'review', id: review.id, file: rel, state: result.decided ? 'decided' : 'cancelled', accepted: result.accepted.length, rejected: result.rejected.length });
    if (!result.decided) return { ok: false, reason: 'Run stopped by the user.' };
    if (!result.accepted.length) return { ok: false, reason: `The user rejected all ${result.rejected.length} hunk(s) for ${rel}.` };
    this.bridge.decisions.set(callKey(call.toolName, call.args), {
      result,
      uri,
      relPath: review.relPath,
      original: current ?? '',
      isNew,
      runId: this.runId,
      explanation,
    });
    return { ok: true };
  }
}

function findCall(index: Map<string, Ev>, toolCallId: string): TrueForgeApi.ToolCall | undefined {
  for (const e of index.values()) {
    if (e.type === 'model.message') {
      const c = e.toolCalls?.find(t => t.id === toolCallId);
      if (c) return c;
    }
  }
  return undefined;
}

function shortArgs(raw: string): string {
  try {
    const a = JSON.parse(raw || '{}') as Record<string, unknown>;
    const parts = Object.entries(a)
      .filter(([k]) => !['content', 'edits', 'new_string', 'old_string'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 120));
    if (Array.isArray(a.edits)) parts.push(`${a.edits.length} edit(s)`);
    return parts.join(', ');
  } catch {
    return raw.slice(0, 160);
  }
}

export function summarizePack(pack: ContextPack): Record<string, unknown> {
  return {
    budget: pack.budget,
    used: pack.used,
    ms: pack.elapsedMs,
    items: pack.items.map(i => ({
      file: i.file,
      mode: i.mode,
      lines: i.startLine != null ? `${i.startLine + 1}-${(i.endLine ?? 0) + 1}` : '',
      tokens: i.tokens,
      reasons: i.reasons,
      source: i.source,
    })),
    dropped: pack.dropped.slice(0, 6),
  };
}
