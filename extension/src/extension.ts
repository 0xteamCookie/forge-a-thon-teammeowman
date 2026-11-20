import * as path from 'node:path';
import * as vscode from 'vscode';
import anvilCoder from '../agents/anvil-coder.json';
import anvilInline from '../agents/anvil-inline.json';
import { AgentController } from './agent/controller';
import { Bridge } from './agent/bridge';
import { WorkspaceIndex } from './context/index';
import { InlineEditor } from './inline/inlineEdit';
import { type RunningMcp, SERVER_NAME, startMcpHttp } from './mcp/server';
import { AgentPanel } from './panel/agentPanel';
import { ReviewManager } from './review/reviewManager';
import { type AgentTemplate, errText, TrueForgeService } from './trueforge/service';

let mcp: RunningMcp | undefined;

/** Internal handles returned from activate(); used by the integration tests only. */
export interface AnvilApi {
  reviews: ReviewManager;
  agent: AgentController;
  inline: InlineEditor;
  panel: AgentPanel;
  ready: () => Promise<void>;
  indexed: () => boolean;
}

export async function activate(context: vscode.ExtensionContext): Promise<AnvilApi> {
  const out = vscode.window.createOutputChannel('Anvil');
  const log = (m: string): void => out.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('anvil');
  const folder = vscode.workspace.workspaceFolders?.[0];
  const root = folder?.uri;

  // ---- index -------------------------------------------------------------------------------
  let index: WorkspaceIndex | undefined;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = 'anvil.selectModel';
  context.subscriptions.push(status, out);
  const renderStatus = (extra?: string): void => {
    const models = cfg().get<string[]>('models') ?? [];
    const primary = models[0] ?? 'no model set';
    status.text = `$(flame) Anvil · ${primary}${models.length > 1 ? ` (+${models.length - 1} fallback)` : ''}${extra ? ` · ${extra}` : ''}`;
    status.tooltip = `Model order: ${models.join(' -> ') || '(none)'}\nIndex: ${index ? `${index.files.size} files, ${index.chunkCount} chunks, ${index.symbols.length} symbols` : 'building'}\nClick to change models.`;
    status.show();
  };
  const buildIndex = async (): Promise<void> => {
    if (!root) return;
    renderStatus('indexing');
    try {
      index = await WorkspaceIndex.build(root.fsPath);
      log(`indexed ${index.files.size} files, ${index.chunkCount} chunks, ${index.symbols.length} symbols in ${index.buildMs}ms`);
    } catch (e) {
      log(`index failed: ${errText(e)}`);
    }
    renderStatus();
  };
  const indexing = buildIndex();
  const pendingRefresh = new Set<string>();
  let refreshTimer: NodeJS.Timeout | undefined;
  const refreshFile = (rel: string): void => {
    pendingRefresh.add(rel);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const files = [...pendingRefresh];
      pendingRefresh.clear();
      void (async () => {
        for (const f of files) await index?.refreshFile(f);
      })();
    }, 300);
  };
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    const onFs = (u: vscode.Uri): void => {
      const rel = path.relative(root.fsPath, u.fsPath).split(path.sep).join('/');
      // Ignore tool churn (.venv installs, __pycache__ from pytest, node_modules): only source
      // files the index cares about trigger a refresh.
      const segs = rel.split('/');
      if (segs.some(s => s.startsWith('.') || ['node_modules', '__pycache__', 'venv', 'dist', 'build'].includes(s))) return;
      if (!/\.(py|tsx?|jsx?|mjs|cjs|go|rs|java|rb|md|rst|txt|toml|cfg|ini|json|ya?ml|html|css)$/i.test(rel)) return;
      refreshFile(rel);
    };
    watcher.onDidChange(onFs);
    watcher.onDidCreate(onFs);
    watcher.onDidDelete(onFs);
    context.subscriptions.push(watcher);
  }

  // ---- core services -----------------------------------------------------------------------
  const reviews = new ReviewManager(root ?? vscode.Uri.file('/'), rel => refreshFile(rel));
  context.subscriptions.push(reviews);
  const bridge = new Bridge(root ?? vscode.Uri.file('/'), () => index, reviews, cfg);
  bridge.onToolCall = (name, args) => log(`tool ${name} ${JSON.stringify(args).slice(0, 200)}`);
  const templates = { coder: anvilCoder as AgentTemplate, inline: anvilInline as AgentTemplate };
  const svc = new TrueForgeService(cfg().get<string>('trueforgeUrl') ?? 'http://localhost:8790', templates, log);
  const panel = new AgentPanel(context.extensionUri, () => index, root);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }));
  const agent = new AgentController(svc, bridge, reviews, () => index, cfg, panel);
  const inline = new InlineEditor(svc, reviews, () => index, cfg);

  // ---- MCP server + TrueForge registration ---------------------------------------------------
  const connect = async (): Promise<void> => {
    try {
      if (!mcp) {
        const base = cfg().get<number>('mcpPort') ?? 7801;
        let lastErr: unknown;
        for (let p = base; p < base + 10 && !mcp; p++) {
          try {
            mcp = await startMcpHttp(bridge, p, log);
          } catch (e) {
            lastErr = e;
          }
        }
        if (!mcp) throw lastErr;
        log(`MCP server listening on ${mcp.url}`);
      }
      svc.setBaseUrl(cfg().get<string>('trueforgeUrl') ?? 'http://localhost:8790');
      await svc.ping();
      await svc.registerMcp(SERVER_NAME, mcp.url, mcp.token);
      for (const m of cfg().get<string[]>('models') ?? []) {
        try {
          await svc.ensureAgent('coder', m);
          await svc.ensureAgent('inline', m);
        } catch (e) {
          log(`could not register agents for ${m}: ${errText(e)}`);
        }
      }
      panel.post({ type: 'status', level: 'info', message: `Connected to TrueForge at ${svc.baseUrl}. Editor tools registered as MCP server "${SERVER_NAME}".` });
    } catch (e) {
      const msg = errText(e);
      log(`connect failed: ${msg}`);
      panel.post({ type: 'status', level: 'warn', message: msg });
    }
  };
  const connecting = connect();
  context.subscriptions.push({ dispose: () => void mcp?.close() });

  // ---- panel wiring --------------------------------------------------------------------------
  panel.onSend = text => void agent.run(text);
  panel.onStop = () => agent.stop();
  panel.onNewChat = () => agent.newChat();
  panel.onOpenSession = () => {
    if (agent.sessionId) void vscode.env.openExternal(vscode.Uri.parse(svc.sessionUrl(agent.sessionId)));
  };
  panel.onUndo = file => {
    const change = [...reviews.applied].reverse().find(c => c.relPath === file);
    if (change) void reviews.undo(change).then(() => panel.post({ type: 'status', level: 'info', message: `Undid the change to ${file}.` }));
  };

  // ---- commands ------------------------------------------------------------------------------
  const cmd = (id: string, fn: (...a: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };
  cmd('anvil.inlineEdit', (instruction?: unknown) => inline.run(typeof instruction === 'string' ? instruction : undefined));
  cmd('anvil.cancel', () => {
    if (!inline.cancel()) {
      panel.denyAll();
      agent.stop();
    }
  });
  cmd('anvil.acceptHunk', (reviewId?: string, hunkId?: number) =>
    reviewId ? reviews.decide(reviewId, hunkId!, 'accepted') : reviews.decideAtCursor('accepted'),
  );
  cmd('anvil.rejectHunk', (reviewId?: string, hunkId?: number) =>
    reviewId ? reviews.decide(reviewId, hunkId!, 'rejected') : reviews.decideAtCursor('rejected'),
  );
  const activeReviewId = (arg?: unknown): string | undefined => {
    if (typeof arg === 'string') return arg;
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    const q = uri ? new URLSearchParams(uri.query).get('review') : null;
    return q ?? reviews.pending[0]?.id;
  };
  cmd('anvil.acceptAll', (arg?: unknown) => {
    const id = activeReviewId(arg);
    if (id) reviews.decide(id, 'all', 'accepted');
  });
  cmd('anvil.rejectAll', (arg?: unknown) => {
    const id = activeReviewId(arg);
    if (id) reviews.decide(id, 'all', 'rejected');
  });
  cmd('anvil.undoLastApply', async () => {
    const c = await reviews.undoLast();
    void vscode.window.showInformationMessage(c ? `Anvil: undid ${c.label}.` : 'Anvil: nothing to undo.');
  });
  cmd('anvil.reindex', () => buildIndex());
  cmd('anvil.reconnect', () => connect());
  cmd('anvil.openSession', () => panel.onOpenSession?.());
  cmd('anvil.selectModel', async () => {
    let models: string[] = [];
    try {
      models = await svc.availableModels();
    } catch (e) {
      void vscode.window.showErrorMessage(`Anvil: could not list TrueForge models: ${errText(e)}`);
      return;
    }
    if (!models.length) {
      void vscode.window.showWarningMessage('Anvil: no models configured in TrueForge. Add one under Settings -> Models in the TrueForge UI.');
      return;
    }
    const primary = await vscode.window.showQuickPick(models, { title: 'Anvil: primary model', placeHolder: 'Model used first' });
    if (!primary) return;
    const order = [primary];
    for (;;) {
      const rest = models.filter(m => !order.includes(m));
      if (!rest.length) break;
      const next = await vscode.window.showQuickPick(['(done)', ...rest], { title: `Anvil: fallback #${order.length}`, placeHolder: 'Used automatically if the previous model fails' });
      if (!next || next === '(done)') break;
      order.push(next);
    }
    await cfg().update('models', order, vscode.ConfigurationTarget.Workspace);
    void connect();
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('anvil.models')) {
        renderStatus();
        void connect();
      }
      if (e.affectsConfiguration('anvil.trueforgeUrl')) void connect();
    }),
  );
  renderStatus();
  return { reviews, agent, inline, panel, ready: async () => { await indexing; await connecting; }, indexed: () => !!index };
}

export async function deactivate(): Promise<void> {
  await mcp?.close();
}
