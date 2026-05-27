// PullRequests — list open PRs authored by `[your-github-user]` against each upstream.
//
// Fetches /api/prs/<repo> for each tracked repo. Compact brutalist table per
// repo showing PR number, title, state (open/draft/merged/closed), branch.
// Each row links to the GitHub PR page in a new tab.
//
// This is read-only — no PR creation yet (the user creates PRs via
// `cgh pr create` from the terminal so the token-check hook fires).
import { useEffect, useState } from 'react';

interface PR {
  number: number;
  title: string;
  state: string; // OPEN | CLOSED | MERGED
  isDraft: boolean;
  url: string;
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
}

interface RepoPRs {
  ok: boolean;
  upstream?: string;
  prs: PR[];
  count?: number;
  error?: string;
}

const REPOS = ['jax', 'xla', 'orbax', 'tunix', 'tokamax'];

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; byRepo: Record<string, RepoPRs> }
  | { kind: 'error'; message: string };

export default function PullRequests() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const results = await Promise.all(
          REPOS.map(async (r) => {
            const res = await fetch(`/api/prs/${r}`);
            const data = (await res.json()) as RepoPRs;
            return [r, data] as const;
          }),
        );
        if (!cancelled) {
          setState({
            kind: 'ready',
            byRepo: Object.fromEntries(results),
          });
        }
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', message: String(err) });
      }
    }
    load();
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="font-mono text-sm text-muted">loading PRs…</div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="brutal-card p-5 font-mono text-sm">
        <div className="text-danger font-bold">PR fetch failed</div>
        <div className="text-muted">{state.message}</div>
      </div>
    );
  }

  const totalPRs = Object.values(state.byRepo).reduce(
    (acc, r) => acc + (r.prs?.length ?? 0),
    0,
  );

  return (
    <section>
      <div className="font-mono text-[11px] uppercase tracking-widest mb-3 text-muted">
        upstream PRs from <code className="text-fg">[your-github-user]</code>
        {' · '}
        <span>{totalPRs} total</span>
      </div>
      <div className="space-y-5">
        {REPOS.map((repo) => {
          const data = state.byRepo[repo];
          return (
            <div key={repo} className="brutal-card p-5">
              <header className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
                <div className="font-mono text-lg font-bold tracking-tightish">
                  {repo}
                </div>
                <div className="font-mono text-xs text-muted">
                  {data.upstream ? <>→ <code>{data.upstream}</code></> : null}
                  {' · '}
                  {data.error ? (
                    <span className="text-danger">err</span>
                  ) : (
                    <>{data.prs.length} PR{data.prs.length === 1 ? '' : 's'}</>
                  )}
                </div>
              </header>
              {data.error && (
                <div className="font-mono text-xs text-muted mb-2">
                  {data.error}
                </div>
              )}
              {data.prs.length === 0 && !data.error && (
                <div className="font-mono text-xs text-muted">
                  no PRs from [your-github-user] yet
                </div>
              )}
              {data.prs.length > 0 && (
                <table className="w-full font-mono text-xs">
                  <thead>
                    <tr className="text-muted text-left uppercase tracking-widest text-[10px]">
                      <th className="pb-2 pr-3">#</th>
                      <th className="pb-2 pr-3">title</th>
                      <th className="pb-2 pr-3">state</th>
                      <th className="pb-2 pr-3">branch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.prs.map((pr) => (
                      <tr key={pr.number} className="border-t border-border">
                        <td className="py-1.5 pr-3 text-muted">{pr.number}</td>
                        <td className="py-1.5 pr-3">
                          <a
                            href={pr.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-accent"
                          >
                            {pr.title}
                          </a>
                        </td>
                        <td className="py-1.5 pr-3">
                          <StateChip state={pr.state} isDraft={pr.isDraft} />
                        </td>
                        <td className="py-1.5 pr-3 truncate">
                          <code className="text-muted">{pr.headRefName}</code>
                          {' → '}
                          <code className="text-muted">{pr.baseRefName}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StateChip({ state, isDraft }: { state: string; isDraft: boolean }) {
  const label = isDraft ? 'draft' : state.toLowerCase();
  let bg = 'transparent';
  let color = 'var(--fg)';
  if (label === 'open') {
    bg = 'color-mix(in srgb, var(--ok) 18%, transparent)';
    color = 'var(--ok)';
  } else if (label === 'merged') {
    bg = 'color-mix(in srgb, var(--accent) 18%, transparent)';
    color = 'var(--accent)';
  } else if (label === 'closed') {
    bg = 'color-mix(in srgb, var(--danger) 14%, transparent)';
    color = 'var(--danger)';
  } else if (label === 'draft') {
    bg = 'color-mix(in srgb, var(--warn) 14%, transparent)';
    color = 'var(--warn)';
  }
  return (
    <span
      className="inline-block px-2 py-0.5 border border-border font-mono text-[10px] uppercase tracking-widest"
      style={{ background: bg, color }}
    >
      {label}
    </span>
  );
}
