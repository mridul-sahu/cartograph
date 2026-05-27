// LintPanel — surface /api/lint output on /status. Counts at the top,
// collapsible per-issue list below. No actions (read-only).
import { useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface LintIssue {
  severity: 'fail' | 'warn';
  file: string;
  message: string;
}

interface LintResponse {
  ok?: boolean;
  generated_at?: string;
  checked_files?: number;
  hard_fails?: number;
  soft_warns?: number;
  issues?: LintIssue[];
  exit_code?: number;
  error?: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: LintResponse }
  | { kind: 'error'; message: string };

export default function LintPanel() {
  const reduced = useReducedMotion();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/lint')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<LintResponse>;
      })
      .then((d) => {
        if (!cancelled) setState({ kind: 'ready', data: d });
      })
      .catch((err) => {
        if (!cancelled) setState({ kind: 'error', message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return <div className="font-mono text-sm text-muted">loading lint…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="brutal-card p-5 font-mono text-sm">
        <div className="text-danger font-bold">lint fetch failed</div>
        <div className="text-muted">{state.message}</div>
      </div>
    );
  }

  const { data } = state;
  const hardFails = data.hard_fails ?? 0;
  const softWarns = data.soft_warns ?? 0;
  const total = (data.checked_files ?? 0);

  return (
    <section>
      <div className="font-mono text-[11px] uppercase tracking-widest mb-3 text-muted">
        content lint · <code className="text-fg">/api/lint</code>
        {data.generated_at && (
          <> · {new Date(data.generated_at).toLocaleString()}</>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <div className="brutal-card p-5">
          <div className="font-mono text-[11px] uppercase tracking-widest text-muted mb-2">
            checked
          </div>
          <div className="font-mono text-4xl font-bold tracking-tightish leading-none">
            {total}
          </div>
          <div className="font-mono text-xs text-muted mt-2">files</div>
        </div>
        <div
          className="brutal-card p-5"
          style={
            hardFails > 0
              ? {
                  background:
                    'color-mix(in srgb, var(--danger) 14%, var(--bg))',
                  color: 'var(--danger)',
                  borderColor: 'var(--danger)',
                }
              : undefined
          }
        >
          <div className="font-mono text-[11px] uppercase tracking-widest mb-2">
            hard fails
          </div>
          <div className="font-mono text-4xl font-bold tracking-tightish leading-none">
            {hardFails}
          </div>
          <div className="font-mono text-xs mt-2 opacity-80">
            {hardFails === 0 ? 'bar cleared' : 'must fix'}
          </div>
        </div>
        <div
          className="brutal-card p-5"
          style={
            softWarns > 0
              ? {
                  background:
                    'color-mix(in srgb, var(--warn) 12%, var(--bg))',
                  color: 'var(--warn)',
                  borderColor: 'var(--warn)',
                }
              : undefined
          }
        >
          <div className="font-mono text-[11px] uppercase tracking-widest mb-2">
            soft warns
          </div>
          <div className="font-mono text-4xl font-bold tracking-tightish leading-none">
            {softWarns}
          </div>
          <div className="font-mono text-xs mt-2 opacity-80">
            below floor / thin
          </div>
        </div>
      </div>

      {data.issues && data.issues.length > 0 && (
        <div className="brutal-card p-5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="font-mono text-xs uppercase tracking-widest text-muted hover:text-fg"
          >
            {open ? '▾' : '▸'} show {data.issues.length} issue
            {data.issues.length === 1 ? '' : 's'}
          </button>
          <AnimatePresence>
            {open && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: reduced ? 0 : 0.18 }}
                style={{ overflow: 'hidden' }}
              >
                <ul className="mt-3 space-y-2 font-mono text-xs">
                  {data.issues.map((i, idx) => (
                    <li
                      key={`${i.file}-${idx}`}
                      className="border-l-2 pl-3"
                      style={{
                        borderColor:
                          i.severity === 'fail'
                            ? 'var(--danger)'
                            : 'var(--warn)',
                      }}
                    >
                      <div>
                        <span
                          className="inline-block px-1.5 mr-2 text-[10px] uppercase tracking-widest"
                          style={{
                            background:
                              i.severity === 'fail'
                                ? 'color-mix(in srgb, var(--danger) 18%, transparent)'
                                : 'color-mix(in srgb, var(--warn) 18%, transparent)',
                            color:
                              i.severity === 'fail'
                                ? 'var(--danger)'
                                : 'var(--warn)',
                          }}
                        >
                          {i.severity}
                        </span>
                        <code>{i.file}</code>
                      </div>
                      <div className="text-muted mt-0.5 pl-12">
                        {i.message}
                      </div>
                    </li>
                  ))}
                </ul>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
      {data.issues && data.issues.length === 0 && (
        <div className="brutal-card p-5 font-mono text-xs text-muted">
          no issues — content meets the bar.
        </div>
      )}
    </section>
  );
}
