// IdeShell — owns the code-server iframe + the Cartograph context pane
// together so per-file clicks in the sidebar can update the iframe's src
// without a full-page navigation.
//
// Layout:
//   left   code-server iframe (real VS Code; takes most of the width)
//   right  Cartograph context: status, key files (click to open in iframe),
//          quick links into the dashboard, Ask Claude pinned at bottom
//
// Each repo has a curated set of "key files" — load-bearing sources that
// the bedrock and topic notes refer back to most often. Clicking one
// re-points the iframe at code-server with a payload that opens the file
// inside the running workbench.
import { useEffect, useMemo, useRef, useState } from 'react';
import AskClaude from './AskClaude';

interface Props {
  repo: string;
  workspacePath: string; // absolute path on disk — baked at build time
  codeServerOrigin: string; // e.g., "http://localhost:47780"
  // Absolute path to setups/<repo>/ide.code-workspace, when the repo has a
  // setup. Opening it (?workspace=) gives a multi-root IDE — the fork AND
  // the setup folder side by side. Null → single-root ?folder=.
  setupWorkspace?: string | null;
}

interface RepoStatus {
  name: string;
  backfilled_from_sha: string | null;
  upstream_sha: string | null;
  topics_count: number;
  walkthroughs_count: number;
  drift_commits: number;
}

interface InsightMatch {
  kind: string;
  file: string;
  snippets: string[];
}

interface InsightsResponse {
  ok: boolean;
  repo: string;
  file: string;
  match_count: number;
  matches: InsightMatch[];
}

interface MostCitedItem {
  path: string;
  score: number;
  citations: number;
  by_layer: Record<string, number>;
}

// Map a cartograph-relative path to its rendered URL so the user can
// click through to the note. Anything we can't map renders as plain text.
function guidesHref(path: string): string | null {
  const topicM = /^guides\/([^/]+)\/topics\/([^/]+)\.md$/.exec(path);
  if (topicM) return `/repo/${topicM[1]}/topics/${topicM[2]}/`;
  const bedrockM = /^guides\/([^/]+)\/(overview|architecture|conventions)\.md$/.exec(path);
  if (bedrockM) return `/repo/${bedrockM[1]}/bedrock/${bedrockM[2]}/`;
  const seamsM = /^guides\/seams\.md$/.exec(path);
  if (seamsM) return '/seams/';
  const walkM = /^learn\/walkthroughs\/([^/]+)\.md$/.exec(path);
  if (walkM) return `/walkthroughs/${walkM[1]}/`;
  const rampM = /^learn\/ramp-up\/([^/]+)\.md$/.exec(path);
  if (rampM) return `/ramp-up/${rampM[1]}/`;
  const epM = /^episodes\/[^/]+\/([^/]+)\.md$/.exec(path);
  if (epM) return `/episodes/${epM[1]}/`;
  return null;
}

function buildCodeServerUrl(
  origin: string,
  workspacePath: string,
  file?: string,
  setupWorkspace?: string | null,
): string {
  // Multi-root (?workspace=) when the repo has a setup — shows the fork
  // and setups/<repo>/ together; else single-root (?folder=) on the fork.
  const base = setupWorkspace
    ? `${origin}/?workspace=${encodeURIComponent(setupWorkspace)}`
    : `${origin}/?folder=${encodeURIComponent(workspacePath)}`;
  if (!file) return base;
  // code-server's payload mechanism: openFile with an absolute path on
  // the workbench host (which is also localhost). Format:
  //   ?folder=<dir>&payload=[["openFile","vscode-remote://<host>:<port><abs>"]]
  // The host part is derived from the code-server origin minus the scheme.
  const hostPort = origin.replace(/^https?:\/\//, '');
  const absPath = `${workspacePath}/${file}`;
  const payload = JSON.stringify([
    ['openFile', `vscode-remote://${hostPort}${absPath}`],
  ]);
  return `${base}&payload=${encodeURIComponent(payload)}`;
}

export default function IdeShell({
  repo,
  workspacePath,
  codeServerOrigin,
  setupWorkspace = null,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [insights, setInsights] = useState<InsightsResponse | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mostCited, setMostCited] = useState<MostCitedItem[] | null>(null);

  // Phase D: live insights via /api/ide-state poll. The cartograph
  // extension (installed in code-server) POSTs the active editor's
  // file + line on every editor change. The sidebar polls every 2s
  // here and threads the result into currentFile, which triggers the
  // existing /api/insights re-fetch downstream. Net effect: clicking
  // any file inside the iframe live-updates the insights pane.
  useEffect(() => {
    let cancelled = false;
    let last = '';
    const tick = async () => {
      try {
        const r = await fetch('/api/ide-state');
        if (!r.ok) return;
        const j = await r.json();
        if (cancelled) return;
        if (j.repo !== repo) return; // ignore other-repo state
        const f = (j.file || '') as string;
        if (!f || f === last) return;
        last = f;
        setCurrentFile(f);
      } catch { /* server down — ignore */ }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [repo]);

  // Phase B: most-cited derived ranking. Replaces the hardcoded
  // STARTER_FILES whitelist that would rot as upstream moves files.
  // Reads /api/repo/<repo>/most-cited which scores by citation count
  // weighted by note layer (bedrock=3, topic=2, episode=1).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/repo/${repo}/most-cited?limit=12`)
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (!cancelled && j?.ok) setMostCited(j.items as MostCitedItem[]); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [repo]);

  const baseUrl = useMemo(
    () => buildCodeServerUrl(codeServerOrigin, workspacePath, undefined, setupWorkspace),
    [codeServerOrigin, workspacePath, setupWorkspace],
  );
  const initialUrl = baseUrl;

  // Drive the embedded code-server's theme from the cartograph light/dark
  // toggle. VS Code watches its own settings.json and applies
  // workbench.colorTheme changes live — so POSTing the theme makes the
  // editor in the iframe flip without a reload. Observes the
  // <html data-theme> attribute the cartograph ThemeToggle mutates.
  useEffect(() => {
    let last = '';
    function sync() {
      const theme = document.documentElement.dataset.theme === 'dark'
        ? 'dark'
        : 'light';
      if (theme === last) return;
      last = theme;
      fetch('/api/code-server-theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme }),
      }).catch(() => {
        /* code-server may not be running — non-fatal */
      });
    }
    sync(); // align on mount
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/status')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const s = d.repos?.[repo] as RepoStatus | undefined;
        if (s) setStatus(s);
      })
      .catch((e) => {
        if (!cancelled) setStatusError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  // Fetch file-level Cartograph insights whenever the user opens a new file.
  useEffect(() => {
    if (!currentFile) {
      setInsights(null);
      return;
    }
    let cancelled = false;
    setInsightsLoading(true);
    fetch(`/api/insights/${repo}?file=${encodeURIComponent(currentFile)}`)
      .then((r) => r.json())
      .then((d: InsightsResponse) => {
        if (!cancelled) {
          setInsights(d);
          setInsightsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setInsightsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repo, currentFile]);

  // Resolve the path against the live working tree before opening — cited
  // / hardcoded paths rot as upstream moves files, and code-server turns a
  // nonexistent path into a blank untitled editor. The resolver returns the
  // real on-disk path (exact match, else basename glob).
  const openFile = async (path: string) => {
    if (!iframeRef.current) return;
    setFileError(null);
    let resolved = path;
    try {
      const r = await fetch(
        `/api/resolve-file/${repo}?path=${encodeURIComponent(path)}`,
      );
      const d = await r.json();
      if (d.ok && d.path) {
        resolved = d.path as string;
      } else {
        setFileError(`not found in ${repo}: ${path}`);
        return;
      }
    } catch {
      /* resolver unreachable — fall back to the raw path */
    }
    const url = buildCodeServerUrl(
      codeServerOrigin,
      workspacePath,
      resolved,
      setupWorkspace,
    );
    iframeRef.current.src = url;
    setCurrentFile(resolved);
  };


  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-3 h-[calc(100vh-112px)] min-h-[560px]">
      <div className="brutal-card p-0 overflow-hidden flex flex-col min-w-0 min-h-0">
        <div className="px-3 py-2 border-b-2 border-border bg-muted-bg flex items-center justify-between gap-3 flex-wrap font-mono text-xs">
          <div className="flex items-baseline gap-3 flex-wrap min-w-0">
            <span className="text-muted uppercase tracking-widest text-[10px]">
              vscode
            </span>
            <code className="text-fg">workspace/{repo}/</code>
            {currentFile && (
              <>
                <span className="text-border">·</span>
                <code className="text-accent truncate max-w-[420px]">
                  {currentFile}
                </code>
              </>
            )}
          </div>
          <div className="flex items-baseline gap-3 flex-wrap shrink-0">
            <a
              href={initialUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted hover:text-accent"
            >
              open in new tab ↗
            </a>
          </div>
        </div>
        <iframe
          ref={iframeRef}
          src={initialUrl}
          title={`code-server: ${repo}`}
          className="flex-1 w-full border-0 bg-bg"
          allow="clipboard-read; clipboard-write"
        />
      </div>

      <aside className="flex flex-col gap-3 overflow-hidden min-h-0">
        <div className="brutal-card p-4 overflow-auto flex-1 min-h-0 space-y-5">
          <section>
            <div className="font-mono text-[11px] uppercase tracking-widest text-muted mb-2">
              cartograph · <code className="text-fg">{repo}</code>
            </div>
            {statusError && (
              <p className="font-mono text-xs text-danger">{statusError}</p>
            )}
            {status && (
              <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1 font-mono text-xs">
                <dt className="text-muted">bedrock</dt>
                <dd>
                  <code className="text-fg">
                    {status.backfilled_from_sha ?? '—'}
                  </code>
                </dd>
                <dt className="text-muted">upstream</dt>
                <dd>
                  <code className="text-fg">{status.upstream_sha ?? '—'}</code>
                </dd>
                <dt className="text-muted">drift</dt>
                <dd
                  className={
                    status.drift_commits > 0 ? 'text-warn' : 'text-ok'
                  }
                >
                  {status.drift_commits === 0
                    ? 'in sync'
                    : `${status.drift_commits} commit(s)`}
                </dd>
                <dt className="text-muted">topics</dt>
                <dd className="text-fg">{status.topics_count}</dd>
                <dt className="text-muted">walkthrough</dt>
                <dd className="text-fg">{status.walkthroughs_count}</dd>
              </dl>
            )}
          </section>

          {currentFile && (
            <section>
              <div className="font-mono text-[11px] uppercase tracking-widest text-muted mb-2">
                this file in cartograph
              </div>
              {insightsLoading && (
                <p className="font-mono text-xs text-muted">searching notes…</p>
              )}
              {!insightsLoading && insights && insights.match_count === 0 && (
                <p className="font-mono text-xs text-muted">
                  no cartograph references for <code>{currentFile}</code>. ask
                  claude below to draft one.
                </p>
              )}
              {!insightsLoading && insights && insights.match_count > 0 && (
                <ul className="space-y-2 font-mono text-[11px]">
                  {insights.matches.slice(0, 10).map((m, i) => {
                    const href = guidesHref(m.file);
                    return (
                      <li
                        key={`${m.file}-${i}`}
                        className="border-l-2 border-border pl-2"
                      >
                        <div className="text-[10px] uppercase tracking-widest text-muted">
                          {m.kind}
                        </div>
                        {href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-fg hover:text-accent break-all"
                          >
                            {m.file}
                          </a>
                        ) : (
                          <span className="text-fg break-all">{m.file}</span>
                        )}
                        {m.snippets.length > 0 && (
                          <ul className="mt-0.5 space-y-0.5 text-muted">
                            {m.snippets.slice(0, 2).map((s, j) => (
                              <li key={j} className="truncate">
                                {s}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {mostCited && mostCited.length > 0 && (
            <section>
              <div className="font-mono text-[11px] uppercase tracking-widest text-muted mb-2 flex items-baseline justify-between">
                <span>most cited</span>
                <span className="text-muted opacity-60 normal-case tracking-normal">
                  derived · bedrock×3 · topic×2 · episode×1
                </span>
              </div>
              <p className="font-mono text-[11px] text-muted mb-2 leading-snug">
                files the {repo} notes lean on. ranked by citation count
                weighted by note layer. updates when new notes land — no
                hand-maintained list to rot.
              </p>
              <ul className="space-y-0.5 font-mono text-xs">
                {mostCited.map((m) => {
                  const layerSummary = Object.entries(m.by_layer)
                    .sort(([, a], [, b]) => b - a)
                    .map(([k, v]) => `${k}×${v}`)
                    .join(' ');
                  const active = currentFile === m.path
                    || (currentFile && currentFile.endsWith('/' + m.path));
                  return (
                    <li key={m.path}>
                      <button
                        type="button"
                        onClick={() => openFile(m.path)}
                        className={`block w-full text-left py-1 px-2 border-2 ${
                          active
                            ? 'border-accent text-accent bg-muted-bg'
                            : 'border-transparent text-muted hover:text-accent hover:border-border'
                        }`}
                        title={`${m.path}\nscore ${m.score} · ${m.citations} citations · ${layerSummary}`}
                      >
                        <div className="flex items-baseline gap-2 min-w-0">
                          <span className="text-fg truncate flex-1 min-w-0 text-left">{m.path}</span>
                          <span className="text-muted text-[10px] whitespace-nowrap">{m.citations}</span>
                        </div>
                        <div className="text-[10px] text-muted opacity-70 truncate text-left">
                          {layerSummary}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {fileError && (
                <p className="font-mono text-[11px] text-red-500 mt-2 break-all">
                  {fileError}
                </p>
              )}
            </section>
          )}

          <section>
            <div className="font-mono text-[11px] uppercase tracking-widest text-muted mb-2">
              bedrock
            </div>
            <ul className="font-mono text-xs space-y-1">
              {['overview', 'architecture', 'conventions'].map((layer) => (
                <li key={layer}>
                  <a
                    href={`/repo/${repo}/bedrock/${layer}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted hover:text-accent"
                  >
                    {layer} ↗
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <div className="font-mono text-[11px] uppercase tracking-widest text-muted mb-2">
              quick links
            </div>
            <ul className="font-mono text-xs space-y-1">
              <li>
                <a
                  href={`/repo/${repo}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted hover:text-accent"
                >
                  repo dashboard ↗
                </a>
              </li>
              <li>
                <a
                  href={`/ramp-up/${repo}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted hover:text-accent"
                >
                  ramp-up ↗
                </a>
              </li>
              <li>
                <a
                  href="/walkthroughs/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted hover:text-accent"
                >
                  walkthroughs ↗
                </a>
              </li>
              <li>
                <a
                  href="/seams/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted hover:text-accent"
                >
                  cross-repo seams ↗
                </a>
              </li>
            </ul>
          </section>
        </div>
        <div className="shrink-0">
          <AskClaude
            kind="explore"
            repo={repo}
            context={currentFile ?? ''}
            title={
              currentFile ? `ask claude about this file` : `ask claude about ${repo}`
            }
            placeholder={
              currentFile
                ? `e.g., "What does this file do?" or "Where is X defined?"`
                : `e.g., "Where does pjit lowering happen?"`
            }
          />
        </div>
      </aside>
    </div>
  );
}
