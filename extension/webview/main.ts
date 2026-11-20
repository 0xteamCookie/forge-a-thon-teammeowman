// Agent panel UI. Plain DOM, no framework: the extension host owns all state; this renders
// messages as they arrive and sends user intents back.
declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();

type Msg = Record<string, any> & { type: string };

const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="bar">
    <div class="model"><span class="dot" id="dot"></span><span id="model">no session</span></div>
    <div class="actions">
      <button class="link" id="session" title="Open this run in the TrueForge UI" disabled>Session</button>
      <button class="link" id="new" title="Start a new conversation">New</button>
    </div>
  </header>
  <main id="log"><div class="empty" id="empty">
    <p>Describe a change. Anvil finds the files, proposes edits, and you review every hunk before anything is written.</p>
    <p class="muted">Use <code>@file:</code> or <code>@sym:</code> to add context explicitly.</p>
  </div></main>
  <div id="menu" class="menu" hidden></div>
  <footer class="composer">
    <textarea id="input" rows="3" placeholder="Ask Anvil to make a change..."></textarea>
    <div class="row">
      <span class="muted hint" id="hint">Enter to send · Shift+Enter for newline</span>
      <button id="send" class="primary">Send</button>
    </div>
  </footer>`;

const log = document.getElementById('log')!;
const input = document.getElementById('input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const menu = document.getElementById('menu')!;
const sessionBtn = document.getElementById('session') as HTMLButtonElement;
let running = false;
let assistant: HTMLElement | undefined;
let assistantText = '';
let phaseEl: HTMLElement | undefined;
const threads = new Map<string, HTMLElement>();
const reviews = new Map<string, HTMLElement>();
const approvals = new Map<string, HTMLElement>();

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function add(node: HTMLElement): HTMLElement {
  document.getElementById('empty')?.remove();
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.appendChild(node);
  if (nearBottom) log.scrollTop = log.scrollHeight;
  return node;
}

function fileLink(file: string, line?: string | number): HTMLElement {
  const a = el('a', 'file', file);
  a.addEventListener('click', () => vscode.postMessage({ type: 'openFile', file, line: typeof line === 'string' ? parseInt(line, 10) : line }));
  return a;
}

/** Minimal, safe markdown: fenced code, inline code, bold, paragraphs. */
function renderMarkdown(target: HTMLElement, text: string): void {
  target.textContent = '';
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = el('pre');
      pre.textContent = part.replace(/^[^\n]*\n/, '');
      target.appendChild(pre);
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = el('p');
      for (const seg of para.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
        if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) p.appendChild(el('code', '', seg.slice(1, -1)));
        else if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 4) p.appendChild(el('strong', '', seg.slice(2, -2)));
        else p.appendChild(document.createTextNode(seg));
      }
      target.appendChild(p);
    }
  });
}

function setRunning(r: boolean): void {
  running = r;
  sendBtn.textContent = r ? 'Stop' : 'Send';
  sendBtn.className = r ? 'danger' : 'primary';
  (document.getElementById('dot') as HTMLElement).className = r ? 'dot live' : 'dot';
  if (!r) {
    phaseEl?.remove();
    phaseEl = undefined;
  }
}

function phase(text: string): void {
  if (!phaseEl) phaseEl = add(el('div', 'phase'));
  phaseEl.textContent = text;
  log.appendChild(phaseEl);
}

function contextCard(m: Msg): void {
  const p = m.pack;
  const card = el('details', 'card context');
  (card as HTMLDetailsElement).open = m.origin.startsWith('automatic');
  const sum = el('summary');
  const files = new Set(p.items.map((i: any) => i.file)).size;
  sum.append(el('span', 'label', 'Context'), el('span', '', ` ${files} files · ${p.used.toLocaleString()} / ${p.budget.toLocaleString()} tokens`), el('span', 'muted', ` · ${m.origin}`));
  card.appendChild(sum);
  const meter = el('div', 'meter');
  const fill = el('div', 'fill');
  fill.style.width = `${Math.min(100, (p.used / p.budget) * 100)}%`;
  meter.appendChild(fill);
  card.appendChild(meter);
  const list = el('ul', 'ctx');
  for (const it of p.items) {
    const li = el('li');
    const head = el('div', 'ctx-head');
    head.append(fileLink(it.file, it.lines ? it.lines.split('-')[0] : 1), el('span', `tag ${it.mode}`, it.mode + (it.lines ? ` ${it.lines}` : '')), el('span', 'muted', `${it.tokens} tok`));
    li.appendChild(head);
    li.appendChild(el('div', 'why', it.reasons.join(' · ')));
    list.appendChild(li);
  }
  card.appendChild(list);
  if (p.dropped?.length) {
    card.appendChild(el('div', 'muted small', 'Left out: ' + p.dropped.map((d: any) => `${d.file} (${d.reason})`).join('; ')));
  }
  add(card);
}

function toolRow(m: Msg): void {
  const host = m.thread && m.thread !== 'main' ? threads.get(m.thread) : undefined;
  const row = el('details', `tool${m.system ? ' system' : ''}`);
  const sum = el('summary');
  sum.append(el('span', 'tname', m.system ? `harness · ${m.name}` : m.name), el('span', 'muted', ` ${m.args ?? ''}`));
  row.appendChild(sum);
  const pre = el('pre', 'result');
  pre.textContent = m.result ?? '';
  row.appendChild(pre);
  if (host) host.querySelector('.thread-body')!.appendChild(row);
  else add(row);
}

function threadCard(m: Msg): void {
  let card = threads.get(m.id);
  if (!card) {
    card = el('details', 'card thread');
    const sum = el('summary');
    sum.append(el('span', 'label', 'Subagent'), el('span', 'ttitle', ` ${m.title}`), el('span', 'tstate muted', ' running'));
    card.appendChild(sum);
    card.appendChild(el('div', 'thread-body'));
    threads.set(m.id, card);
    add(card);
  }
  card.querySelector('.tstate')!.textContent = ` ${m.status}`;
  if (m.summary) card.querySelector('.thread-body')!.appendChild(el('div', 'why', m.summary));
}

function reviewCard(m: Msg): void {
  let card = reviews.get(m.id);
  if (!card) {
    card = el('div', 'card review');
    reviews.set(m.id, card);
    add(card);
  }
  card.textContent = '';
  const head = el('div', 'ctx-head');
  head.append(el('span', 'label', m.isNew ? 'New file' : 'Edit'), fileLink(m.file));
  card.appendChild(head);
  if (m.state === 'open') {
    card.appendChild(el('div', 'muted', `${m.hunks} hunk(s) waiting in the diff editor. Accept or reject each one there.`));
    if (m.explanation) card.appendChild(el('div', 'why', m.explanation));
  } else if (m.state === 'decided') {
    card.appendChild(el('div', m.accepted ? 'ok' : 'muted', `${m.accepted} accepted · ${m.rejected} rejected`));
  } else {
    card.appendChild(el('div', 'muted', 'Discarded (run stopped). Nothing written.'));
  }
}

function approvalCard(m: Msg): void {
  const card = el('div', 'card approval');
  card.append(el('div', 'label', m.title), el('pre', 'cmd', m.detail));
  const row = el('div', 'row');
  const yes = el('button', 'primary', 'Allow') as HTMLButtonElement;
  const no = el('button', '', 'Deny') as HTMLButtonElement;
  yes.onclick = () => vscode.postMessage({ type: 'approve', id: m.id, ok: true });
  no.onclick = () => vscode.postMessage({ type: 'approve', id: m.id, ok: false });
  row.append(yes, no);
  card.appendChild(row);
  approvals.set(m.id, card);
  add(card);
}

window.addEventListener('message', (e: MessageEvent<Msg>) => {
  const m = e.data;
  switch (m.type) {
    case 'user': {
      const u = add(el('div', 'msg user'));
      u.textContent = m.text;
      assistant = undefined;
      assistantText = '';
      break;
    }
    case 'running':
      setRunning(!!m.running);
      if (m.running) phase('Assembling context...');
      break;
    case 'session':
      document.getElementById('model')!.textContent = m.model;
      sessionBtn.disabled = false;
      sessionBtn.title = `${m.agent} · ${m.url}`;
      break;
    case 'context':
      contextCard(m);
      phase('Waiting for the model...');
      break;
    case 'text':
      if (!assistant) {
        assistant = add(el('div', 'msg assistant'));
        assistantText = '';
      }
      assistantText += m.delta;
      renderMarkdown(assistant, assistantText);
      if (phaseEl) log.appendChild(phaseEl);
      if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight;
      break;
    case 'tool':
      assistant = undefined;
      toolRow(m);
      phase(`Agent is working (${m.name})...`);
      break;
    case 'thread':
      threadCard(m);
      break;
    case 'review':
      assistant = undefined;
      reviewCard(m);
      break;
    case 'approval':
      approvalCard(m);
      break;
    case 'approvalResolved': {
      const c = approvals.get(m.id);
      if (c) {
        c.querySelector('.row')?.remove();
        c.appendChild(el('div', m.ok ? 'ok' : 'muted', m.ok ? 'Allowed' : 'Denied'));
      }
      break;
    }
    case 'applied': {
      const row = add(el('div', 'card applied'));
      row.append(el('span', 'ok', '✓ '), el('span', '', m.summary));
      const undo = el('button', 'link', 'Undo') as HTMLButtonElement;
      undo.onclick = () => {
        vscode.postMessage({ type: 'undo', file: m.file });
        undo.disabled = true;
        undo.textContent = 'Undone';
      };
      row.appendChild(undo);
      break;
    }
    case 'phase':
      phase(m.text);
      break;
    case 'status':
      add(el('div', `status ${m.level}`, m.message));
      break;
    case 'done': {
      const secs = m.ms ? ` in ${(m.ms / 1000).toFixed(1)}s` : '';
      add(el('div', `done ${m.status}`, m.status === 'done' ? `Done${secs}${m.model ? ` · ${m.model}` : ''}` : m.status === 'cancelled' ? 'Stopped' : `Failed${secs}`));
      break;
    }
    case 'cleared':
      log.textContent = '';
      threads.clear();
      reviews.clear();
      document.getElementById('model')!.textContent = 'no session';
      sessionBtn.disabled = true;
      break;
    case 'mentionResults':
      showMenu(m.items);
      break;
  }
});

// ---- composer and @-mentions -----------------------------------------------------------------

let menuItems: Array<{ label: string; insert: string; detail: string }> = [];
let menuIndex = 0;

function mentionAtCursor(): { start: number; kind: 'file' | 'sym'; q: string } | undefined {
  const upto = input.value.slice(0, input.selectionStart);
  const m = /@(file:|sym:)?([\w./-]*)$/.exec(upto);
  if (!m) return undefined;
  return { start: upto.length - m[0].length, kind: m[1] === 'sym:' ? 'sym' : 'file', q: m[2] };
}

function showMenu(items: typeof menuItems): void {
  menuItems = items;
  menuIndex = 0;
  if (!items.length || !mentionAtCursor()) {
    menu.hidden = true;
    return;
  }
  menu.textContent = '';
  items.forEach((it, i) => {
    const row = el('div', `item${i === menuIndex ? ' active' : ''}`);
    row.append(el('span', '', it.label), el('span', 'muted', ` ${it.detail}`));
    row.onmousedown = ev => {
      ev.preventDefault();
      pick(i);
    };
    menu.appendChild(row);
  });
  menu.hidden = false;
}

function pick(i: number): void {
  const at = mentionAtCursor();
  const it = menuItems[i];
  if (!at || !it) return;
  const before = input.value.slice(0, at.start);
  const after = input.value.slice(input.selectionStart);
  input.value = `${before}${it.insert} ${after}`;
  const pos = before.length + it.insert.length + 1;
  input.setSelectionRange(pos, pos);
  menu.hidden = true;
  input.focus();
}

input.addEventListener('input', () => {
  const at = mentionAtCursor();
  if (at) vscode.postMessage({ type: 'mentionQuery', kind: at.kind, q: at.q });
  else menu.hidden = true;
});

input.addEventListener('keydown', ev => {
  if (!menu.hidden) {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      menuIndex = (menuIndex + (ev.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length;
      [...menu.children].forEach((c, i) => c.classList.toggle('active', i === menuIndex));
      return;
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault();
      pick(menuIndex);
      return;
    }
    if (ev.key === 'Escape') {
      menu.hidden = true;
      return;
    }
  }
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    submit();
  }
  if (ev.key === 'Escape' && running) vscode.postMessage({ type: 'stop' });
});

function submit(): void {
  if (running) {
    vscode.postMessage({ type: 'stop' });
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  vscode.postMessage({ type: 'send', text });
}

sendBtn.addEventListener('click', submit);
document.getElementById('new')!.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
sessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSession' }));
vscode.postMessage({ type: 'ready' });
