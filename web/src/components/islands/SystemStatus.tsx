// Full-system status pane.
//
// Fetches `/api/status` and `/api/activity` once on mount and refreshes every
// 60s. Renders four aggregate gauges, then one detailed card per repo with
// SHA chips, last-fetch time, a filtered terminal-style commit list, and a
// lazy "Drift report" expander that pulls `/api/drift/{repo}` on demand.
//
// Markdown for the drift report is rendered server-side at expand time via a
// tiny inline parser — we deliberately do NOT pull the full Code Hike chain
// into a client bundle. Drift reports are short, monospaced, and structural.
import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { driftLevel, driftLabel, driftChipClass } from '~/lib/drift';
import { timeAgo } from '~/lib/time';
import AutoReviseButton from './AutoReviseButton';

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

interface Commit {
  repo: string;
  sha: string;
  msg: string;
  author: string;
  date_iso: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; status: StatusPayload; commits: Commit[] }
  | { kind: 'error'; message: string };

export default function SystemStatus() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const [s, a] = await Promise.all([
          fetch('/api/status').then((r) => {
            if (!r.ok) throw new Error(`/api/status -> ${r.status}`);
            return r.json() as Promise<StatusPayload>;
          }),
          fetch('/api/activity').then((r) => {
            if (!r.ok) throw new Error(`/api/activity -> ${r.status}`);
            return r.json() as Promise<{ commits: Commit[] }>;
          }),
        ]);
        if (!cancelled) setState({ kind: 'ready', status: s, commits: a.commits });
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', message: String(err) });
      }
    }
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (state.kind === 'loading') {
    return <div className="font-mono text-sm text-muted">loading system status…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="brutal-card p-5 font-mono text-sm">
        <div className="text-danger font-bold">/api/status unreachable</div>
        <div className="text-muted mt-1">
          start the server: <code>python scripts/serve.py</code>
        </div>
        <div className="text-muted mt-1 text-xs">{state.message}</div>
      </div>
    );
  }

  return <ReadyView status={state.status} commits={state.commits} />;
}

function ReadyView({
  status,
  commits,
}: {
  status: StatusPayload;
  commits: Commit[];
}) {
  const repos = Object.values(status.repos).sort((a, b) => a.name.localeCompare(b.name));
  const total = repos.length;
  const fresh = repos.filter((r) => r.drift_commits === 0).length;
  const freshPct = total === 0 ? 0 : Math.round((fresh / total) * 100);

  const driftedRepos = repos.filter((r) => r.drift_commits > 0);

  return (
    <div className="space-y-12">
      <GaugesRow
        freshPct={freshPct}
        freshCount={fresh}
        totalRepos={total}
        topicsTotal={status.stats.topics_total}
        walkthroughsTotal={status.stats.walkthroughs_total}
        episodesTotal={status.stats.episodes_total}
      />

      {driftedRepos.length > 0 && (
        <div className="brutal-card p-5 flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-widest mb-1 text-muted">
              open drift
            </div>
            <div className="font-mono text-sm">
              {driftedRepos.length} repo{driftedRepos.length === 1 ? '' : 's'}{' '}
              behind upstream:{' '}
              {driftedRepos.map((r, i) => (
                <span key={r.name}>
                  <code className="text-fg">{r.name}</code>
                  {i < driftedRepos.length - 1 ? ', ' : ''}
                </span>
              ))}
            </div>
          </div>
          <AutoReviseButton all />
        </div>
      )}

      <div className="space-y-6">
        {repos.map((repo) => (
          <RepoStatusCard
            key={repo.name}
            repo={repo}
            commits={commits.filter((c) => c.repo === repo.name).slice(0, 10)}
          />
        ))}
      </div>

      <DoctorPanel doctor={status.doctor} />
    </div>
  );
}

function GaugesRow({
  freshPct,
  freshCount,
  totalRepos,
  topicsTotal,
  walkthroughsTotal,
  episodesTotal,
}: {
  freshPct: number;
  freshCount: number;
  totalRepos: number;
  topicsTotal: number;
  walkthroughsTotal: number;
  episodesTotal: number;
}) {
  const items = [
    {
      label: 'bedrock fresh',
      value: `${freshPct}%`,
      sub: `${freshCount} / ${totalRepos} repos`,
      accent: true,
    },
    { label: 'topic notes', value: topicsTotal, sub: 'across all repos' },
    { label: 'walkthroughs', value: walkthroughsTotal, sub: 'narrative deep dives' },
    { label: 'episodes', value: episodesTotal, sub: 'session worknotes' },
  ];
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      {items.map((it) => (
        <div
          key={it.label}
          className="brutal-card p-5"
          style={
            it.accent
              ? { background: 'var(--accent)', color: 'var(--accent-fg)' }
              : undefined
          }
        >
          <div
            className="font-mono text-[11px] uppercase tracking-widest mb-2"
            style={it.accent ? { color: 'var(--accent-fg)', opacity: 0.85 } : undefined}
          >
            {it.label}
          </div>
          <div className="font-mono text-5xl font-bold tracking-tightish leading-none mb-2">
            {it.value}
          </div>
          <div
            className="font-mono text-xs"
            style={it.accent ? { color: 'var(--accent-fg)', opacity: 0.85 } : { color: 'var(--muted)' }}
          >
            {it.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

function RepoStatusCard({ repo, commits }: { repo: RepoStatus; commits: Commit[] }) {
  const level = driftLevel(repo.drift_commits);
  const [driftOpen, setDriftOpen] = useState(false);
  const hasDrift = repo.drift_commits > 0;

  return (
    <article className="brutal-card p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-4 mb-5">
        <a
          href={`/repo/${repo.name}/`}
          className="font-mono text-4xl md:text-5xl font-bold tracking-tightish no-underline text-fg hover:text-accent"
        >
          {repo.name}
        </a>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`chip ${driftChipClass(level)}`}>
            {driftLabel(level)}
            {repo.drift_commits > 0 ? ` · ${repo.drift_commits}` : ''}
          </span>
          {repo.last_fetch_at && (
            <span className="font-mono text-xs text-muted">
              fetched {timeAgo(repo.last_fetch_at)}
            </span>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5 font-mono text-xs">
        <ShaPanel label="bedrock @" sha={repo.backfilled_from_sha} />
        <ShaPanel label="upstream @" sha={repo.upstream_sha} />
        <DeltaPanel commits={repo.drift_commits} />
        <CountsPanel topics={repo.topics_count} walkthroughs={repo.walkthroughs_count} />
      </div>

      <CommitList repo={repo.name} commits={commits} />

      {hasDrift && (
        <>
          <DriftExpander
            repo={repo.name}
            open={driftOpen}
            onToggle={() => setDriftOpen((v) => !v)}
          />
          <AutoReviseButton repo={repo.name} />
        </>
      )}
    </article>
  );
}

function ShaPanel({ label, sha }: { label: string; sha: string | null }) {
  return (
    <div className="flex items-center gap-2 p-2.5 border-2 border-border bg-muted-bg">
      <span className="text-muted uppercase tracking-widest text-[10px]">{label}</span>
      <code className="text-fg">{sha ?? '—'}</code>
    </div>
  );
}

function DeltaPanel({ commits }: { commits: number }) {
  if (commits === 0) {
    return (
      <div
        className="flex items-center gap-2 p-2.5 border-2 border-border"
        style={{ background: 'color-mix(in srgb, var(--ok) 14%, var(--bg))' }}
      >
        <span style={{ color: 'var(--ok)' }} className="text-base font-bold leading-none">✓</span>
        <span style={{ color: 'var(--ok)' }} className="font-bold">
          at upstream — bedrock fresh
        </span>
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-2 p-2.5 border-2 border-border"
      style={{ background: 'color-mix(in srgb, var(--warn) 14%, var(--bg))' }}
    >
      <span style={{ color: 'var(--warn)' }} className="text-base font-bold leading-none">↯</span>
      <span style={{ color: 'var(--warn)' }} className="font-bold">
        {commits} commit{commits === 1 ? '' : 's'} behind
      </span>
    </div>
  );
}

function CountsPanel({ topics, walkthroughs }: { topics: number; walkthroughs: number }) {
  return (
    <div className="flex items-center justify-between p-2.5 border-2 border-border bg-muted-bg">
      <span>
        <span className="text-muted uppercase tracking-widest text-[10px] mr-1">topics</span>
        <span className="text-fg font-bold">{topics}</span>
      </span>
      <span>
        <span className="text-muted uppercase tracking-widest text-[10px] mr-1">walks</span>
        <span className="text-fg font-bold">{walkthroughs}</span>
      </span>
    </div>
  );
}

function CommitList({ repo, commits }: { repo: string; commits: Commit[] }) {
  if (commits.length === 0) {
    return (
      <div className="font-mono text-xs text-muted p-3 border-2 border-dashed" style={{ borderColor: 'var(--border)' }}>
        no recent upstream commits surfaced for <span className="text-fg">{repo}</span>.
      </div>
    );
  }
  return (
    <div
      className="border-2 border-border overflow-hidden"
      style={{ background: 'var(--muted-bg)' }}
    >
      <div className="px-3 py-1.5 border-b-2 border-border font-mono text-[10px] uppercase tracking-widest text-muted flex items-center justify-between">
        <span>last {commits.length} commit{commits.length === 1 ? '' : 's'} · upstream/{repo}</span>
        <span>terminal</span>
      </div>
      <ul className="font-mono text-xs">
        {commits.map((c) => (
          <li
            key={`${c.repo}-${c.sha}`}
            className="grid grid-cols-[5rem_1fr_auto] items-center gap-3 px-3 py-1.5 border-t border-border/40 first:border-t-0"
          >
            <code className="text-accent">{c.sha}</code>
            <span className="truncate" title={c.msg}>{c.msg}</span>
            <span className="text-muted whitespace-nowrap">
              {c.author.split(' ')[0]} · {timeAgo(c.date_iso)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DriftExpander({
  repo,
  open,
  onToggle,
}: {
  repo: string;
  open: boolean;
  onToggle: () => void;
}) {
  const reduced = useReducedMotion();
  const [content, setContent] = useState<
    { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; html: string } | { kind: 'error'; msg: string }
  >({ kind: 'idle' });

  useEffect(() => {
    if (!open || content.kind !== 'idle') return;
    setContent({ kind: 'loading' });
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/drift/${repo}`);
        if (!r.ok) throw new Error(`drift -> ${r.status}`);
        const md = await r.text();
        if (!cancelled) setContent({ kind: 'ready', html: lightMarkdown(md) });
      } catch (err) {
        if (!cancelled) setContent({ kind: 'error', msg: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, content.kind, repo]);

  return (
    <div className="mt-5 border-t-2 border-border pt-4">
      <button
        type="button"
        onClick={onToggle}
        className="brutal-button font-mono text-xs"
        aria-expanded={open}
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        <span>drift report · {repo}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-4 p-5 border-2 border-border" style={{ background: 'var(--muted-bg)' }}>
              {content.kind === 'loading' && (
                <div className="font-mono text-xs text-muted">loading drift report…</div>
              )}
              {content.kind === 'error' && (
                <div className="font-mono text-xs text-danger">{content.msg}</div>
              )}
              {content.kind === 'ready' && (
                <div
                  className="prose-cartograph"
                  style={{ maxWidth: 'none' }}
                  dangerouslySetInnerHTML={{ __html: content.html }}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DoctorPanel({ doctor }: { doctor: StatusPayload['doctor'] }) {
  const ok = doctor.status === 'OK';
  return (
    <section>
      <h2 className="font-mono text-xs uppercase tracking-widest text-muted mb-3">
        doctor
      </h2>
      <div
        className="brutal-card p-5"
        style={ok ? undefined : { borderColor: 'var(--danger)' }}
      >
        <div className="flex items-baseline justify-between gap-4 mb-3">
          <span
            className="font-mono text-2xl font-bold"
            style={{ color: ok ? 'var(--ok)' : 'var(--danger)' }}
          >
            {doctor.status}
          </span>
          <span className="font-mono text-xs text-muted">
            {doctor.problems.length} problem{doctor.problems.length === 1 ? '' : 's'}
            {' · '}
            {doctor.warnings.length} warning{doctor.warnings.length === 1 ? '' : 's'}
          </span>
        </div>
        {(doctor.problems.length > 0 || doctor.warnings.length > 0) ? (
          <ul className="font-mono text-xs space-y-1.5">
            {doctor.problems.map((p) => (
              <li key={p} className="flex items-start gap-2">
                <span style={{ color: 'var(--danger)' }} aria-hidden>✗</span>
                <span>{p}</span>
              </li>
            ))}
            {doctor.warnings.map((w) => (
              <li key={w} className="flex items-start gap-2">
                <span style={{ color: 'var(--warn)' }} aria-hidden>!</span>
                <span className="text-muted">{w}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="font-mono text-xs text-muted">no problems or warnings.</div>
        )}
      </div>
    </section>
  );
}

// Tiny brutalist markdown -> HTML renderer for drift reports. Drift reports
// are short, predictable (header / bullet lists / code spans) — pulling in
// `marked` + Code Hike on the client for this would be vastly overkill.
function lightMarkdown(md: string): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const inline = (s: string) =>
    s
      // backtick spans
      .replace(/`([^`]+)`/g, (_, c: string) => `<code>${esc(c)}</code>`)
      // bold
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // italic
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
      // simple link
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const raw of lines) {
    if (raw.startsWith('```')) {
      if (!inCode) {
        closeList();
        out.push('<pre><code>');
      } else {
        out.push('</code></pre>');
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(raw));
      continue;
    }
    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const depth = heading[1].length;
      out.push(`<h${depth}>${inline(esc(heading[2]))}</h${depth}>`);
      continue;
    }
    const bullet = raw.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(esc(bullet[1]))}</li>`);
      continue;
    }
    if (!raw.trim()) {
      closeList();
      out.push('');
      continue;
    }
    closeList();
    out.push(`<p>${inline(esc(raw))}</p>`);
  }
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}
