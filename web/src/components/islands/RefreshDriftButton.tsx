// RefreshDriftButton — UI trigger for `scripts/repo-refresh.sh <repo>`:
// pull upstream, re-detect drift, run the deterministic drain over the open
// reports (git + python, no tokens). POSTs to /api/repo-refresh/<repo>,
// then polls GET /api/job/refresh/<repo>/all for status. On mount
// it adopts an already-running refresh (page reload, session-start kick, or
// a CLI run) so the in-progress state is never invisible.
import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface Props {
  repo: string;
}

type Phase = 'idle' | 'confirming' | 'running' | 'done' | 'error';

interface JobStatus {
  status: 'idle' | 'running' | 'done' | 'deferred' | 'error';
  sync?: string;
  reports_before?: number;
  reports_after?: number;
  elapsed_secs?: number;
  error?: string;
  note?: string;
}

export default function RefreshDriftButton({ repo }: Props) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const press = reduced ? {} : { x: 2, y: 2, boxShadow: '0 0 0 0 var(--shadow)' };
  const hover = reduced ? {} : { x: -1, y: -1 };

  const applyStatus = useCallback((s: JobStatus) => {
    if (s.status === 'running') {
      setPhase('running');
    } else if (s.status === 'done' || s.status === 'deferred') {
      setResult(s);
      setPhase('done');
      // Bedrock sha / report set may have moved — let badges re-check.
      window.dispatchEvent(new Event('cartograph:refresh'));
    } else if (s.status === 'error') {
      setResult(s);
      setPhase('error');
      window.dispatchEvent(new Event('cartograph:refresh'));
    }
    // 'idle' → no job on record; leave the phase alone.
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/job/refresh/${repo}/all`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s: JobStatus | null) => {
        if (!cancelled && s && s.status === 'running') applyStatus(s);
      })
      .catch(() => {
        /* status server down — button stays idle */
      });
    return () => {
      cancelled = true;
    };
  }, [repo, applyStatus]);

  useEffect(() => {
    if (phase !== 'running') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/job/refresh/${repo}/all`);
        if (!r.ok) return;
        const s: JobStatus = await r.json();
        if (!cancelled) applyStatus(s);
      } catch {
        /* transient — keep polling */
      }
    };
    const id = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase, repo, applyStatus]);

  async function run() {
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/repo-refresh/${repo}`, { method: 'POST' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      setPhase('running');
    } catch (err) {
      setError(String(err));
      setPhase('error');
    }
  }

  const btn =
    'font-mono text-xs uppercase tracking-wider px-3 py-1.5 border-2 border-border shadow-brut-sm';

  return (
    <div className="text-sm">
      {phase === 'idle' && (
        <motion.button
          type="button"
          onClick={() => setPhase('confirming')}
          whileHover={hover}
          whileTap={press}
          transition={{ duration: 0.1, ease: [0.4, 0, 0.2, 1] }}
          className={`${btn} bg-bg text-fg`}
        >
          pull + fix drift
        </motion.button>
      )}
      {phase === 'confirming' && (
        <div className="border-2 border-border p-3 shadow-brut-sm bg-muted-bg">
          <div className="font-mono text-xs uppercase tracking-wider mb-2">
            confirm
          </div>
          <p className="text-xs text-fg mb-3">
            Pulls upstream into <code>workspace/{repo}</code>, re-detects
            drift, and mechanically re-anchors line-shift citations (git +
            python, no tokens). Reports that survive need judgment and are
            handed to your next working session. Runs in the background and
            survives a reload.
          </p>
          <div className="flex gap-2">
            <motion.button
              type="button"
              onClick={run}
              whileHover={hover}
              whileTap={press}
              transition={{ duration: 0.1 }}
              className={`${btn} bg-accent text-accent-fg`}
            >
              run it
            </motion.button>
            <motion.button
              type="button"
              onClick={() => setPhase('idle')}
              whileHover={hover}
              whileTap={press}
              transition={{ duration: 0.1 }}
              className={`${btn} bg-bg text-fg`}
            >
              cancel
            </motion.button>
          </div>
        </div>
      )}
      {phase === 'running' && (
        <div className="border-2 border-accent p-3 shadow-brut-sm bg-muted-bg font-mono text-xs">
          <span className="inline-block w-2 h-2 bg-accent mr-2 animate-pulse" />
          pulling + re-anchoring {repo}… git + python only; a minute or two.
        </div>
      )}
      <AnimatePresence>
        {phase === 'done' && result && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="border-2 border-border p-3 shadow-brut-sm bg-muted-bg"
          >
            <div className="font-mono text-xs uppercase tracking-wider mb-2">
              {result.status === 'deferred' ? 'refresh deferred' : 'refresh done'}
            </div>
            <div className="text-xs mb-1">
              reports: <strong>{result.reports_before ?? '?'}</strong> open →{' '}
              <strong>{result.reports_after ?? '?'}</strong> remaining
              {typeof result.elapsed_secs === 'number' && (
                <span className="text-muted"> · {result.elapsed_secs}s</span>
              )}
            </div>
            {result.status === 'deferred' && (
              <div className="text-xs text-muted mb-2">
                headless cap was busy — remaining reports retry on the next
                pass, or press the button again.
              </div>
            )}
            {result.sync && result.sync !== 'ok' && (
              <div className="text-xs text-[var(--warn)] mb-2">{result.sync}</div>
            )}
            <motion.button
              type="button"
              onClick={() => {
                setPhase('idle');
                setResult(null);
              }}
              whileHover={hover}
              whileTap={press}
              transition={{ duration: 0.1 }}
              className={`mt-2 ${btn} bg-bg text-fg`}
            >
              dismiss
            </motion.button>
          </motion.div>
        )}
        {phase === 'error' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="border-2 border-danger p-3 shadow-brut-sm bg-muted-bg"
          >
            <div className="font-mono text-xs uppercase tracking-wider mb-2 text-danger">
              error
            </div>
            <pre className="font-mono text-xs whitespace-pre-wrap max-h-64 overflow-y-auto">
              {error ?? result?.error ?? result?.note ?? 'refresh failed'}
            </pre>
            <motion.button
              type="button"
              onClick={() => {
                setPhase('idle');
                setError(null);
                setResult(null);
              }}
              whileHover={hover}
              whileTap={press}
              transition={{ duration: 0.1 }}
              className={`mt-3 ${btn} bg-bg text-fg`}
            >
              dismiss
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
