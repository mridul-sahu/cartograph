// IdeView — standalone three-pane IDE for a fork:
//   left   file tree (lazy-expanded, persistent expansion state)
//   center code viewer (loads inline, no navigation; #L<n> linkable)
//   right  Cartograph insights for the current file (topic notes /
//          walkthroughs / bedrock / episodes that cite this path)
//
// State is in-component. URL sync via ?file=<path>&line=<n>, mutated via
// history.pushState so back/forward work without full reload. The tree
// click handlers do NOT navigate — they update component state.
//
// Search overlay: type into the search box, results render in a floating
// pane; click a match to load that file inline at the right line.
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface Props {
  repo: string;
}

interface TreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
}

interface CodeResponse {
  ok: boolean;
  repo: string;
  path: string;
  size: number;
  lines: number;
  language: string;
  content: string;
}

interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

interface InsightMatch {
  kind: string;
  file: string;
  snippets: string[];
}

export default function IdeView({ repo }: Props) {
  const reduced = useReducedMotion();

  // URL state
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [currentLine, setCurrentLine] = useState<number | null>(null);

  // Read URL on mount and on popstate.
  useEffect(() => {
    function readUrl() {
      const url = new URL(window.location.href);
      setCurrentPath(url.searchParams.get('file'));
      const ln = url.searchParams.get('line');
      setCurrentLine(ln ? parseInt(ln, 10) : null);
    }
    readUrl();
    window.addEventListener('popstate', readUrl);
    return () => window.removeEventListener('popstate', readUrl);
  }, []);

  // Update URL when the user clicks a file in tree or search.
  const navigate = useCallback(
    (path: string, line?: number, replace = false) => {
      const url = new URL(window.location.href);
      url.searchParams.set('file', path);
      if (line) url.searchParams.set('line', String(line));
      else url.searchParams.delete('line');
      const method = replace ? 'replaceState' : 'pushState';
      window.history[method]({}, '', url.toString());
      setCurrentPath(path);
      setCurrentLine(line ?? null);
    },
    [],
  );

  return (
    <div className="ide-shell grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_360px] gap-3 h-[calc(100vh-110px)] min-h-[600px]">
      <aside className="brutal-card p-3 overflow-auto min-h-0">
        <SearchOverlay repo={repo} onPick={navigate} />
        <div className="font-mono text-[11px] uppercase tracking-widest text-muted my-3 px-1">
          tree · <code className="text-fg">workspace/{repo}/</code>
        </div>
        <FileTree repo={repo} currentPath={currentPath} onPick={(p) => navigate(p)} />
      </aside>

      <main className="brutal-card p-0 overflow-hidden flex flex-col min-w-0 min-h-0">
        <CodePane
          repo={repo}
          path={currentPath}
          line={currentLine}
          reduced={!!reduced}
        />
      </main>

      <aside className="flex flex-col gap-3 overflow-hidden min-h-0">
        <div className="brutal-card p-4 overflow-auto flex-1 min-h-0">
          <InsightsPane repo={repo} path={currentPath} onPick={(p) => navigate(p)} />
        </div>
      </aside>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Tree
// ────────────────────────────────────────────────────────────────────────────

function FileTree({
  repo,
  currentPath,
  onPick,
}: {
  repo: string;
  currentPath: string | null;
  onPick: (path: string) => void;
}) {
  const [root, setRoot] = useState<TreeEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tree/${repo}?depth=1`)
      .then((r) => r.json())
      .then((d) => !cancelled && setRoot(d.entries ?? []))
      .catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [repo]);

  if (err)
    return (
      <div className="font-mono text-xs text-danger">tree failed: {err}</div>
    );
  if (!root)
    return <div className="font-mono text-xs text-muted">loading tree…</div>;

  return (
    <ul className="font-mono text-xs leading-snug">
      {root.map((e) => (
        <TreeNode
          key={e.path}
          repo={repo}
          entry={e}
          depth={0}
          currentPath={currentPath}
          onPick={onPick}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  repo,
  entry,
  depth,
  currentPath,
  onPick,
}: {
  repo: string;
  entry: TreeEntry;
  depth: number;
  currentPath: string | null;
  onPick: (path: string) => void;
}) {
  // Auto-open if current path is below this dir.
  const initiallyOpen =
    entry.type === 'dir' &&
    currentPath != null &&
    currentPath.startsWith(`${entry.path}/`);
  const [open, setOpen] = useState(initiallyOpen);
  const [children, setChildren] = useState<TreeEntry[] | null>(null);

  useEffect(() => {
    if (!open || children !== null) return;
    fetch(
      `/api/tree/${repo}?path=${encodeURIComponent(entry.path)}&depth=1`,
    )
      .then((r) => r.json())
      .then((d) => setChildren(d.entries ?? []))
      .catch(() => setChildren([]));
  }, [open, repo, entry.path, children]);

  const indent = `${depth * 12 + 4}px`;

  if (entry.type === 'file') {
    const active = currentPath === entry.path;
    return (
      <li style={{ paddingLeft: indent }}>
        <button
          type="button"
          onClick={() => onPick(entry.path)}
          className={`block w-full text-left py-0.5 truncate no-underline ${
            active ? 'text-accent font-bold' : 'text-muted hover:text-accent'
          }`}
          title={entry.path}
        >
          <span className="opacity-60 mr-1">▢</span>
          {entry.name}
        </button>
      </li>
    );
  }

  return (
    <li style={{ paddingLeft: indent }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="block w-full text-left py-0.5 text-fg hover:text-accent"
      >
        <span className="opacity-70 mr-1">{open ? '▾' : '▸'}</span>
        <strong>{entry.name}</strong>
        <span className="text-muted">/</span>
      </button>
      {open && children && (
        <ul>
          {children.map((c) => (
            <TreeNode
              key={c.path}
              repo={repo}
              entry={c}
              depth={depth + 1}
              currentPath={currentPath}
              onPick={onPick}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Code pane
// ────────────────────────────────────────────────────────────────────────────

function CodePane({
  repo,
  path,
  line,
  reduced,
}: {
  repo: string;
  path: string | null;
  line: number | null;
  reduced: boolean;
}) {
  const [data, setData] = useState<CodeResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!path) {
      setData(null);
      setErr(null);
      return;
    }
    setLoading(true);
    setErr(null);
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    fetch(`/api/code/${encodeURIComponent(repo)}/${encoded}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.detail ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<CodeResponse>;
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e));
        setLoading(false);
      });
  }, [repo, path]);

  // Scroll to the highlighted line when data or line changes.
  useEffect(() => {
    if (!line || !data) return;
    const el = document.getElementById(`ide-L${line}`);
    if (el)
      el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  }, [line, data, reduced]);

  if (!path) {
    return (
      <div className="flex-1 flex items-center justify-center font-mono text-sm text-muted p-8">
        pick a file from the tree, or run a search.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center font-mono text-sm text-muted p-8">
        <span className="inline-block w-2 h-2 bg-accent mr-2 animate-pulse" />
        loading {path}…
      </div>
    );
  }
  if (err || !data) {
    return (
      <div className="flex-1 p-6 font-mono text-sm">
        <div className="text-danger font-bold mb-1">could not load</div>
        <div className="text-muted">{err ?? 'unknown error'}</div>
      </div>
    );
  }

  const lines = data.content.split('\n');

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="px-4 py-2 border-b-2 border-border font-mono text-xs flex items-baseline gap-3 flex-wrap shrink-0">
        <span className="text-muted">{data.repo}/</span>
        <strong className="text-fg break-all">{data.path}</strong>
        <span className="text-muted">·</span>
        <span className="text-muted">{data.lines.toLocaleString()} lines</span>
        <span className="text-muted">·</span>
        <span className="text-muted">{(data.size / 1024).toFixed(1)} KB</span>
        <span className="text-muted">·</span>
        <span className="text-muted">{data.language}</span>
        {line && (
          <>
            <span className="text-muted">·</span>
            <span className="text-accent">L{line}</span>
          </>
        )}
      </header>
      <pre
        className="flex-1 m-0 overflow-auto font-mono text-[13px] leading-snug"
        style={{ tabSize: 4 }}
      >
        <code>
          {lines.map((src, i) => {
            const n = i + 1;
            const isHl = line === n;
            return (
              <div
                key={n}
                id={`ide-L${n}`}
                className="flex"
                style={
                  isHl
                    ? {
                        background:
                          'color-mix(in srgb, var(--accent) 18%, transparent)',
                        borderLeft: '3px solid var(--accent)',
                      }
                    : { borderLeft: '3px solid transparent' }
                }
              >
                <a
                  href={`?file=${encodeURIComponent(data.path)}&line=${n}`}
                  onClick={(e) => {
                    e.preventDefault();
                    const url = new URL(window.location.href);
                    url.searchParams.set('file', data.path);
                    url.searchParams.set('line', String(n));
                    window.history.pushState({}, '', url.toString());
                    window.dispatchEvent(new PopStateEvent('popstate'));
                  }}
                  className="select-none text-right pr-3 pl-3 text-muted no-underline hover:text-accent"
                  style={{
                    minWidth: '3.5rem',
                    borderRight: '1px solid var(--border)',
                  }}
                >
                  {n}
                </a>
                <span className="pl-3 whitespace-pre flex-1">{src || ' '}</span>
              </div>
            );
          })}
        </code>
      </pre>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Search overlay
// ────────────────────────────────────────────────────────────────────────────

function SearchOverlay({
  repo,
  onPick,
}: {
  repo: string;
  onPick: (path: string, line?: number) => void;
}) {
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<SearchMatch[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const query = q.trim();
    if (query.length < 2) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/grep/${repo}?q=${encodeURIComponent(query)}&max_results=50`,
      );
      const data = await res.json();
      setMatches(data.matches ?? []);
    } catch {
      setMatches([]);
    }
    setLoading(false);
  }

  return (
    <div>
      <form onSubmit={submit} className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="grep workspace…"
          className="flex-1 font-mono text-xs border-2 border-border bg-bg px-2 py-1 outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={q.trim().length < 2 || loading}
          className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 border-2 border-border bg-accent text-accent-fg disabled:opacity-40"
        >
          {loading ? '…' : 'go'}
        </button>
      </form>
      {matches && matches.length > 0 && (
        <div className="mt-3 max-h-72 overflow-auto border-2 border-border p-2 font-mono text-[11px] bg-muted-bg">
          <div className="text-muted mb-2">{matches.length} match(es)</div>
          {matches.map((m, i) => (
            <button
              key={`${m.file}:${m.line}:${i}`}
              type="button"
              onClick={() => onPick(m.file, m.line)}
              className="block w-full text-left py-1 px-1 hover:bg-bg hover:text-accent"
            >
              <code className="text-accent">{m.file}</code>
              <code className="text-muted">:{m.line}</code>
              <div className="text-muted truncate pl-2">{m.text}</div>
            </button>
          ))}
        </div>
      )}
      {matches && matches.length === 0 && !loading && (
        <div className="mt-3 font-mono text-[11px] text-muted">no matches.</div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Insights pane
// ────────────────────────────────────────────────────────────────────────────

function InsightsPane({
  repo,
  path,
  onPick: _onPick,
}: {
  repo: string;
  path: string | null;
  onPick: (path: string) => void;
}) {
  const [data, setData] = useState<{ matches: InsightMatch[] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!path) {
      setData(null);
      return;
    }
    setLoading(true);
    fetch(`/api/insights/${repo}?file=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [repo, path]);

  return (
    <div>
      <div className="font-mono text-[11px] uppercase tracking-widest text-muted mb-3">
        cartograph insights
      </div>
      {!path && (
        <p className="font-mono text-xs text-muted">
          pick a file to see which bedrock / topic notes / walkthroughs /
          episodes mention it.
        </p>
      )}
      {path && loading && (
        <p className="font-mono text-xs text-muted">searching…</p>
      )}
      {path && data && data.matches.length === 0 && (
        <p className="font-mono text-xs text-muted">
          no cartograph references for <code>{path}</code> yet.
        </p>
      )}
      {path && data && data.matches.length > 0 && (
        <ul className="space-y-3">
          {data.matches.map((m, i) => (
            <li key={`${m.file}-${i}`} className="border-l-2 border-border pl-3">
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted">
                {m.kind}
              </div>
              <a
                href={`/${m.file.replace(/\.md$/, '/').replace(/^guides\/(.+)\/topics\//, '/repo/$1/topics/').replace(/^guides\/([^/]+)\/(overview|architecture|conventions)$/, '/repo/$1/bedrock/$2/')}`}
                className="block font-mono text-xs hover:text-accent break-all"
                target="_blank"
                rel="noopener noreferrer"
              >
                {m.file}
              </a>
              {m.snippets.length > 0 && (
                <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-muted">
                  {m.snippets.map((s, j) => (
                    <li key={j} className="truncate">
                      {s}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
