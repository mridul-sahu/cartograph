// Cartograph — VS Code extension.
//
// Surfaces the Cartograph knowledge base inside the editor:
//   #1 passive knowledge — gutter markers on cited lines, hover cards,
//      a file-header banner (status bar) telling you how well-charted
//      the file is
//   #2 walkthrough tours — step through a walkthrough; the editor jumps
//      to each cited file:line, across repos
//   #3 Claude in context — select code, ⌘⇧A, get an answer grounded in
//      the bedrock + topic notes
//   #4 cross-repo seams — jump along the architectural edges
//
// Talks to the Cartograph status server (default http://localhost:47777).
// Runs inside code-server; the extension host is node, so localhost is
// reachable.
import * as vscode from 'vscode';
import * as http from 'node:http';
import * as path from 'node:path';

// ── API client ──────────────────────────────────────────────────────────

function apiBase(): string {
  return vscode.workspace
    .getConfiguration('cartograph')
    .get<string>('apiBase', 'http://localhost:47777');
}

function apiGet<T>(p: string): Promise<T> {
  return request<T>('GET', p);
}
function apiPost<T>(p: string, body: unknown): Promise<T> {
  return request<T>('POST', p, body);
}

function request<T>(method: string, p: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(apiBase() + p);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
        timeout: 300_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error('non-JSON response'));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── repo / path helpers ─────────────────────────────────────────────────

const KNOWN_REPOS = ['jax', 'xla', 'orbax', 'tunix', 'tokamax'];

interface WorkspaceCtx {
  repo: string;
  repoRoot: string; // absolute path to workspace/<repo>
  cartographRoot: string; // absolute path to <cartograph-root>
}

function workspaceCtx(): WorkspaceCtx | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const fsPath = folders[0].uri.fsPath;
  // Expect …/cartograph/workspace/<repo>
  const m = /^(.*)\/workspace\/([^/]+)\/?$/.exec(fsPath);
  if (!m) return null;
  const repo = m[2];
  if (!KNOWN_REPOS.includes(repo)) return null;
  return { repo, repoRoot: fsPath, cartographRoot: m[1] };
}

// The repo-relative path of a file inside the current workspace fork.
function repoRelative(ctx: WorkspaceCtx, fsPath: string): string | null {
  if (!fsPath.startsWith(ctx.repoRoot + '/')) return null;
  return fsPath.slice(ctx.repoRoot.length + 1);
}

// ── citation index (#1) ─────────────────────────────────────────────────

interface Citation {
  line: number;
  note: string; // cartograph-relative note path
  kind: string; // bedrock | topic | seam
  context: string;
}
interface CitationsResponse {
  ok: boolean;
  repo: string;
  files: Record<string, Citation[]>;
}

let citationIndex: Record<string, Citation[]> = {};

async function loadCitations(ctx: WorkspaceCtx): Promise<void> {
  try {
    const r = await apiGet<CitationsResponse>(`/api/citations/${ctx.repo}`);
    citationIndex = r.files ?? {};
  } catch {
    citationIndex = {};
  }
}

// Citations matching an editor file: a cited path matches if the editor's
// repo-relative path ends with it (notes cite `jax/_src/x.py` or `_src/x.py`).
function citationsForFile(repoRel: string): Citation[] {
  const out: Citation[] = [];
  for (const [citedPath, cites] of Object.entries(citationIndex)) {
    if (repoRel === citedPath || repoRel.endsWith('/' + citedPath) ||
        citedPath.endsWith('/' + repoRel) || citedPath.endsWith(repoRel)) {
      out.push(...cites);
    }
  }
  return out;
}

// ── decorations: gutter markers on cited lines (#1) ─────────────────────

let citedDecoration: vscode.TextEditorDecorationType;

function applyDecorations(editor: vscode.TextEditor, ctx: WorkspaceCtx): void {
  const repoRel = repoRelative(ctx, editor.document.uri.fsPath);
  if (!repoRel) {
    editor.setDecorations(citedDecoration, []);
    return;
  }
  const cites = citationsForFile(repoRel);
  const byLine = new Map<number, Citation[]>();
  for (const c of cites) {
    if (!byLine.has(c.line)) byLine.set(c.line, []);
    byLine.get(c.line)!.push(c);
  }
  const ranges: vscode.DecorationOptions[] = [];
  for (const [line, cs] of byLine) {
    const idx = line - 1;
    if (idx < 0 || idx >= editor.document.lineCount) continue;
    ranges.push({
      // Cover the whole line — a zero-width range never shows a
      // hoverMessage. The gutter icon still renders once per line.
      range: editor.document.lineAt(idx).range,
      hoverMessage: citationHover(cs),
    });
  }
  editor.setDecorations(citedDecoration, ranges);
}

// Build the hover card shared by the gutter decoration and the
// HoverProvider — includes a clickable command link to open the note,
// since a gutter icon itself can't be clicked in VS Code.
function citationHover(cs: Citation[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportThemeIcons = true;
  md.appendMarkdown('$(book) **Cartograph**\n\n');
  for (const c of cs) {
    const arg = encodeURIComponent(JSON.stringify([c.note]));
    md.appendMarkdown(
      `**${c.kind}** — [\`${c.note}\`](command:cartograph.openNote?${arg} "open this note in the browser")\n\n` +
        `${c.context}\n\n`,
    );
  }
  return md;
}

// ── code lens on cited lines (#1 — the clickable affordance) ────────────
//
// Gutter icons can't be clicked or hovered in VS Code (no API). A CodeLens
// renders a clickable annotation directly above the cited line — that IS
// the interactive layer. The gutter 📖 stays as the passive at-a-glance
// "this line is load-bearing" signal.

const codeLensEmitter = new vscode.EventEmitter<void>();

class CitationCodeLensProvider implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses = codeLensEmitter.event;
  constructor(private ctx: WorkspaceCtx) {}

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const repoRel = repoRelative(this.ctx, doc.uri.fsPath);
    if (!repoRel) return [];
    const byLine = new Map<number, Citation[]>();
    for (const c of citationsForFile(repoRel)) {
      if (!byLine.has(c.line)) byLine.set(c.line, []);
      byLine.get(c.line)!.push(c);
    }
    const lenses: vscode.CodeLens[] = [];
    for (const [line, cs] of byLine) {
      const idx = line - 1;
      if (idx < 0 || idx >= doc.lineCount) continue;
      const range = new vscode.Range(idx, 0, idx, 0);
      const notes = [...new Set(cs.map((c) => c.note))];
      if (notes.length === 1) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(book) ${notes[0].split('/').pop()}`,
            tooltip: cs[0].context,
            command: 'cartograph.openNote',
            arguments: [notes[0]],
          }),
        );
      } else {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(book) ${notes.length} cartograph notes`,
            tooltip: notes.join('\n'),
            command: 'cartograph.pickNote',
            arguments: [notes],
          }),
        );
      }
    }
    return lenses;
  }
}

// ── hover cards (#1) ────────────────────────────────────────────────────

function registerHover(ctx: WorkspaceCtx): vscode.Disposable {
  return vscode.languages.registerHoverProvider(
    { scheme: 'file' },
    {
      provideHover(doc, pos) {
        const repoRel = repoRelative(ctx, doc.uri.fsPath);
        if (!repoRel) return undefined;
        const cites = citationsForFile(repoRel).filter(
          (c) => c.line === pos.line + 1,
        );
        if (cites.length === 0) return undefined;
        return new vscode.Hover(citationHover(cites));
      },
    },
  );
}

// ── status bar / file banner (#1) ───────────────────────────────────────

let statusItem: vscode.StatusBarItem;
// Second status-bar item dedicated to drift count. Cheap to keep
// alongside the per-file `Cartograph: N cites` item — they serve
// different questions ('is this file charted' vs 'is bedrock fresh').
let driftStatusItem: vscode.StatusBarItem;
// Soft diagnostics collection for the Cartograph 'this file may be
// drifting from its cited notes' signal. Severity is Hint so it
// surfaces only in the Problems panel, no inline squiggles.
let driftDiagnostics: vscode.DiagnosticCollection;

interface InsightMatch {
  kind: string;
  file: string;
  snippets: string[];
}
interface InsightsResponse {
  ok: boolean;
  match_count: number;
  matches: InsightMatch[];
}

async function updateBanner(
  editor: vscode.TextEditor | undefined,
  ctx: WorkspaceCtx,
): Promise<void> {
  if (!editor) {
    statusItem.hide();
    return;
  }
  const repoRel = repoRelative(ctx, editor.document.uri.fsPath);
  if (!repoRel) {
    statusItem.hide();
    return;
  }
  const localCites = citationsForFile(repoRel).length;
  statusItem.text = `$(book) Cartograph: ${localCites} cite${localCites === 1 ? '' : 's'}`;
  statusItem.tooltip =
    localCites > 0
      ? `${localCites} cited line(s) in this file — click for the full insight panel`
      : 'no Cartograph citations for this file yet — click to open the panel';
  statusItem.command = 'cartograph.panel.focus';
  statusItem.show();
}

// ── webview panel (B — live insights for the active file) ───────────────

// The "Cartograph" activity-bar view — a CHAT panel. Messages route
// through /api/ask → claude -p, grounded in the repo's bedrock + topic
// notes, with the active editor file passed as context automatically.
// This is the @cartograph experience without VS Code's chat-model gate.
class CartographPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  constructor(private ctx: WorkspaceCtx) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.shell();
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.cmd === 'send') {
        await this.handleSend(String(msg.text ?? ''), msg.id);
      } else if (msg?.cmd === 'ready') {
        this.pushContext(vscode.window.activeTextEditor);
      }
    });
    this.refresh(vscode.window.activeTextEditor);
  }

  // Called on active-editor change — just updates the context line; the
  // chat transcript is preserved (the webview keeps its own DOM + state).
  refresh(editor: vscode.TextEditor | undefined): void {
    this.pushContext(editor);
  }

  private pushContext(editor: vscode.TextEditor | undefined): void {
    if (!this.view) return;
    let file = '';
    let cites = 0;
    if (editor) {
      const rel = repoRelative(this.ctx, editor.document.uri.fsPath);
      if (rel) {
        file = rel;
        cites = citationsForFile(rel).length;
      }
    }
    this.view.webview.postMessage({ cmd: 'context', repo: this.ctx.repo, file, cites });
  }

  private async handleSend(text: string, id: number): Promise<void> {
    if (!this.view) return;
    const prompt = text.trim();
    if (!prompt) return;
    const ed = vscode.window.activeTextEditor;
    const file = ed ? repoRelative(this.ctx, ed.document.uri.fsPath) ?? '' : '';
    try {
      const r = await apiPost<{ ok: boolean; answer?: string; stderr?: string }>(
        '/api/ask',
        { kind: 'explore', repo: this.ctx.repo, context: file, prompt },
      );
      this.view.webview.postMessage({
        cmd: 'answer',
        id,
        ok: r.ok,
        html: r.ok && r.answer
          ? mdToHtml(r.answer)
          : `<p class="err">claude failed: ${escapeHtml(r.stderr ?? 'unknown')}</p>`,
      });
    } catch (e) {
      this.view.webview.postMessage({
        cmd: 'answer',
        id,
        ok: false,
        html: `<p class="err">could not reach the Cartograph server: ${escapeHtml(
          String(e),
        )}</p>`,
      });
    }
  }

  private shell(): string {
    return `<!doctype html><html><head><style>
      html, body { height: 100%; }
      body { font-family: var(--vscode-font-family); font-size: 12px;
        margin: 0; display: flex; flex-direction: column; }
      #ctx { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground); font-size: 11px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #ctx code { color: var(--vscode-textLink-foreground); }
      #msgs { flex: 1; overflow-y: auto; padding: 8px; }
      .msg { margin-bottom: 12px; }
      .msg .who { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em;
        color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
      .msg.user .body { background: var(--vscode-textBlockQuote-background);
        padding: 6px 8px; border-left: 2px solid var(--vscode-textLink-foreground); }
      .msg.bot .body { line-height: 1.5; }
      .msg .body p { margin: 0 0 8px; }
      .msg .body ul { margin: 0 0 8px; padding-left: 18px; }
      .msg .body code { font-family: var(--vscode-editor-font-family);
        font-size: 0.92em; background: var(--vscode-textCodeBlock-background);
        padding: 1px 4px; border-radius: 3px; }
      .msg .body pre.code { font-family: var(--vscode-editor-font-family);
        font-size: 11px; background: var(--vscode-textCodeBlock-background);
        padding: 8px; overflow-x: auto; white-space: pre; }
      .err { color: var(--vscode-errorForeground); }
      .thinking { color: var(--vscode-descriptionForeground); }
      #bar { display: flex; gap: 6px; padding: 8px;
        border-top: 1px solid var(--vscode-panel-border); }
      #q { flex: 1; resize: none; font: inherit; padding: 5px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent); }
      #send { font: inherit; padding: 4px 10px; cursor: pointer; border: none;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground); }
      #send:disabled { opacity: 0.5; cursor: default; }
      #empty { color: var(--vscode-descriptionForeground); padding: 8px;
        line-height: 1.5; }
    </style></head><body>
      <div id="ctx">cartograph</div>
      <div id="msgs"><div id="empty">Ask about this repo — answers are
        grounded in the bedrock + topic notes, and see the file you have
        open. e.g. <em>"where does the typehandler dispatch happen?"</em></div></div>
      <div id="bar">
        <textarea id="q" rows="2" placeholder="ask cartograph…"></textarea>
        <button id="send">ask</button>
      </div>
      <script>
        const vscode = acquireVsCodeApi();
        const msgs = document.getElementById('msgs');
        const q = document.getElementById('q');
        const send = document.getElementById('send');
        const ctx = document.getElementById('ctx');
        let seq = 0;
        // Restore transcript when the view is re-shown.
        const saved = vscode.getState();
        if (saved && saved.html) { msgs.innerHTML = saved.html; scroll(); }
        function persist() { vscode.setState({ html: msgs.innerHTML }); }
        function scroll() { msgs.scrollTop = msgs.scrollHeight; }
        function esc(s) { return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
        function bubble(who, cls, html) {
          const d = document.createElement('div');
          d.className = 'msg ' + cls;
          d.innerHTML = '<div class="who">'+who+'</div><div class="body">'+html+'</div>';
          msgs.appendChild(d); scroll(); return d;
        }
        function submit() {
          const text = q.value.trim();
          if (!text) return;
          const empty = document.getElementById('empty');
          if (empty) empty.remove();
          const id = ++seq;
          bubble('you', 'user', esc(text));
          const bot = bubble('cartograph', 'bot', '<span class="thinking">claude is consulting the knowledge base…</span>');
          bot.dataset.id = id;
          q.value = ''; send.disabled = true;
          vscode.postMessage({ cmd: 'send', text, id });
          persist();
        }
        send.addEventListener('click', submit);
        q.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
        });
        window.addEventListener('message', (e) => {
          const m = e.data;
          if (m.cmd === 'context') {
            ctx.innerHTML = m.file
              ? 'context: <code>'+esc(m.file)+'</code> · '+m.cites+' cited line(s)'
              : 'repo: <code>'+esc(m.repo)+'</code> · no file open';
          } else if (m.cmd === 'answer') {
            const bot = [...msgs.querySelectorAll('.msg.bot')]
              .find(b => b.dataset.id == m.id);
            if (bot) bot.querySelector('.body').innerHTML = m.html;
            send.disabled = false; scroll(); persist();
          }
        });
        vscode.postMessage({ cmd: 'ready' });
      </script>
    </body></html>`;
  }
}

let panel: CartographPanel | undefined;

// ── IDE state sync (C) ──────────────────────────────────────────────────

async function pushIdeState(
  ctx: WorkspaceCtx,
  editor: vscode.TextEditor | undefined,
): Promise<void> {
  if (!editor) return;
  const repoRel = repoRelative(ctx, editor.document.uri.fsPath);
  if (!repoRel) return;
  try {
    await apiPost('/api/ide-state', {
      repo: ctx.repo,
      file: repoRel,
      line: editor.selection.active.line + 1,
    });
  } catch {
    /* non-fatal */
  }
}

// ── walkthrough tour (#2) ───────────────────────────────────────────────

interface WalkStep {
  heading: string;
  prose: string;
  repo: string | null;
  file: string | null;
  line: number | null;
}
interface WalkResponse {
  ok: boolean;
  slug: string;
  steps: WalkStep[];
}

let tour: { slug: string; steps: WalkStep[]; idx: number; panel: vscode.WebviewPanel } | undefined;

async function startTour(ctx: WorkspaceCtx): Promise<void> {
  let slugs: string[] = [];
  try {
    const idx = await apiGet<{ walkthroughs?: { slug: string }[] }>(
      '/api/walkthroughs',
    ).catch(() => null);
    if (idx?.walkthroughs) slugs = idx.walkthroughs.map((w) => w.slug);
  } catch {
    /* fall through */
  }
  let slug: string | undefined;
  if (slugs.length > 0) {
    slug = await vscode.window.showQuickPick(slugs, {
      placeHolder: 'pick a walkthrough to tour',
    });
  } else {
    slug = await vscode.window.showInputBox({
      prompt: 'walkthrough slug (e.g. ecosystem-jax-orbax-tunix-tokamax)',
    });
  }
  if (!slug) return;
  let resp: WalkResponse;
  try {
    resp = await apiGet<WalkResponse>(`/api/walkthrough-steps/${slug}`);
  } catch (e) {
    vscode.window.showErrorMessage(`Cartograph: ${e}`);
    return;
  }
  if (!resp.steps || resp.steps.length === 0) {
    vscode.window.showWarningMessage('Cartograph: that walkthrough has no steppable sections.');
    return;
  }
  const wp = vscode.window.createWebviewPanel(
    'cartograph.tour',
    `tour · ${slug}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  wp.webview.onDidReceiveMessage((m) => {
    if (m?.cmd === 'next') stepTour(ctx, +1);
    else if (m?.cmd === 'prev') stepTour(ctx, -1);
    else if (m?.cmd === 'goto' && typeof m.idx === 'number') {
      if (tour) tour.idx = m.idx - 1;
      stepTour(ctx, +1);
    }
  });
  wp.onDidDispose(() => {
    tour = undefined;
  });
  tour = { slug, steps: resp.steps, idx: -1, panel: wp };
  stepTour(ctx, +1);
}

async function stepTour(ctx: WorkspaceCtx, delta: number): Promise<void> {
  if (!tour) return;
  const next = tour.idx + delta;
  if (next < 0 || next >= tour.steps.length) return;
  tour.idx = next;
  const step = tour.steps[next];

  // Jump the editor to the cited file:line — cross-repo aware.
  if (step.file && step.line != null) {
    const repo = step.repo ?? ctx.repo;
    // The cited path is ALWAYS relative to the repo root. Do NOT strip a
    // leading segment that matches the repo name — these repos have their
    // package dir named the same as the repo (workspace/tunix/tunix/...,
    // workspace/jax/jax/...), so `tunix/rl/grpo/x.py` is the real
    // repo-relative path, not `<repo=tunix>/rl/grpo/x.py`.
    const abs = path.join(ctx.cartographRoot, 'workspace', repo, step.file);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      const ed = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preview: true,
      });
      const ln = Math.max(0, step.line - 1);
      const range = new vscode.Range(ln, 0, ln, 0);
      ed.selection = new vscode.Selection(range.start, range.start);
      ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch {
      /* file may not exist on this machine — keep touring */
    }
  }
  renderTour(ctx);
}

function renderTour(ctx: WorkspaceCtx): void {
  if (!tour) return;
  const step = tour.steps[tour.idx];
  const nav = tour.steps
    .map(
      (s, i) =>
        `<div class="tstep ${i === tour!.idx ? 'on' : ''}" onclick="post('goto',${i})">${
          i + 1
        }. ${escapeHtml(s.heading)}</div>`,
    )
    .join('');
  tour.panel.webview.html = `<!doctype html><html><head><style>
    body { font-family: var(--vscode-font-family); font-size: 13px; padding: 12px; }
    .crumbs { color: var(--vscode-descriptionForeground); font-size: 11px; }
    h2 { margin: 8px 0; }
    .loc { font-family: var(--vscode-editor-font-family); font-size: 11px;
      color: var(--vscode-textLink-foreground); margin-bottom: 10px; }
    .prose p { line-height: 1.55; margin: 0 0 10px; }
    .prose ul { margin: 0 0 10px; padding-left: 20px; line-height: 1.55; }
    .prose code { font-family: var(--vscode-editor-font-family);
      font-size: 0.92em; background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px; border-radius: 3px; }
    .prose pre.code { font-family: var(--vscode-editor-font-family);
      font-size: 12px; line-height: 1.45; background: var(--vscode-textCodeBlock-background);
      padding: 10px; overflow-x: auto; white-space: pre; }
    .ctrl { margin: 14px 0; display: flex; gap: 8px; }
    button { font: inherit; padding: 5px 12px; cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground); border: none; }
    button:disabled { opacity: 0.4; cursor: default; }
    .toc { margin-top: 16px; border-top: 1px solid var(--vscode-panel-border);
      padding-top: 10px; }
    .tstep { padding: 3px 4px; cursor: pointer; font-size: 11px; }
    .tstep.on { background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground); }
    .tstep:hover { background: var(--vscode-list-hoverBackground); }
  </style></head><body>
    <div class="crumbs">walkthrough tour · ${escapeHtml(tour.slug)} · step ${
      tour.idx + 1
    } / ${tour.steps.length}</div>
    <h2>${escapeHtml(step.heading)}</h2>
    ${
      step.file
        ? `<div class="loc">▸ ${escapeHtml(step.repo ?? ctx.repo)} / ${escapeHtml(
            step.file,
          )}:${step.line}</div>`
        : '<div class="loc">(no code anchor for this step)</div>'
    }
    <div class="prose">${mdToHtml(step.prose)}</div>
    <div class="ctrl">
      <button ${tour.idx === 0 ? 'disabled' : ''} onclick="post('prev')">◂ prev</button>
      <button ${
        tour.idx === tour.steps.length - 1 ? 'disabled' : ''
      } onclick="post('next')">next ▸</button>
    </div>
    <div class="toc">${nav}</div>
    <script>
      const vscode = acquireVsCodeApi();
      function post(cmd, idx) { vscode.postMessage({ cmd, idx }); }
    </script>
  </body></html>`;
}

// ── Claude in context (#3) ──────────────────────────────────────────────

async function askClaude(
  ctx: WorkspaceCtx,
  kind: 'explore' | 'explain-code',
  prompt: string,
  contextFile: string,
): Promise<void> {
  const wp = vscode.window.createWebviewPanel(
    'cartograph.ask',
    'Cartograph · Ask Claude',
    vscode.ViewColumn.Beside,
    { enableScripts: true },
  );
  wp.webview.html = askShell('<p class="muted">claude is reading the bedrock + topic notes…</p>');
  try {
    const r = await apiPost<{ ok: boolean; answer?: string; stderr?: string }>(
      '/api/ask',
      { kind, repo: ctx.repo, context: contextFile, prompt },
    );
    wp.webview.html = askShell(
      r.ok && r.answer
        ? `<pre>${escapeHtml(r.answer)}</pre>`
        : `<p class="err">claude failed: ${escapeHtml(r.stderr ?? 'unknown')}</p>`,
    );
  } catch (e) {
    wp.webview.html = askShell(`<p class="err">${escapeHtml(String(e))}</p>`);
  }
}

function askShell(inner: string): string {
  return `<!doctype html><html><head><style>
    body { font-family: var(--vscode-font-family); font-size: 13px; padding: 14px; }
    pre { white-space: pre-wrap; line-height: 1.55; }
    .muted { color: var(--vscode-descriptionForeground); }
    .err { color: var(--vscode-errorForeground); }
  </style></head><body>${inner}</body></html>`;
}

// ── @cartograph chat participant (B) ────────────────────────────────────
//
// Registers `@cartograph` in VS Code's native Agent Chat panel. Every
// message routes through /api/ask → claude -p with the repo's bedrock +
// topic notes loaded first, so answers are grounded in the knowledge
// base. The active file is passed as context automatically.

function registerChat(
  ctx: WorkspaceCtx,
  extensionUri: vscode.Uri,
): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (
    request,
    _chatContext,
    stream,
    token,
  ) => {
    const ed = vscode.window.activeTextEditor;
    const activeFile = ed ? repoRelative(ctx, ed.document.uri.fsPath) ?? '' : '';

    // Slash commands map to the same flows the command palette exposes.
    if (request.command === 'tour') {
      stream.markdown('Starting a walkthrough tour — pick one from the prompt…');
      await vscode.commands.executeCommand('cartograph.startTour');
      return;
    }
    if (request.command === 'seams') {
      stream.markdown('Opening cross-repo seams…');
      await vscode.commands.executeCommand('cartograph.seams');
      return;
    }

    const kind = request.command === 'explain' ? 'explain-code' : 'explore';
    const prompt =
      request.command === 'explain'
        ? `Explain workspace/${ctx.repo}/${activeFile}: what it does, the ` +
          `load-bearing parts, where it sits in the architecture.`
        : request.prompt;

    if (!prompt.trim()) {
      stream.markdown('Ask me something about **' + ctx.repo + '** — e.g. ' +
        '`@cartograph how does the typehandler dispatch work?`');
      return;
    }

    if (activeFile) {
      stream.markdown(`_context: \`${activeFile}\` · reading ${ctx.repo} bedrock + topic notes…_\n\n`);
    } else {
      stream.markdown(`_reading ${ctx.repo} bedrock + topic notes…_\n\n`);
    }
    stream.progress('claude is consulting the knowledge base');

    try {
      const r = await apiPost<{ ok: boolean; answer?: string; stderr?: string }>(
        '/api/ask',
        { kind, repo: ctx.repo, context: activeFile, prompt },
      );
      if (token.isCancellationRequested) return;
      if (r.ok && r.answer) {
        stream.markdown(r.answer);
      } else {
        stream.markdown(
          `⚠ claude failed: ${r.stderr || 'unknown error'}`,
        );
      }
    } catch (e) {
      stream.markdown(`⚠ could not reach the Cartograph server: ${String(e)}`);
    }
  };

  const participant = vscode.chat.createChatParticipant('cartograph.chat', handler);
  participant.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
  return participant;
}

// ── misc ────────────────────────────────────────────────────────────────

function openNoteInBrowser(note: string): void {
  // note is a cartograph-relative path like guides/jax/topics/x.md
  let url = apiBase() + '/';
  let m: RegExpExecArray | null;
  if ((m = /^guides\/([^/]+)\/topics\/(.+)\.md$/.exec(note)))
    url += `repo/${m[1]}/topics/${m[2]}/`;
  else if ((m = /^guides\/([^/]+)\/(overview|architecture|conventions)\.md$/.exec(note)))
    url += `repo/${m[1]}/bedrock/${m[2]}/`;
  else if (/^guides\/seams\.md$/.test(note)) url += 'seams/';
  vscode.env.openExternal(vscode.Uri.parse(url));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

// Lightweight markdown → HTML for the tour + ask panels. Handles the cases
// that actually show up in walkthrough prose / claude answers: fenced code
// blocks, inline `code`, **bold**, bullet lists, and blank-line paragraphs.
// Not a full CommonMark implementation — deliberately small (no bundle dep).
function mdToHtml(md: string): string {
  const parts = md.split('```');
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // Fenced code block — drop an optional leading language tag.
      const code = parts[i].replace(/^[a-zA-Z0-9_+-]*\r?\n/, '');
      html += `<pre class="code">${escapeHtml(code.replace(/\s+$/, ''))}</pre>`;
      continue;
    }
    // Prose — split into blocks on blank lines.
    for (const block of parts[i].split(/\n\s*\n/)) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const lines = trimmed.split('\n');
      const isList = lines.every((l) => /^\s*[-*]\s+/.test(l));
      if (isList) {
        const items = lines
          .map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`)
          .join('');
        html += `<ul>${items}</ul>`;
      } else {
        html += `<p>${inline(trimmed.replace(/\n/g, ' '))}</p>`;
      }
    }
  }
  return html;

  function inline(s: string): string {
    let t = escapeHtml(s);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return t;
  }
}
function escapeAttr(s: string): string {
  return s.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

// ── Phase C: corpus search via /api/find (BM25) ─────────────────────────
//
// Brings the cartograph ⌘K experience into the VS Code command palette.
// QuickPick is the native fit — no webview. Results open the underlying
// markdown file in a side editor.

interface FindResult {
  path: string;
  title?: string;
  score?: number;
  snippet?: string;
}

async function runCartographSearch(ctx: WorkspaceCtx): Promise<void> {
  const query = await vscode.window.showInputBox({
    prompt: 'Search the cartograph corpus (bedrock + topic + episode + research + papers)',
    placeHolder: 'BM25 — e.g. "checkpoint hang" or "pjit lowering"',
  });
  if (!query) return;
  let results: FindResult[] = [];
  try {
    const data = await apiGet<{
      ok?: boolean;
      results?: FindResult[];
      matches?: FindResult[];
      hits?: FindResult[];
    }>(`/api/find?q=${encodeURIComponent(query)}&k=20`);
    // /api/find returns BM25 'hits'; older surfaces use 'results' or
    // 'matches'. Accept all three so the extension keeps working if the
    // server side gets renamed.
    results = (data.hits ?? data.results ?? data.matches ?? []) as FindResult[];
  } catch (e) {
    vscode.window.showErrorMessage(`Cartograph search failed: ${String(e)}`);
    return;
  }
  if (results.length === 0) {
    vscode.window.showInformationMessage(`Cartograph: no matches for "${query}".`);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    results.slice(0, 20).map((r) => ({
      label: r.title || r.path,
      description: r.score !== undefined ? `score ${Number(r.score).toFixed(2)}` : undefined,
      detail: r.snippet || r.path,
      result: r,
    })),
    {
      placeHolder: `${results.length} matches — pick one to open`,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!pick) return;
  const abs = path.join(ctx.cartographRoot, pick.result.path);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    await vscode.window.showTextDocument(doc, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
    });
  } catch (e) {
    vscode.window.showErrorMessage(`Cartograph: couldn't open ${pick.result.path}: ${String(e)}`);
  }
}

// ── Phase E: drift surfacing ────────────────────────────────────────────
//
// Two pieces:
//  1. driftStatusItem polls /api/drift-list and shows `drift: N`. Click
//     opens /console/review/ in the cartograph dashboard.
//  2. driftDiagnostics emits Hint-severity diagnostics on lines that are
//     CITED by a topic whose last_revised is older than the cited file's
//     mtime — i.e. the upstream code moved since the note was last
//     revised. Scoped intentionally: every-file emission would spam, and
//     uncited drift is invisible to cartograph anyway.

interface DriftEntry {
  slug: string;
  path: string;
  repo?: string;
}

let driftListCache: { repo: string; slug: string }[] = [];

async function refreshDriftStatus(): Promise<void> {
  try {
    const data = await apiGet<{ by_repo?: Record<string, DriftEntry[]>; total?: number }>(
      '/api/drift-list',
    );
    const total = data.total ?? Object.values(data.by_repo ?? {}).reduce((acc, v) => acc + (v?.length || 0), 0);
    driftListCache = [];
    for (const [repo, entries] of Object.entries(data.by_repo ?? {})) {
      for (const e of entries ?? []) driftListCache.push({ repo, slug: e.slug });
    }
    if (total > 0) {
      driftStatusItem.text = `$(warning) drift: ${total}`;
      driftStatusItem.tooltip = `${total} topic note(s) drifting from upstream — click to open the review queue`;
      driftStatusItem.command = 'cartograph.openDriftQueue';
      driftStatusItem.show();
    } else {
      driftStatusItem.hide();
    }
  } catch {
    driftStatusItem.hide();
  }
}

// For a given editor, emit Hint diagnostics on each cited line where
// the citing note's last_revised < file mtime (the file has moved
// since the note was written). Coarse but accurate signal.
async function updateDriftDiagnostics(
  editor: vscode.TextEditor | undefined,
  ctx: WorkspaceCtx,
): Promise<void> {
  if (!editor) return;
  const repoRel = repoRelative(ctx, editor.document.uri.fsPath);
  if (!repoRel) {
    driftDiagnostics.delete(editor.document.uri);
    return;
  }
  const cites = citationsForFile(repoRel);
  if (cites.length === 0) {
    driftDiagnostics.delete(editor.document.uri);
    return;
  }
  // File mtime as an upper bound on 'when did this code last move'.
  // Cheap and good-enough — git blame would be more precise but is
  // significantly slower per-edit.
  let fileMtime: number;
  try {
    const stat = await vscode.workspace.fs.stat(editor.document.uri);
    fileMtime = stat.mtime;
  } catch {
    return;
  }
  // For each citation, fetch the note's last_revised once and cache.
  const noteFreshness = new Map<string, number>();
  const diagnostics: vscode.Diagnostic[] = [];
  for (const c of cites) {
    let revised = noteFreshness.get(c.note);
    if (revised === undefined) {
      try {
        const meta = await apiGet<{ ok?: boolean; data?: { last_revised?: string } }>(
          `/api/note?path=${encodeURIComponent(c.note)}`,
        );
        const lr = meta.data?.last_revised;
        revised = lr ? Date.parse(lr) : 0;
      } catch {
        revised = 0;
      }
      noteFreshness.set(c.note, revised);
    }
    if (!revised || revised >= fileMtime) continue;
    const lineIdx = Math.max(0, (c.line || 1) - 1);
    if (lineIdx >= editor.document.lineCount) continue;
    const range = editor.document.lineAt(lineIdx).range;
    const ageDays = Math.floor((fileMtime - revised) / 86400000);
    const d = new vscode.Diagnostic(
      range,
      `cartograph: ${c.note} last_revised ${ageDays}d before this file changed — re-verify the citation`,
      vscode.DiagnosticSeverity.Hint,
    );
    d.source = 'cartograph';
    d.code = 'drift';
    diagnostics.push(d);
  }
  driftDiagnostics.set(editor.document.uri, diagnostics);
}

// ── activate ────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const ctx = workspaceCtx();
  if (!ctx) {
    // Not inside a tracked fork — the extension stays dormant.
    return;
  }

  citedDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'cited.svg'),
    gutterIconSize: 'contain',
    overviewRulerColor: '#1e40af',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  context.subscriptions.push(citedDecoration);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusItem);
  driftStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  context.subscriptions.push(driftStatusItem);
  driftDiagnostics = vscode.languages.createDiagnosticCollection('cartograph-drift');
  context.subscriptions.push(driftDiagnostics);

  panel = new CartographPanel(ctx);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('cartograph.panel', panel),
  );
  context.subscriptions.push(registerHover(ctx));
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      new CitationCodeLensProvider(ctx),
    ),
  );
  // The @cartograph chat participant — best-effort: the Chat API may be
  // absent in stripped-down builds, so the registration is wrapped; if it
  // throws the rest of the extension still works.
  try {
    context.subscriptions.push(registerChat(ctx, context.extensionUri));
  } catch {
    /* Chat API unavailable */
  }

  const onEditor = (editor: vscode.TextEditor | undefined) => {
    if (editor) applyDecorations(editor, ctx);
    updateBanner(editor, ctx);
    panel?.refresh(editor);
    pushIdeState(ctx, editor);
    // Best-effort drift diagnostics — never block the editor change.
    updateDriftDiagnostics(editor, ctx).catch(() => { /* swallow */ });
  };

  // Poll the global drift list every 60s so the status-bar count stays
  // current as drift-fix runs land. Initial fetch on activation.
  refreshDriftStatus();
  const driftPollId = setInterval(() => { refreshDriftStatus(); }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(driftPollId) });
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(onEditor),
    vscode.window.onDidChangeTextEditorSelection((e) => pushIdeState(ctx, e.textEditor)),
  );

  // Commands.
  context.subscriptions.push(
    vscode.commands.registerCommand('cartograph.refresh', async () => {
      await loadCitations(ctx);
      if (vscode.window.activeTextEditor)
        applyDecorations(vscode.window.activeTextEditor, ctx);
      codeLensEmitter.fire();
      vscode.window.showInformationMessage('Cartograph: citation index refreshed.');
    }),
    vscode.commands.registerCommand('cartograph.ask', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const sel = ed.document.getText(ed.selection).trim();
      const repoRel = repoRelative(ctx, ed.document.uri.fsPath) ?? '';
      const q = await vscode.window.showInputBox({
        prompt: sel
          ? 'Ask Claude about the selection (bedrock + topic notes as context)'
          : 'Ask Claude about this file',
        value: sel ? 'Explain this — what does it do and why is it shaped this way?' : '',
      });
      if (!q) return;
      const prompt = sel ? `${q}\n\n--- selected code ---\n${sel}` : q;
      await askClaude(ctx, 'explain-code', prompt, repoRel);
    }),
    vscode.commands.registerCommand('cartograph.explainFile', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const repoRel = repoRelative(ctx, ed.document.uri.fsPath) ?? '';
      await askClaude(
        ctx,
        'explain-code',
        `Explain workspace/${ctx.repo}/${repoRel}: what it does, the load-bearing parts, and where it sits in the architecture.`,
        repoRel,
      );
    }),
    vscode.commands.registerCommand('cartograph.startTour', () => startTour(ctx)),
    vscode.commands.registerCommand('cartograph.tourNext', () => stepTour(ctx, +1)),
    vscode.commands.registerCommand('cartograph.tourPrev', () => stepTour(ctx, -1)),
    vscode.commands.registerCommand('cartograph.seams', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const repoRel = repoRelative(ctx, ed.document.uri.fsPath);
      if (!repoRel) return;
      const seamCites = citationsForFile(repoRel).filter((c) => c.kind === 'seam');
      if (seamCites.length === 0) {
        vscode.window.showInformationMessage(
          'Cartograph: no cross-repo seam touches this file.',
        );
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(apiBase() + '/seams/'));
    }),
    vscode.commands.registerCommand('cartograph.openDashboard', () => {
      vscode.env.openExternal(vscode.Uri.parse(`${apiBase()}/repo/${ctx.repo}/`));
    }),
    // Phase C: BM25 over the whole corpus.
    vscode.commands.registerCommand('cartograph.search', () => runCartographSearch(ctx)),
    // Phase E: opens the unified review queue when the user clicks the
    // 'drift: N' status-bar item or invokes the command directly.
    vscode.commands.registerCommand('cartograph.openDriftQueue', () => {
      vscode.env.openExternal(vscode.Uri.parse(`${apiBase()}/console/review/`));
    }),
    vscode.commands.registerCommand('cartograph.refreshDrift', async () => {
      await refreshDriftStatus();
      if (vscode.window.activeTextEditor) {
        await updateDriftDiagnostics(vscode.window.activeTextEditor, ctx);
      }
    }),
    // Invoked by the CodeLens + hover-card command links. Opens the note's
    // markdown file in the editor — reliable and keeps you in the IDE.
    // `vscode.env.openExternal` is flaky inside code-server, so the
    // browser (rendered page) is only the fallback.
    vscode.commands.registerCommand('cartograph.openNote', async (note: string) => {
      if (typeof note !== 'string') return;
      const abs = path.join(ctx.cartographRoot, note);
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch {
        openNoteInBrowser(note);
      }
    }),
    // Invoked by the CodeLens when a line is cited by multiple notes.
    vscode.commands.registerCommand(
      'cartograph.pickNote',
      async (notes: string[]) => {
        if (!Array.isArray(notes) || notes.length === 0) return;
        const pick = await vscode.window.showQuickPick(notes, {
          placeHolder: 'open which cartograph note?',
        });
        if (pick) {
          await vscode.commands.executeCommand('cartograph.openNote', pick);
        }
      },
    ),
  );

  // Initial load — then refresh the CodeLens so cited lines get their
  // clickable lens once the citation index has arrived.
  loadCitations(ctx).then(() => {
    onEditor(vscode.window.activeTextEditor);
    codeLensEmitter.fire();
  });
}

export function deactivate(): void {
  /* nothing to clean up beyond context.subscriptions */
}
