// CheckDriftButton — invoke scripts/drift-check.sh for a repo via the UI.
//
// Fast (< 5s) since drift-check just diffs git refs and writes a report
// file if needed. No confirm step required.
import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface Props {
  repo: string;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

export default function CheckDriftButton({ repo }: Props) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>('idle');
  const [driftPresent, setDriftPresent] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const press = reduced ? {} : { x: 2, y: 2, boxShadow: '0 0 0 0 var(--shadow)' };
  const hover = reduced ? {} : { x: -1, y: -1 };

  async function run() {
    setPhase('running');
    setError(null);
    try {
      const res = await fetch(`/api/drift-check/${repo}`, { method: 'POST' });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`HTTP ${res.status}: ${t}`);
      }
      const data = await res.json();
      const present = !!data.drift_present?.[repo];
      setDriftPresent(present);
      setPhase('done');
      // Reload the /status view to re-fetch the drift summary if we're on it.
      // Otherwise just show the inline result.
      setTimeout(() => setPhase('idle'), 4500);
    } catch (err) {
      setError(String(err));
      setPhase('error');
    }
  }

  return (
    <div className="inline-block">
      <motion.button
        type="button"
        onClick={run}
        whileHover={phase === 'running' ? {} : hover}
        whileTap={phase === 'running' ? {} : press}
        transition={{ duration: 0.1, ease: [0.4, 0, 0.2, 1] }}
        disabled={phase === 'running'}
        className="font-mono text-xs uppercase tracking-wider px-3 py-1.5 border-2 border-border bg-bg text-fg shadow-brut-sm disabled:opacity-60"
      >
        {phase === 'running' ? 'checking drift…' : `check drift · ${repo}`}
      </motion.button>
      <AnimatePresence>
        {phase === 'done' && (
          <motion.span
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            className="ml-3 font-mono text-xs"
            style={{
              color: driftPresent ? 'var(--warn)' : 'var(--ok)',
            }}
          >
            {driftPresent ? '↑ drift report written' : '✓ no drift'}
          </motion.span>
        )}
        {phase === 'error' && error && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="ml-3 font-mono text-xs text-danger"
          >
            error: {error}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
