import * as vscode from 'vscode';
import { type WorkspaceIndex } from '../context/index';
import { type PanelMessage, type PanelSink } from '../agent/controller';

export class AgentPanel implements vscode.WebviewViewProvider, PanelSink {
  static readonly viewId = 'anvil.agentPanel';
  private view?: vscode.WebviewView;
  private readonly backlog: PanelMessage[] = [];
  private readonly approvals = new Map<string, (ok: boolean) => void>();
  onSend?: (text: string) => void;
  onStop?: () => void;
  onNewChat?: () => void;
  onUndo?: (file: string) => void;
  onOpenSession?: () => void;

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly getIndex: () => WorkspaceIndex | undefined,
    private readonly root: vscode.Uri | undefined,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'dist'), vscode.Uri.joinPath(this.extUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: PanelMessage) => this.receive(m));
    view.onDidDispose(() => (this.view = undefined));
  }

  post(msg: PanelMessage): void {
    if (!this.view) {
      this.backlog.push(msg);
      return;
    }
    void this.view.webview.postMessage(msg);
  }

  askApproval(id: string, title: string, detail: string): Promise<boolean> {
    void vscode.commands.executeCommand(`${AgentPanel.viewId}.focus`);
    this.post({ type: 'approval', id, title, detail });
    return new Promise(resolve => this.approvals.set(id, resolve));
  }

  /** Ids of approval cards waiting for the user (integration tests answer them). */
  pendingApprovals(): string[] {
    return [...this.approvals.keys()];
  }

  answer(id: string, ok: boolean): void {
    this.receive({ type: 'approve', id, ok });
  }

  /** Any pending approval cards are answered "no" (used by Stop). */
  denyAll(): void {
    for (const [id, r] of this.approvals) {
      r(false);
      this.post({ type: 'approvalResolved', id, ok: false });
    }
    this.approvals.clear();
  }

  private receive(m: PanelMessage): void {
    switch (m.type) {
      case 'ready':
        for (const b of this.backlog.splice(0)) void this.view?.webview.postMessage(b);
        return;
      case 'send':
        this.onSend?.(String(m.text ?? ''));
        return;
      case 'stop':
        this.denyAll();
        this.onStop?.();
        return;
      case 'newChat':
        this.onNewChat?.();
        return;
      case 'approve': {
        const id = String(m.id);
        this.approvals.get(id)?.(!!m.ok);
        this.approvals.delete(id);
        this.post({ type: 'approvalResolved', id, ok: !!m.ok });
        return;
      }
      case 'undo':
        this.onUndo?.(String(m.file));
        return;
      case 'openSession':
        this.onOpenSession?.();
        return;
      case 'openFile': {
        if (!this.root) return;
        const uri = vscode.Uri.joinPath(this.root, String(m.file));
        const line = Math.max(0, Number(m.line ?? 1) - 1);
        void vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0), preview: true });
        return;
      }
      case 'mentionQuery': {
        const q = String(m.q ?? '').toLowerCase();
        const idx = this.getIndex();
        if (!idx) return;
        const kind = String(m.kind);
        const items =
          kind === 'sym'
            ? idx.searchSymbols(q, 12).map(s => ({ label: s.container ? `${s.container}.${s.name}` : s.name, insert: `@sym:${s.container ? `${s.container}.${s.name}` : s.name}`, detail: `${s.kind} · ${s.file}:${s.line + 1}` }))
            : [...idx.files.keys()]
                .filter(f => f.toLowerCase().includes(q))
                .sort((a, b) => a.length - b.length)
                .slice(0, 12)
                .map(f => ({ label: f, insert: `@file:${f}`, detail: '' }));
        this.post({ type: 'mentionResults', items });
        return;
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'dist', 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'panel.css'));
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
