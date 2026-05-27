// BackfillButton — UI trigger for `scripts/backfill-bedrock.sh <repo>`.
//
// The backfill runs as a detached background job; this button POSTs to
// start it, then polls `GET /api/backfill/<repo>/status`. On mount it also
// checks status — so a page reload mid-run, or a backfill started from the
// CLI, shows up here as "in progress" rather than silently. The status
// endpoint reads the state file the script owns, so UI and CLI agree.
import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface Props {
  repo: string;
}

type Phase = 'idle' | 'confirming' | 'running' | 'done' | 'error';

interface StatusResp {
  state: 'idle' | 'running' | 'done' | 'error';
  started_at?: string;
  finished_at?: string;
  exit_code?: number | null;
  log_tail?: string;
  note?: string;
}

export default function BackfillButton({ repo }: Props) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<StatusResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  const press = reduced ? {} : { x: 2, y: 2, boxShadow: '0 0 0 0 var(--shadow)' };
  const hover = reduced ? {} : { x: -1, y: -1 };

  const applyStatus = useCallback((s: StatusResp) => {
    if (s.state === 'running') {
      setPhase('running');
    } else if (s.state === 'done') {
      setResult(s);
      setPhase('done');
      // Let the drift badge re-check now that the bedrock sha may have moved.
      window.dispatchEvent(new Event('cartograph:refresh'));
    } else if (s.state === 'error') {
      setResult(s);
      setPhase('error');
      window.dispatchEvent(new Event('cartograph:refresh'));
    }
    // 'idle' → no job; leave the phase alone.
  }, []);

  // On mount: adopt an already-running backfill (reload, or a CLI run).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/backfill/${repo}/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s: StatusResp | null) => {
        if (!cancelled && s && s.state === 'running') applyStatus(s);
      })
      .catch(() => {
        /* status server down — button just stays idle */
      });
    return () => {
      cancelled = true;
    };
  }, [repo, applyStatus]);

  // While running, poll every 4s until the job reports done / error.
  useEffect(() => {
    if (phase !== 'running') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/backfill/${repo}/status`);
        if (!r.ok) return;
        const s: StatusResp = await r.json();
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
      const res = await fetch(`/api/backfill/${repo}`, { method: 'POST' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      // Whether we started it or it was already running, poll from here.
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
          re-backfill {repo} bedrock
        </motion.button>
      )}
      {phase === 'confirming' && (
        <div className="border-2 border-border p-3 shadow-brut-sm bg-muted-bg">
          <div className="font-mono text-xs uppercase tracking-wider mb-2">
            confirm
          </div>
          <p className="text-xs text-fg mb-3">
            Starts <code>claude -p</code> headless with the quality-bar
            contract — rewrites overview / architecture / conventions in
            place. Runs in the background (1–3 min); progress shows here and
            survives a reload. Review via <code>git diff guides/{repo}/</code>{' '}
            before committing.
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
          re-backfilling {repo}… claude is running headless (1–3 min).
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
              backfill done
            </div>
            <div className="text-xs mb-1">
              status:{' '}
              <strong>
                {result.exit_code === 0
                  ? 'ok'
                  : `failed (exit ${result.exit_code})`}
              </strong>
            </div>
            <div className="text-xs text-muted mb-2">
              review <code>git diff guides/{repo}/</code> and commit when
              satisfied.
            </div>
            {result.log_tail && (
              <details>
                <summary className="font-mono text-xs cursor-pointer">
                  log tail
                </summary>
                <pre className="font-mono text-xs whitespace-pre-wrap mt-1 max-h-64 overflow-y-auto">
                  {result.log_tail}
                </pre>
              </details>
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
              className={`mt-3 ${btn} bg-bg text-fg`}
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
              {error ?? result?.log_tail ?? result?.note ?? 'backfill failed'}
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
