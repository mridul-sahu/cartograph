// CommandPalette — global Cmd-K search + commands overlay.
//
// Two result streams:
//   • search hits — wired to /api/find (BM25) over the notes corpus
//   • commands — static list of navigation + chassis actions
//
// Keyboard:
//   Cmd-K / Ctrl-K — toggle open
//   Esc — close
//   ↑ / ↓ — move selection
//   Enter — activate
//   / — focus the input
//
// Per claude-designs/cartograph/ui-audit-2026-05-25/ L1.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Hit {
  path: string;
  title: string;
  layer: string | null;
  repo: string | null;
  score: number;
}

interface Command {
  id: string;
  label: string;
  hint: string;
  group: 'navigate' | 'action';
  run: () => void;
}

function pathToHref(path: string): string {
  let m;
  if ((m = path.match(/^guides\/([^/]+)\/topics\/(.+)\.md$/))) return `/repo/${m[1]}/topics/${m[2]}/`;
  if ((m = path.match(/^guides\/([^/]+)\/(overview|architecture|conventions)\.md$/))) return `/repo/${m[1]}/bedrock/${m[2]}/`;
  if ((m = path.match(/^episodes\/\d{4}-\d{2}\/(.+)\.md$/))) return `/episodes/${m[1]}/`;
  if ((m = path.match(/^research\/([^/]+)\/(.+)\.md$/))) return `/research/${m[1]}/${m[2]}/`;
  if ((m = path.match(/^papers\/([^/]+)\/([^/]+)\/notes\.md$/))) return `/papers/${m[1]}/${m[2]}/`;
  if ((m = path.match(/^learn\/walkthroughs\/(.+)\.md$/))) return `/walkthroughs/${m[1]}/`;
  if ((m = path.match(/^learn\/drafts\/(.+)\.md$/))) return `/drafts/${m[1]}/`;
  if ((m = path.match(/^learn\/ramp-up\/(.+)\.md$/))) return `/ramp-up/${m[1]}/`;
  if ((m = path.match(/^designs\/([^/]+)\/([^/]+)\/.+$/))) return `/designs/${m[1]}/${m[2]}/`;
  return '#';
}

const STATIC_COMMANDS: Command[] = [
  { id: 'nav-home', group: 'navigate', label: 'Home', hint: '/', run: () => { location.href = '/'; } },
  { id: 'nav-prs', group: 'navigate', label: 'PRs', hint: '/prs/', run: () => { location.href = '/prs/'; } },
  { id: 'nav-repos', group: 'navigate', label: 'Repos', hint: '/repo/', run: () => { location.href = '/repo/'; } },
  { id: 'nav-episodes', group: 'navigate', label: 'Episodes', hint: '/episodes/', run: () => { location.href = '/episodes/'; } },
  { id: 'nav-library', group: 'navigate', label: 'Library', hint: '/library/', run: () => { location.href = '/library/'; } },
  { id: 'nav-seams', group: 'navigate', label: 'Seams', hint: '/seams/', run: () => { location.href = '/seams/'; } },
  { id: 'nav-console', group: 'navigate', label: 'Console', hint: '/console/', run: () => { location.href = '/console/'; } },
  ...['jax', 'xla', 'orbax', 'tunix', 'tokamax'].flatMap((r) => [
    { id: `nav-repo-${r}`, group: 'navigate' as const, label: `Repo: ${r}`, hint: `/repo/${r}/`, run: () => { location.href = `/repo/${r}/`; } },
    { id: `nav-stack-${r}`, group: 'navigate' as const, label: `Stack: ${r}`, hint: `/repo/${r}/stack/`, run: () => { location.href = `/repo/${r}/stack/`; } },
  ]),
  { id: 'act-rebuild', group: 'action', label: 'Trigger rebuild', hint: 'POST /api/rebuild', run: async () => {
    await fetch('/api/rebuild', { method: 'POST' });
    location.reload();
  } },
];

function fuzzyMatch(text: string, query: string): boolean {
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return true;
  let ti = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return false;
    ti = idx + 1;
  }
  return true;
}

const RECENTS_KEY = 'cartograph.recent-queries';
const RECENTS_CAP = 10;

function loadRecents(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch { return []; }
}

function pushRecent(q: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = q.trim();
  if (!trimmed) return;
  const prev = loadRecents().filter((s) => s !== trimmed);
  const next = [trimmed, ...prev].slice(0, RECENTS_CAP);
  try { window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch {}
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Global Cmd-K / Ctrl-K hotkey
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      setActive(0);
      setRecents(loadRecents());
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Record successful queries (debounced — push once results came back).
  useEffect(() => {
    if (!query.trim() || hits.length === 0) return;
    const t = setTimeout(() => pushRecent(query), 800);
    return () => clearTimeout(t);
  }, [query, hits]);

  // Keep the active item visible inside the scrollable list when arrow nav
  // pushes it past the viewport edge. `block: 'nearest'` only scrolls when
  // the row is actually outside the visible area — no jitter on each press.
  useLayoutEffect(() => {
    if (!open || !listRef.current) return;
    const row = listRef.current.children[active] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  // BM25 search on query change (debounced)
  useEffect(() => {
    if (!open || !query.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      fetch(`/api/find?q=${encodeURIComponent(query)}&k=10`)
        .then((r) => r.ok ? r.json() : Promise.reject(`${r.status}`))
        .then((j) => { if (!cancelled) { setHits(j.hits ?? []); setLoading(false); } })
        .catch(() => { if (!cancelled) setLoading(false); });
    }, 120);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, query]);

  const filteredCommands = STATIC_COMMANDS.filter((c) => fuzzyMatch(`${c.label} ${c.hint}`, query));
  const items: Array<{ kind: 'hit'; hit: Hit } | { kind: 'cmd'; cmd: Command }> = [
    ...filteredCommands.map((c) => ({ kind: 'cmd' as const, cmd: c })),
    ...hits.map((h) => ({ kind: 'hit' as const, hit: h })),
  ];

  const onKeyDownInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[active];
      if (!item) return;
      if (item.kind === 'cmd') item.cmd.run();
      else location.href = pathToHref(item.hit.path);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="font-mono text-[10px] border-2 border-border px-2 py-1 hover:bg-[var(--surface-1)] uppercase tracking-widest text-muted"
        title="Open command palette (⌘K)"
      >
        ⌘K search
      </button>
    );
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setOpen(false)} />
      <div className="fixed top-20 left-1/2 -translate-x-1/2 w-[640px] max-w-[92vw] z-50 brutal-card bg-bg">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDownInput}
          placeholder="Search notes (BM25) or navigate…"
          className="w-full px-4 py-3 font-mono text-sm border-b-2 border-border bg-bg focus:outline-none"
        />
        <div className="max-h-[60vh] overflow-y-auto">
          {!query.trim() && recents.length > 0 && (
            <div className="border-b border-[var(--border-soft)]">
              <div className="px-4 pt-2 pb-1 font-mono text-[10px] uppercase tracking-widest text-muted">recent</div>
              <ul>
                {recents.slice(0, 8).map((r) => (
                  <li
                    key={r}
                    className="px-4 py-1.5 text-xs font-mono cursor-pointer hover:bg-[var(--surface-1)] text-muted"
                    onClick={() => setQuery(r)}
                    onMouseEnter={(e) => (e.currentTarget as HTMLElement).classList.add('text-fg')}
                    onMouseLeave={(e) => (e.currentTarget as HTMLElement).classList.remove('text-fg')}
                  >
                    <span className="text-[var(--accent)] mr-2">↺</span>{r}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {items.length === 0 ? (
            <p className="p-4 text-sm text-muted">{loading ? 'searching…' : 'no matches'}</p>
          ) : (
            <ul ref={listRef}>
              {items.map((item, i) => {
                const isActive = i === active;
                const rowCls = `px-4 py-2 flex items-baseline gap-3 cursor-pointer ${isActive ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'hover:bg-[var(--surface-1)]'}`;
                if (item.kind === 'cmd') {
                  return (
                    <li key={item.cmd.id} className={rowCls} onMouseEnter={() => setActive(i)} onClick={() => item.cmd.run()}>
                      <span className="font-mono text-[10px] uppercase tracking-widest opacity-60 w-16">{item.cmd.group}</span>
                      <span className="flex-1 text-sm">{item.cmd.label}</span>
                      <span className="font-mono text-[10px] opacity-60">{item.cmd.hint}</span>
                    </li>
                  );
                }
                const h = item.hit;
                return (
                  <li
                    key={h.path}
                    className={rowCls}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => { location.href = pathToHref(h.path); }}
                  >
                    <span className="font-mono text-[10px] uppercase tracking-widest opacity-60 w-16">{h.layer ?? '?'}</span>
                    <span className="flex-1 min-w-0">
                      <span className="text-sm block truncate">{h.title || h.path}</span>
                      <span className="font-mono text-[10px] opacity-60 truncate block">{h.path}</span>
                    </span>
                    <span className="font-mono text-[10px] opacity-60">{h.score.toFixed(1)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="border-t-2 border-border px-4 py-2 font-mono text-[10px] text-muted flex items-center justify-between">
          <span>↑↓ navigate · ↵ open · esc close</span>
          <span>⌘K</span>
        </div>
      </div>
    </>
  );
}
