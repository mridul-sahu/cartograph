// FixWithClaude — fire-and-forget POST to /api/{anchor|drift}-fix,
// then poll /api/job/<kind>/<repo>/<slug> until the script writes a
// terminal status. The endpoints return immediately so heavy jobs
// (drift on a 40-citation topic, 5-10 min) don't block HTTP.

import { useEffect, useRef, useState } from 'react';

type Kind = 'anchor' | 'drift';
interface Props {
  kind: Kind;
  repo: string;
  slug: string;
  compact?: boolean;
}

interface JobStatus {
  status: 'idle' | 'running' | 'done' | 'error';
  action?: 'anchored' | 'no-op' | 'revised' | 'bumped-only';
  files_added?: number;
  sections_changed?: number;
  summary?: string;
  error?: string;
  started_at?: string;
  finished_at?: string;
  elapsed_secs?: number;
  note?: string;
}

const POLL_MS = 3000;

export default function FixWithClaude({ kind, repo, slug, compact }: Props) {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // On mount, see if a prior run already finished — show the last result.
  useEffect(() => {
    fetch(`/api/job/${kind}/${repo}/${slug}`)
      .then((r) => r.ok ? r.json() : null)
      .then((j: JobStatus | null) => {
        if (j && j.status !== 'idle') setStatus(j);
        if (j?.status === 'running') startPolling();
      })
      .catch(() => {});
    return () => { if (timer.current) clearInterval(timer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, repo, slug]);

  const startPolling = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = window.setInterval(async () => {
      try {
        const r = await fetch(`/api/job/${kind}/${repo}/${slug}`);
        if (!r.ok) return;
        const j = (await r.json()) as JobStatus;
        setStatus(j);
        if (j.status !== 'running') {
          if (timer.current) clearInterval(timer.current);
          setBusy(false);
        }
      } catch {}
    }, POLL_MS);
  };

  const launch = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/${kind}-fix`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo, slug }),
      });
      const j = (await r.json()) as JobStatus;
      setStatus(j);
      if (j.status === 'running') startPolling();
      else setBusy(false);
    } catch (e) {
      setStatus({ status: 'error', error: String(e) });
      setBusy(false);
    }
  };

  const label = kind === 'anchor' ? 'Add anchors with Claude' : 'Resolve drift with Claude';
  const labelCompact = kind === 'anchor' ? '+ anchors' : '↻ drift';

  const elapsed = status?.elapsed_secs;
  const isRunning = status?.status === 'running' || busy;
  const isDone = status?.status === 'done';
  const isError = status?.status === 'error';
  const wasNoop = isDone && status?.action === 'no-op';
  const wasFixed = isDone && !wasNoop;

  return (
    <div className={compact ? '' : 'mt-2'}>
      <button
        type="button"
        onClick={launch}
        disabled={isRunning}
        className={compact
          ? "font-mono text-[10px] px-2 py-0.5 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--accent-fg)] disabled:opacity-50"
          : "font-mono text-xs px-3 py-1 bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90 disabled:opacity-50"
        }
      >
        {isRunning
          ? `claude is working… ${elapsed ? `(${elapsed}s)` : ''}`
          : (compact ? labelCompact : `▶ ${label}`)}
      </button>
      {status && status.status !== 'idle' && status.status !== 'running' && (
        <div className={`mt-2 font-mono text-xs ${wasFixed ? 'text-[var(--ok)]' : wasNoop ? 'text-muted' : 'text-[var(--danger)]'}`}>
          {wasFixed && (
            <>
              ✓ {status.action}
              {status.files_added !== undefined && ` · ${status.files_added} anchor${status.files_added === 1 ? '' : 's'} added`}
              {status.sections_changed !== undefined && ` · ${status.sections_changed} section${status.sections_changed === 1 ? '' : 's'} changed`}
              {elapsed !== undefined && ` · ${elapsed}s`}
              {status.summary && <div className="text-muted mt-0.5">{status.summary}</div>}
            </>
          )}
          {wasNoop && (
            <>
              ⊘ no-op{elapsed !== undefined && ` · ${elapsed}s`}
              {status.summary && <div className="text-muted mt-0.5">{status.summary}</div>}
            </>
          )}
          {isError && (
            <>
              ✗ {status.error}
              {elapsed !== undefined && ` (after ${elapsed}s)`}
            </>
          )}
        </div>
      )}
    </div>
  );
}
