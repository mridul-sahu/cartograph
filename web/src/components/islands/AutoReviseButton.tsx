// AutoReviseButton — trigger headless auto-revise on a drifted repo from the UI.
//
// Two variants:
//   <AutoReviseButton repo="jax" />   per-repo button next to the drift expander
//   <AutoReviseButton all />          "auto-revise all drifted" button at top of /status
//
// POSTs to /api/auto-revise/<repo> (or /all). The endpoint runs scripts/auto-revise.sh
// which invokes `claude -p` headless against the open drift report. The server
// blocks until claude completes (up to 5 min) — we show a spinner + the tail
// of the log when it returns. User reviews via `git diff` before committing.
import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

type Props =
  | { repo: string; all?: false }
  | { all: true; repo?: never };

type Phase = 'idle' | 'confirming' | 'running' | 'done' | 'error';

interface RepoResult {
  ok: boolean;
  status?: 'closed' | 'still_open' | 'no_drift';
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  note?: string;
  message?: string;
}

interface AllResult {
  ok: boolean;
  summary?: string;
  message?: string;
  results?: Record<string, RepoResult>;
}

type Result = RepoResult | AllResult;

export default function AutoReviseButton(props: Props) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const label = props.all ? 'auto-revise all drift' : `auto-revise ${props.repo}`;
  const endpoint = props.all
    ? '/api/auto-revise/all'
    : `/api/auto-revise/${props.repo}`;

  async function run() {
    setPhase('running');
    setError(null);
    setResult(null);
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const data: Result = await res.json();
      setResult(data);
      setPhase('done');
    } catch (err) {
      setError(String(err));
      setPhase('error');
    }
  }

  const press = reduced ? {} : { x: 2, y: 2, boxShadow: '0 0 0 0 var(--shadow)' };
  const hover = reduced ? {} : { x: -1, y: -1 };

  return (
    <div className="mt-3 text-sm">
      {phase === 'idle' && (
        <motion.button
          type="button"
          onClick={() => setPhase('confirming')}
          whileHover={hover}
          whileTap={press}
          transition={{ duration: 0.1, ease: [0.4, 0, 0.2, 1] }}
          className="font-mono text-xs uppercase tracking-wider px-3 py-1.5 border-2 border-border bg-bg text-fg shadow-brut-sm"
        >
          {label}
        </motion.button>
      )}
      {phase === 'confirming' && (
        <div className="border-2 border-border p-3 shadow-brut-sm bg-muted-bg">
          <div className="font-mono text-xs uppercase tracking-wider mb-2">
            confirm
          </div>
          <p className="text-xs text-fg mb-3">
            This invokes <code>claude -p</code> headless against the drift
            report{props.all ? 's' : ''}. It may take 30–90s and consumes Claude
            API usage. The script edits bedrock files in place; you review via{' '}
            <code>git diff</code> before committing.
          </p>
          <div className="flex gap-2">
            <motion.button
              type="button"
              onClick={run}
              whileHover={hover}
              whileTap={press}
              transition={{ duration: 0.1 }}
              className="font-mono text-xs uppercase tracking-wider px-3 py-1.5 border-2 border-border bg-accent text-accent-fg shadow-brut-sm"
            >
              run it
            </motion.button>
            <motion.button
              type="button"
              onClick={() => setPhase('idle')}
              whileHover={hover}
              whileTap={press}
              transition={{ duration: 0.1 }}
              className="font-mono text-xs uppercase tracking-wider px-3 py-1.5 border-2 border-border bg-bg text-fg shadow-brut-sm"
            >
              cancel
            </motion.button>
          </div>
        </div>
      )}
      {phase === 'running' && (
        <div className="border-2 border-border p-3 shadow-brut-sm bg-muted-bg font-mono text-xs">
          <span className="inline-block w-2 h-2 bg-accent mr-2 animate-pulse"></span>
          running auto-revise{props.all ? ' (all)' : ` (${props.repo})`}…
        </div>
      )}
      <AnimatePresence>
        {phase === 'done' && result && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="border-2 border-border p-3 shadow-brut-sm bg-muted-bg"
          >
            <div className="font-mono text-xs uppercase tracking-wider mb-2">
              result
            </div>
            <ResultBody result={result} />
            <motion.button
              type="button"
              onClick={() => {
                setPhase('idle');
                setResult(null);
              }}
              whileHover={hover}
              whileTap={press}
              transition={{ duration: 0.1 }}
              className="mt-3 font-mono text-xs uppercase tracking-wider px-3 py-1.5 border-2 border-border bg-bg text-fg shadow-brut-sm"
            >
              dismiss
            </motion.button>
          </motion.div>
        )}
        {phase === 'error' && error && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="border-2 border-danger p-3 shadow-brut-sm bg-muted-bg"
          >
            <div className="font-mono text-xs uppercase tracking-wider mb-2 text-danger">
              error
            </div>
            <pre className="font-mono text-xs whitespace-pre-wrap">{error}</pre>
            <motion.button
              type="button"
              onClick={() => {
                setPhase('idle');
                setError(null);
              }}
              whileHover={hover}
              whileTap={press}
              transition={{ duration: 0.1 }}
              className="mt-3 font-mono text-xs uppercase tracking-wider px-3 py-1.5 border-2 border-border bg-bg text-fg shadow-brut-sm"
            >
              dismiss
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ResultBody({ result }: { result: Result }) {
  if ('results' in result && result.results) {
    return (
      <div>
        <div className="text-xs mb-2">{result.summary}</div>
        <table className="font-mono text-xs">
          <tbody>
            {Object.entries(result.results).map(([repo, r]) => (
              <tr key={repo}>
                <td className="pr-3">{repo}</td>
                <td>{r.status ?? (r.ok ? 'ok' : 'fail')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const r = result as RepoResult;
  return (
    <div>
      <div className="text-xs mb-1">
        status: <strong>{r.status ?? (r.ok ? 'ok' : 'fail')}</strong>
        {typeof r.exit_code === 'number' && ` (exit ${r.exit_code})`}
      </div>
      {r.note && <div className="text-xs text-muted mb-2">{r.note}</div>}
      {r.message && <div className="text-xs text-muted mb-2">{r.message}</div>}
      {r.stdout && (
        <details>
          <summary className="font-mono text-xs cursor-pointer">
            log (last 4KB)
          </summary>
          <pre className="font-mono text-xs whitespace-pre-wrap mt-1 max-h-64 overflow-y-auto">
            {r.stdout}
          </pre>
        </details>
      )}
    </div>
  );
}
