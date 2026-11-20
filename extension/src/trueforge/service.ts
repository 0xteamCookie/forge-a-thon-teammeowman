// Everything that talks to TrueForge lives here. The extension never calls a model provider:
// it opens sessions on TrueForge agents and renders the events TrueForge streams back.
import { isEventDelta, mergeEventDelta, TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';

type Ev = TrueForgeApi.TurnStreamingEvent;
export type AgentKind = 'coder' | 'inline';

export interface AgentTemplate {
  name: string;
  description: string;
  manifest: Record<string, unknown>;
}

export interface PendingCall {
  threadId: string;
  toolCallId: string;
  toolName: string;
  serverName?: string;
  args: Record<string, unknown>;
  kind: 'approval' | 'response';
}

export interface TurnOutcome {
  status: 'done' | 'paused' | 'cancelled' | 'error';
  text: string;
  pending: PendingCall[];
  error?: string;
  sessionId: string;
  model: string;
}

export interface TurnCallbacks {
  /** Streaming text from the main thread. */
  onText?(delta: string): void;
  /** Every non-delta event, plus deltas, for UIs that render tool calls and subagents. */
  onEvent?(event: Ev, index: Map<string, Ev>): void;
  onStatus?(message: string, level: 'info' | 'warn' | 'error'): void;
  onSession?(sessionId: string, model: string, agentName: string): void;
}

export class TrueForgeUnreachable extends Error {}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

export function agentNameFor(kind: AgentKind, model: string): string {
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `anvil-${kind}-${slug}`.slice(0, 63).replace(/-+$/, '');
}

export class TrueForgeService {
  client: TrueForge;

  constructor(
    public baseUrl: string,
    private readonly templates: Record<AgentKind, AgentTemplate>,
    private readonly log: (m: string) => void,
  ) {
    this.client = new TrueForge({ baseUrl, timeoutInSeconds: 900, maxRetries: 0 });
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url;
    this.client = new TrueForge({ baseUrl: url, timeoutInSeconds: 900, maxRetries: 0 });
  }

  sessionUrl(sessionId: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/sessions/${sessionId}`;
  }

  async ping(): Promise<void> {
    try {
      await this.client.server.getCapabilities({ timeoutInSeconds: 3, maxRetries: 0 });
    } catch (e) {
      throw new TrueForgeUnreachable(
        `TrueForge is not reachable at ${this.baseUrl} (${errText(e)}). Start it with: OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@latest`,
      );
    }
  }

  async availableModels(): Promise<string[]> {
    const { data } = await this.client.models.list();
    const list = (data as unknown as { data?: Array<{ name: string; provider?: { name?: string } }> }).data ?? [];
    return list.map(m => (m.name.includes('/') ? m.name : `${m.provider?.name ?? ''}/${m.name}`));
  }

  /** Register (or re-point) the editor MCP server. Port and token change per VS Code launch. */
  async registerMcp(name: string, url: string, token: string): Promise<void> {
    await this.client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: 'remote',
        name,
        url,
        description: 'Anvil VS Code editor tools: read, search, retrieve context, reviewed writes, terminal commands.',
        auth: { type: 'header', headers: { Authorization: `Bearer ${token}` } },
      },
    });
    this.log(`registered MCP server ${name} -> ${url}`);
  }

  /** One saved agent per (kind, model), built from the definition shipped in the repo. */
  async ensureAgent(kind: AgentKind, model: string): Promise<string> {
    const tpl = this.templates[kind];
    const name = agentNameFor(kind, model);
    const manifest = JSON.parse(JSON.stringify(tpl.manifest)) as Record<string, unknown> & { model: { name: string } };
    manifest.model = { ...(manifest.model ?? {}), name: model };
    const description = `${tpl.description} (model: ${model})`;
    const page = await this.client.agents.list({ agentName: name, limit: 1 });
    const existing = page.data.find(a => a.name === name);
    if (existing) {
      await this.client.agents.update(existing.id, { description, manifest: manifest as unknown as TrueForgeApi.AgentSpec });
    } else {
      await this.client.agents.create({ name, description, manifest: manifest as unknown as TrueForgeApi.AgentSpec });
    }
    return name;
  }

  async cancel(sessionId: string): Promise<void> {
    try {
      await this.client.sessions.cancel(sessionId, undefined, { timeoutInSeconds: 5, maxRetries: 0 });
    } catch (e) {
      this.log(`cancel ${sessionId} failed: ${errText(e)}`);
    }
  }

  /**
   * Stream one turn. Resolves when TrueForge sends turn.done (or the stream breaks). On abort
   * we ask TrueForge to cancel and keep reading until its terminal turn.done, with a hard
   * timeout so the editor can never be left waiting.
   */
  async streamTurn(sessionId: string, model: string, input: unknown[], cb: TurnCallbacks, signal?: AbortSignal): Promise<TurnOutcome> {
    const index = new Map<string, Ev>();
    const http = new AbortController();
    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      void this.cancel(sessionId);
      setTimeout(() => http.abort(), 4000);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const pendingRefs: Array<{ threadId: string; id: string; sourceEventId: string; kind: 'approval' | 'response' }> = [];
    let text = '';
    let outcome: TurnOutcome | undefined;
    try {
      const stream = await this.client.sessions.createTurnStream(
        sessionId,
        { input } as unknown as TrueForgeApi.CreateTurnSessionsStreamRequest,
        { abortSignal: http.signal, timeoutInSeconds: 900, maxRetries: 0 },
      );
      for await (const { data: event } of stream.withMetadata()) {
        if (isEventDelta(event)) {
          const base = index.get(event.id);
          if (base) mergeEventDelta(base, event as TrueForgeApi.ModelMessageDeltaEvent);
          if (event.threadId === 'main' && typeof event.content === 'string' && event.content) {
            text += event.content;
            cb.onText?.(event.content);
          }
        } else {
          index.set(event.id, event);
        }
        cb.onEvent?.(event, index);
        if (event.type === 'tool.approval_required' || event.type === 'tool.response_required') {
          for (const ref of event.toolCalls) {
            pendingRefs.push({ threadId: event.threadId, id: ref.id, sourceEventId: ref.sourceEventId, kind: event.type === 'tool.approval_required' ? 'approval' : 'response' });
          }
        }
        if (event.type === 'turn.done') {
          const st = event.state as { status: string; message?: string; output?: TrueForgeApi.ModelMessageEvent | null; reason?: string };
          const finalText = contentText(st.output?.content) || text;
          if (st.status === 'error') outcome = { status: 'error', text: finalText, pending: [], error: st.message ?? 'unknown error', sessionId, model };
          else if (st.status === 'cancelled') outcome = { status: 'cancelled', text: finalText, pending: [], sessionId, model };
          else outcome = { status: pendingRefs.length ? 'paused' : 'done', text: finalText, pending: [], sessionId, model };
        }
      }
    } catch (e) {
      if (cancelled) return { status: 'cancelled', text, pending: [], sessionId, model };
      return { status: 'error', text, pending: [], error: errText(e), sessionId, model };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (cancelled) return { status: 'cancelled', text, pending: [], sessionId, model };
    outcome ??= { status: 'error', text, pending: [], error: 'stream ended without turn.done', sessionId, model };
    if (outcome.status === 'paused') {
      for (const ref of pendingRefs) {
        const msg = index.get(ref.sourceEventId);
        const call = msg?.type === 'model.message' ? msg.toolCalls?.find(tc => tc.id === ref.id) : undefined;
        if (!call) continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = { _unparsed: call.function.arguments };
        }
        const info = call.toolInfo as { name: string; serverName?: string };
        outcome.pending.push({ threadId: ref.threadId, toolCallId: ref.id, toolName: info.name, serverName: info.serverName, args, kind: ref.kind });
      }
    }
    return outcome;
  }
}

export function contentText(c: TrueForgeApi.ModelMessageEventContent | null | undefined): string {
  if (!c) return '';
  if (typeof c === 'string') return c;
  return c.map(p => ((p as { text?: string }).text ?? '')).join('');
}

export function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const anyE = e as { statusCode?: number; body?: unknown; message?: string; cause?: unknown };
    if (anyE.statusCode) {
      const body = typeof anyE.body === 'string' ? anyE.body : JSON.stringify(anyE.body ?? '');
      return `HTTP ${anyE.statusCode}: ${body.slice(0, 300)}`;
    }
    if (anyE.cause instanceof Error) return `${anyE.message ?? ''} (${anyE.cause.message})`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * A conversation with automatic recovery. A failed turn that produced nothing (no text, no tool
 * calls) is safe to replay, so we retry the same model with exponential backoff, then move to the
 * next configured model in a fresh session. Anything that already acted is never replayed.
 */
export class ResilientConversation {
  sessionId?: string;
  model?: string;
  private modelIndex = 0;

  constructor(
    private readonly svc: TrueForgeService,
    private readonly kind: AgentKind,
    private readonly models: () => string[],
    private readonly retriesPerModel: () => number,
  ) {}

  get started(): boolean {
    return !!this.sessionId;
  }

  async send(input: unknown[], cb: TurnCallbacks, signal?: AbortSignal): Promise<TurnOutcome> {
    const models = this.models();
    if (!models.length) {
      return { status: 'error', text: '', pending: [], error: 'No models configured. Set "anvil.models" (e.g. ["openai/gpt-4.1-mini", "groq/llama-3.3-70b"]) or run "Anvil: Select Model Order".', sessionId: '', model: '' };
    }
    await this.svc.ping();
    const isResume = input.every(i => (i as { type: string }).type !== 'user.message');
    if (isResume && this.sessionId && this.model) {
      return this.svc.streamTurn(this.sessionId, this.model, input, cb, signal);
    }
    let lastError = '';
    for (let m = this.modelIndex; m < models.length; m++) {
      const model = models[m];
      const attempts = 1 + Math.max(0, this.retriesPerModel());
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (signal?.aborted) return { status: 'cancelled', text: '', pending: [], sessionId: this.sessionId ?? '', model };
        let agentName: string;
        try {
          agentName = await this.svc.ensureAgent(this.kind, model);
          if (!this.sessionId || this.model !== model) {
            const { data } = await this.svc.client.sessions.create({ agent: { name: agentName }, metadata: { client: 'anvil-vscode', kind: this.kind } as unknown as TrueForgeApi.SessionMetadata });
            this.sessionId = data.id;
            this.model = model;
            this.modelIndex = m;
            cb.onSession?.(data.id, model, agentName);
          }
        } catch (e) {
          lastError = errText(e);
          cb.onStatus?.(`Could not start a session on ${model}: ${lastError}`, 'warn');
          break; // configuration problem with this model: go straight to the next one
        }
        let produced = false;
        const wrapped: TurnCallbacks = {
          ...cb,
          onText: d => {
            produced = true;
            cb.onText?.(d);
          },
          onEvent: (e, idx) => {
            if (e.type === 'tool.response' || e.type === 'tool.approval_required' || (e.type === 'model.message' && (e.toolCalls?.length ?? 0) > 0)) produced = true;
            cb.onEvent?.(e, idx);
          },
        };
        const out = await this.svc.streamTurn(this.sessionId!, model, input, wrapped, signal);
        if (out.status !== 'error') return out;
        lastError = out.error ?? 'unknown error';
        if (produced) {
          cb.onStatus?.(`Model ${model} failed mid-run: ${lastError}. Not replaying automatically because the run already acted.`, 'error');
          return out;
        }
        if (attempt < attempts) {
          const wait = 1000 * 2 ** (attempt - 1);
          cb.onStatus?.(`${model} failed (${shorten(lastError)}). Retrying in ${wait / 1000}s (attempt ${attempt + 1}/${attempts})...`, 'warn');
          await sleep(wait, signal);
        }
      }
      if (m + 1 < models.length) {
        cb.onStatus?.(`${model} is unavailable (${shorten(lastError)}). Falling back to ${models[m + 1]} automatically.`, 'warn');
        this.sessionId = undefined;
      }
    }
    return { status: 'error', text: '', pending: [], error: `All configured models failed. Last error: ${lastError}`, sessionId: this.sessionId ?? '', model: this.model ?? '' };
  }

  reset(): void {
    this.sessionId = undefined;
    this.model = undefined;
    this.modelIndex = 0;
  }
}

function shorten(s: string): string {
  return s.length > 140 ? s.slice(0, 137) + '...' : s;
}
