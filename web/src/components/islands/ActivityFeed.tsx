import { useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { timeAgo } from '~/lib/time';

interface Commit {
  repo: string;
  sha: string;
  msg: string;
  author: string;
  date_iso: string;
  upstream_owner_repo?: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; commits: Commit[] }
  | { kind: 'error'; message: string };

function commitHref(c: Commit): string | null {
  if (!c.upstream_owner_repo) return null;
  return `https://github.com/${c.upstream_owner_repo}/commit/${c.sha}`;
}

export default function ActivityFeed() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    let cancelled = false;
    async function fetchActivity() {
      try {
        const r = await fetch('/api/activity');
        if (!r.ok) throw new Error(`status ${r.status}`);
        const json = (await r.json()) as { commits: Commit[] };
        if (!cancelled) setState({ kind: 'ready', commits: json.commits.slice(0, 10) });
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', message: String(err) });
      }
    }
    fetchActivity();
    const id = setInterval(fetchActivity, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (state.kind === 'loading') {
    return <div className="font-mono text-sm text-muted">loading upstream activity…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="font-mono text-sm text-danger">
        api/activity unreachable — is <code>scripts/serve.py</code> running on :47777?
      </div>
    );
  }

  return (
    <ul className="divide-y-2 divide-[var(--border-soft)]">
      <AnimatePresence initial={false}>
        {state.commits.map((c, i) => {
          const ghHref = commitHref(c);
          const rowBg = i % 2 === 0 ? 'bg-bg' : 'bg-[var(--surface-1)]';
          return (
            <motion.li
              key={`${c.repo}-${c.sha}`}
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, delay: i * 0.02, ease: [0.4, 0, 0.2, 1] }}
              className={`grid grid-cols-[5rem_5rem_1fr_auto] items-center gap-3 px-3 py-1.5 font-mono text-xs hover:bg-[var(--surface-2)] ${rowBg}`}
            >
              <a href={`/repo/${c.repo}/`} className="text-accent uppercase no-underline hover:underline">
                {c.repo}
              </a>
              {ghHref ? (
                <a
                  href={ghHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted hover:text-fg no-underline"
                  title={`Open ${c.sha} on GitHub`}
                >
                  {c.sha}
                </a>
              ) : (
                <code className="text-muted">{c.sha}</code>
              )}
              <span className="truncate text-fg" title={c.msg}>
                {c.msg}
              </span>
              <span className="text-muted whitespace-nowrap">
                {c.author.split(/\s+/)[0]} · {timeAgo(c.date_iso)}
              </span>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
