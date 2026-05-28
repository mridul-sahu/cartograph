// PRDashboard — per-repo PR sections, fetched in parallel.
//
// Previously this island called the aggregate /api/prs once, which
// internally fans out to per-repo /api/prs/<r> calls but blocks the
// response until ALL of them finish. Tail latency on the slowest repo
// (or a single failing one) gated the whole page. Now we fire one
// fetch per repo from the client in parallel — sections render as
// soon as their repo's data lands.

import { useEffect, useState } from 'react';

interface PR {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  mergeable?: string;
  reviewDecision?: string;
  repo?: string;
}

type Filter = 'open' | 'merged' | 'closed' | 'all';
type RepoState =
  | { phase: 'loading' }
  | { phase: 'done'; prs: PR[] }
  | { phase: 'error'; error: string };

function chip(pr: PR) {
  if (pr.state === 'MERGED') return { label: 'merged', cls: 'bg-[var(--ok)] text-bg' };
  if (pr.state === 'CLOSED') return { label: 'closed', cls: 'bg-[var(--danger)] text-bg' };
  if (pr.isDraft) return { label: 'draft', cls: 'bg-[var(--surface-1)] text-fg border border-border' };
  if (pr.reviewDecision === 'APPROVED') return { label: 'approved', cls: 'bg-[var(--ok)] text-bg' };
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { label: 'changes', cls: 'bg-[var(--warn)] text-bg' };
  return { label: 'open', cls: 'bg-[var(--accent)] text-[var(--accent-fg)]' };
}

function mergeChip(m?: string) {
  if (!m || m === 'UNKNOWN') return null;
  if (m === 'CONFLICTING') return { label: 'conflict', cls: 'text-[var(--danger)]' };
  if (m === 'MERGEABLE') return { label: 'mergeable', cls: 'text-[var(--ok)]' };
  return { label: m.toLowerCase(), cls: 'text-muted' };
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function passesFilter(pr: PR, f: Filter): boolean {
  if (f === 'all') return true;
  return pr.state === f.toUpperCase();
}

function PRRow({ pr, idx }: { pr: PR; idx: number }) {
  const c = chip(pr);
  const mc = mergeChip(pr.mergeable);
  return (
    <li className={idx % 2 === 0 ? 'bg-bg' : 'bg-[var(--surface-1)]'}>
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block px-3 py-3 hover:bg-[var(--surface-2)] no-underline text-fg"
      >
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className={`font-mono text-[10px] px-1.5 py-0.5 ${c.cls} whitespace-nowrap`}>{c.label}</span>
          <span className="font-mono text-xs text-muted">#{pr.number}</span>
          <span className="text-fg flex-1 min-w-0 truncate">{pr.title}</span>
          {mc && <span className={`font-mono text-[10px] ${mc.cls} whitespace-nowrap`}>{mc.label}</span>}
          <span className="font-mono text-[10px] text-muted whitespace-nowrap">{timeAgo(pr.updatedAt)}</span>
        </div>
        <div className="mt-1 font-mono text-[10px] text-muted truncate">
          {pr.headRefName} → {pr.baseRefName}
        </div>
      </a>
    </li>
  );
}

export default function PRDashboard() {
  // Repos list comes from a separate one-shot fetch so we don't hardcode
  // the list in two places (server REPOS tuple is the source of truth).
  const [repos, setRepos] = useState<string[] | null>(null);
  const [byRepo, setByRepo] = useState<Record<string, RepoState>>({});
  const [filter, setFilter] = useState<Filter>('open');

  // Mount: get the repo list, then fan out one fetch per repo in parallel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let list: string[] = [];
      try {
        const r = await fetch('/api/repos');
        if (r.ok) list = ((await r.json()) as { repos: string[] }).repos ?? [];
      } catch { /* fall through */ }
      if (list.length === 0) {
        // Fallback if /api/repos isn't available: scrape from the aggregate.
        try {
          const r = await fetch('/api/prs');
          if (r.ok) {
            const j = (await r.json()) as { prs: PR[] };
            list = [...new Set((j.prs || []).map((p) => p.repo).filter(Boolean) as string[])];
          }
        } catch { /* */ }
      }
      if (cancelled) return;
      setRepos(list);
      setByRepo(Object.fromEntries(list.map((r) => [r, { phase: 'loading' as const }])));

      // Parallel fan-out — each repo's section renders as soon as its
      // request lands, instead of waiting on the slowest one.
      for (const repo of list) {
        fetch(`/api/prs/${repo}`)
          .then(async (r) => {
            if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
            const j = (await r.json()) as { ok?: boolean; prs: PR[]; error?: string };
            if (cancelled) return;
            // The endpoint returns HTTP 200 with {ok:false, error} when the
            // underlying `gh` call fails (e.g. can't reach api.github.com).
            // Without this check that surfaces as an empty "No PRs" section.
            if (j.ok === false) {
              const error = (j.error || 'unknown error').replace(/\s+/g, ' ').trim();
              setByRepo((prev) => ({ ...prev, [repo]: { phase: 'error', error } }));
              return;
            }
            const prs = (j.prs || []).map((p) => ({ ...p, repo }));
            setByRepo((prev) => ({ ...prev, [repo]: { phase: 'done', prs } }));
          })
          .catch((e) => {
            if (cancelled) return;
            setByRepo((prev) => ({ ...prev, [repo]: { phase: 'error', error: String(e) } }));
          });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!repos) return <p className="text-sm text-muted p-4">loading repo list…</p>;
  if (repos.length === 0) return <p className="text-sm text-muted p-4">no tracked repos.</p>;

  // Aggregate counts across all repos that have finished loading.
  const allKnownPrs = Object.values(byRepo).flatMap((s) => s.phase === 'done' ? s.prs : []);
  const counts = {
    open: allKnownPrs.filter((p) => p.state === 'OPEN').length,
    merged: allKnownPrs.filter((p) => p.state === 'MERGED').length,
    closed: allKnownPrs.filter((p) => p.state === 'CLOSED').length,
    all: allKnownPrs.length,
  };
  const loadingCount = Object.values(byRepo).filter((s) => s.phase === 'loading').length;
  const errored = repos.filter((r) => byRepo[r]?.phase === 'error');

  return (
    <div>
      {errored.length > 0 && (
        <div className="px-3 py-2 border-b-2 border-border bg-[var(--surface-1)] border-l-4 border-l-[var(--danger)]">
          <span className="font-mono text-xs text-[var(--danger)] font-bold uppercase tracking-widest">
            github fetch failed
          </span>
          <span className="ml-2 font-mono text-xs text-muted">
            {errored.length} of {repos.length} repo{errored.length === 1 ? '' : 's'} couldn't load — see the per-repo errors below.
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b-2 border-border bg-[var(--surface-1)] font-mono text-xs">
        <span className="text-muted uppercase tracking-widest mr-1">filter</span>
        {(['open', 'merged', 'closed', 'all'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`px-2 py-0.5 ${filter === f ? 'bg-accent text-[var(--accent-fg)]' : 'text-muted hover:text-fg border border-border'}`}
          >
            {f} <span className="opacity-60">{counts[f]}</span>
          </button>
        ))}
        {loadingCount > 0 && (
          <span className="text-muted">{loadingCount} repo{loadingCount === 1 ? '' : 's'} still loading…</span>
        )}
        <span className="ml-auto text-muted">author <span className="text-fg">[your-github-user]</span></span>
      </div>

      <div className="divide-y-2 divide-border">
        {repos.map((repo) => {
          const state = byRepo[repo] || { phase: 'loading' as const };
          const prs = state.phase === 'done' ? state.prs.filter((p) => passesFilter(p, filter)) : [];
          const total = state.phase === 'done' ? state.prs.length : null;
          return (
            <section key={repo}>
              <header className="px-3 py-2 bg-[var(--surface-1)] flex items-baseline gap-3 font-mono text-xs">
                <a href={`/repo/${repo}/`} className="font-bold text-accent hover:underline">{repo}</a>
                {state.phase === 'loading' && <span className="text-muted">loading…</span>}
                {state.phase === 'error' && <span className="text-[var(--danger)]">error: {state.error}</span>}
                {state.phase === 'done' && (
                  <span className="text-muted">
                    {prs.length} {filter}
                    {total !== null && total !== prs.length && <> · {total} total</>}
                  </span>
                )}
              </header>
              {state.phase === 'done' && prs.length === 0 && (
                <p className="px-3 py-2 text-xs text-muted">No PRs in this filter.</p>
              )}
              {state.phase === 'done' && prs.length > 0 && (
                <ul className="divide-y divide-[var(--border-soft)]">
                  {prs.map((pr, i) => <PRRow key={pr.number} pr={pr} idx={i} />)}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
