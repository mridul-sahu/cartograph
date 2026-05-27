import { useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { driftLevel, driftLabel, driftChipClass } from '~/lib/drift';
import { timeAgo } from '~/lib/time';

interface RepoStatus {
  name: string;
  tracked_branch: string;
  upstream_sha: string | null;
  backfilled_from_sha: string | null;
  drift_commits: number;
  drift_files: number;
  last_fetch_at: string | null;
  topics_count: number;
  walkthroughs_count: number;
}

interface StatusPayload {
  repos: Record<string, RepoStatus>;
  doctor: { status: 'OK' | 'FAIL'; problems: string[]; warnings: string[] };
  stats: {
    topics_total: number;
    walkthroughs_total: number;
    ramp_ups_total: number;
    drafts_total: number;
    episodes_total: number;
  };
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: StatusPayload }
  | { kind: 'error'; message: string };

export default function StatusPane({ variant = 'grid' }: { variant?: 'grid' | 'stats' | 'compact' }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    let cancelled = false;
    async function fetchStatus() {
      try {
        const r = await fetch('/api/status');
        if (!r.ok) throw new Error(`status ${r.status}`);
        const json = (await r.json()) as StatusPayload;
        if (!cancelled) setState({ kind: 'ready', data: json });
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', message: String(err) });
      }
    }
    fetchStatus();
    const id = setInterval(fetchStatus, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (state.kind === 'loading') {
    return <div className="font-mono text-sm text-muted">loading status…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="brutal-card p-4 font-mono text-sm">
        <div className="text-danger font-bold">/api/status unreachable</div>
        <div className="text-muted mt-1">
          start the status server: <code>python scripts/serve.py</code>
        </div>
      </div>
    );
  }

  const { data } = state;
  const repos = Object.values(data.repos).sort((a, b) => a.name.localeCompare(b.name));

  if (variant === 'stats') {
    return <StatsRow stats={data.stats} doctor={data.doctor} />;
  }

  // Compact variant — used inside narrow cards (e.g. Home's right column).
  // Renders one row per repo with the key facts inline, no fixed grid.
  if (variant === 'compact') {
    return (
      <div className="divide-y-2 divide-[var(--border-soft)]">
        {repos.map((repo, i) => {
          const level = driftLevel(repo.drift_commits);
          const rowBg = i % 2 === 0 ? 'bg-bg' : 'bg-[var(--surface-1)]';
          return (
            <a
              key={repo.name}
              href={`/repo/${repo.name}/`}
              className={`flex items-center gap-3 px-3 py-2.5 no-underline text-fg hover:bg-[var(--surface-2)] ${rowBg}`}
            >
              <span className="font-mono font-bold text-lg w-20 truncate">{repo.name}</span>
              <span className={`chip ${driftChipClass(level)} flex-shrink-0`}>
                {driftLabel(level)} · {repo.drift_commits}
              </span>
              <span className="flex-1 font-mono text-xs text-muted truncate text-right">
                {repo.topics_count} topics · {repo.walkthroughs_count} walks · {timeAgo(repo.last_fetch_at)}
              </span>
            </a>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
      <AnimatePresence initial={false}>
        {repos.map((repo, i) => (
          <motion.a
            key={repo.name}
            href={`/repo/${repo.name}/`}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, delay: i * 0.05, ease: [0.4, 0, 0.2, 1] }}
            whileHover={reducedMotion ? undefined : { x: -3, y: -3, boxShadow: '9px 9px 0 0 var(--shadow)' }}
            className="brutal-card p-5 block no-underline text-fg"
          >
            <RepoCardBody repo={repo} />
          </motion.a>
        ))}
      </AnimatePresence>
    </div>
  );
}

function RepoCardBody({ repo }: { repo: RepoStatus }) {
  const level = driftLevel(repo.drift_commits);
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-2xl font-bold tracking-tightish">{repo.name}</h3>
        <span className={`chip ${driftChipClass(level)}`}>
          {driftLabel(level)} · {repo.drift_commits}
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-xs">
        <dt className="text-muted">upstream</dt>
        <dd className="text-right truncate">{repo.upstream_sha ?? '—'}</dd>
        <dt className="text-muted">backfilled</dt>
        <dd className="text-right truncate">{repo.backfilled_from_sha ?? '—'}</dd>
        <dt className="text-muted">last fetch</dt>
        <dd className="text-right">{timeAgo(repo.last_fetch_at)}</dd>
        <dt className="text-muted">topics</dt>
        <dd className="text-right">{repo.topics_count}</dd>
        <dt className="text-muted">walkthroughs</dt>
        <dd className="text-right">{repo.walkthroughs_count}</dd>
      </dl>
    </>
  );
}

function StatsRow({
  stats,
  doctor,
}: {
  stats: StatusPayload['stats'];
  doctor: StatusPayload['doctor'];
}) {
  const items = [
    { label: 'topics', value: stats.topics_total },
    { label: 'walkthroughs', value: stats.walkthroughs_total },
    { label: 'ramp-ups', value: stats.ramp_ups_total },
    { label: 'drafts', value: stats.drafts_total },
    { label: 'episodes', value: stats.episodes_total },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-6">
      {items.map((s) => (
        <div key={s.label} className="brutal-card p-3 text-center">
          <div className="font-mono text-3xl font-bold tracking-tightish">{s.value}</div>
          <div className="font-mono text-xs text-muted uppercase">{s.label}</div>
        </div>
      ))}
      <div className={`brutal-card p-3 text-center ${doctor.status === 'OK' ? '' : 'border-danger'}`}>
        <div
          className={`font-mono text-3xl font-bold ${doctor.status === 'OK' ? 'text-ok' : 'text-danger'}`}
        >
          {doctor.status}
        </div>
        <div className="font-mono text-xs text-muted uppercase">doctor</div>
      </div>
    </div>
  );
}
