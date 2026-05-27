// AskClaude — a general-purpose Claude entry point for the UI.
//
// Props:
//   kind         "explore" | "review-topic" | "explain-code" | "general"
//   repo?        the repo slug if applicable
//   context?     opaque extra context (a topic slug, a file path, etc.)
//   placeholder? textarea placeholder
//
// POSTs {kind, repo, context, prompt} to /api/ask which invokes `claude -p`
// headless with a kind-specific framing. Renders Claude's answer below the
// textarea. Same brutalist + motion idiom as AutoReviseButton / BackfillButton.
import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface Props {
  kind: 'explore' | 'review-topic' | 'explain-code' | 'general';
  repo?: string;
  context?: string;
  placeholder?: string;
  title?: string;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

export default function AskClaude({
  kind,
  repo,
  context,
  placeholder,
  title = 'ask claude',
}: Props) {
  const reduced = useReducedMotion();
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [answer, setAnswer] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const press = reduced ? {} : { x: 2, y: 2, boxShadow: '0 0 0 0 var(--shadow)' };
  const hover = reduced ? {} : { x: -1, y: -1 };

  async function submit() {
    if (!prompt.trim() || phase === 'running') return;
    setPhase('running');
    setError(null);
    setAnswer('');
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, repo, context, prompt }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`HTTP ${res.status}: ${t}`);
      }
      const data = await res.json();
      if (!data.ok) {
        setError(`claude exited ${data.exit_code}: ${data.stderr ?? ''}`);
        setPhase('error');
        return;
      }
      setAnswer(data.answer);
      setPhase('done');
    } catch (err) {
      setError(String(err));
      setPhase('error');
    }
  }

  return (
    <div className="brutal-card p-5">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <div className="font-mono text-xs uppercase tracking-widest">
          {title}
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted">
          kind: <code className="text-fg">{kind}</code>
          {repo && (
            <>
              {' · repo: '}
              <code className="text-fg">{repo}</code>
            </>
          )}
        </div>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={placeholder ?? 'ask anything about this codebase…'}
        rows={3}
        className="w-full font-mono text-sm border-2 border-border bg-bg p-2.5 mb-3 resize-y outline-none focus:border-accent"
        disabled={phase === 'running'}
      />
      <div className="flex items-center justify-between gap-3">
        <motion.button
          type="button"
          onClick={submit}
          whileHover={!prompt.trim() ? {} : hover}
          whileTap={!prompt.trim() ? {} : press}
          transition={{ duration: 0.1, ease: [0.4, 0, 0.2, 1] }}
          disabled={!prompt.trim() || phase === 'running'}
          className="font-mono text-xs uppercase tracking-wider px-3 py-1.5 border-2 border-border bg-accent text-accent-fg shadow-brut-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {phase === 'running' ? 'asking claude…' : 'ask'}
        </motion.button>
        <div className="font-mono text-[10px] text-muted">
          invokes <code>claude -p</code> · ~30–90s · headless
        </div>
      </div>

      <AnimatePresence>
        {phase === 'running' && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-4 font-mono text-xs text-muted"
          >
            <span className="inline-block w-2 h-2 bg-accent mr-2 animate-pulse" />
            claude is reading the relevant guides + code…
          </motion.div>
        )}
        {phase === 'done' && answer && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-4 border-t-2 border-border pt-4"
          >
            <div className="font-mono text-xs uppercase tracking-widest text-muted mb-2">
              answer
            </div>
            <pre className="font-mono text-sm whitespace-pre-wrap leading-relaxed">
              {answer}
            </pre>
          </motion.div>
        )}
        {phase === 'error' && error && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-4 border-2 border-danger p-3 font-mono text-xs"
          >
            <div className="uppercase tracking-widest text-danger mb-2">
              error
            </div>
            <pre className="whitespace-pre-wrap">{error}</pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
