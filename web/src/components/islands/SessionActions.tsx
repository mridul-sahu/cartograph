// SessionActions — buttons rendered on the per-session detail page to
// resolve a "missed-episode" hint:
//
//   • write episode (claude -p)  — invokes scripts/session-to-episode.sh
//   • mark as trivial            — patches episode_written: "not-needed"
//   • open log in editor         — opens the session .md in code-server
//   • ask claude what to capture — kind=summarize-session in /api/ask
//
// Mounted on /sessions/<slug>/. Behaves like ContentActions but with
// session-specific verbs.
import { useState } from 'react';
import {
  motion,
  AnimatePresence,
  useReducedMotion,
} from 'motion/react';
import AskClaude from './AskClaude';

interface Props {
  slug: string;
  scope: string;
  filePath: string;
  isMissed: boolean;
  episodeWritten: string | null;
  codeServerOrigin?: string;
  cartographRoot?: string;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

export default function SessionActions({
  slug,
  scope,
  filePath,
  isMissed,
  episodeWritten,
  codeServerOrigin = 'http://localhost:47780',
  cartographRoot = '<cartograph-root>',
}: Props) {
  const reduced = useReducedMotion();
  const press = reduced ? {} : { x: 2, y: 2, boxShadow: '0 0 0 0 var(--shadow)' };
  const hover = reduced ? {} : { x: -1, y: -1 };

  const editorPayload = JSON.stringify([
    [
      'openFile',
      `vscode-remote://${codeServerOrigin.replace(/^https?:\/\//, '')}${cartographRoot}/${filePath}`,
    ],
  ]);
  const editorUrl = `${codeServerOrigin}/?folder=${encodeURIComponent(
    cartographRoot,
  )}&payload=${encodeURIComponent(editorPayload)}`;

  return (
    <div className="brutal-card p-4 space-y-4">
      <div>
        <div className="font-mono text-xs uppercase tracking-widest text-muted mb-2">
          actions
        </div>
        <div className="space-y-2">
          {isMissed && (
            <WriteEpisodeAction slug={slug} press={press} hover={hover} />
          )}
          {isMissed && (
            <MarkTrivialAction slug={slug} press={press} hover={hover} />
          )}
          <motion.a
            href={editorUrl}
            target="_blank"
            rel="noopener noreferrer"
            whileHover={hover}
            whileTap={press}
            transition={{ duration: 0.1 }}
            className="block p-2 border-2 border-border bg-bg text-fg no-underline shadow-brut-sm"
          >
            <div className="font-mono text-xs uppercase tracking-wider">
              open session log in editor ↗
            </div>
            <div className="font-mono text-[10px] text-muted mt-0.5">
              {filePath}
            </div>
          </motion.a>
          {episodeWritten && episodeWritten !== 'not-needed' && (
            <motion.a
              href={`/episodes/${episodeWritten.replace(/\.md$/, '')}/`}
              whileHover={hover}
              whileTap={press}
              transition={{ duration: 0.1 }}
              className="block p-2 border-2 border-border bg-bg text-fg no-underline shadow-brut-sm"
            >
              <div className="font-mono text-xs uppercase tracking-wider">
                view linked episode →
              </div>
              <div className="font-mono text-[10px] text-muted mt-0.5">
                {episodeWritten}
              </div>
            </motion.a>
          )}
        </div>
      </div>

      <div className="border-t-2 border-border pt-4">
        <AskClaude
          kind="general"
          repo={scope.startsWith('fork-') ? scope.replace('fork-', '') : undefined}
          context={filePath}
          title="ask claude what to capture"
          placeholder={
            isMissed
              ? `e.g., "Skim this session log and tell me what's worth preserving."`
              : `e.g., "What was the most useful thing learned in this session?"`
          }
        />
      </div>
    </div>
  );
}

function WriteEpisodeAction({
  slug,
  press,
  hover,
}: {
  slug: string;
  press: object;
  hover: object;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    if (!confirm(`Draft an episode for ${slug}? Invokes claude -p, takes 1–3 min.`))
      return;
    setPhase('running');
    try {
      const res = await fetch(`/api/session/${slug}/write-episode`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setResult(data.detail ?? `exit ${data.exit_code ?? '?'}`);
        setPhase('error');
        return;
      }
      setResult(data.note ?? 'draft written — check episodes/');
      setPhase('done');
    } catch (e) {
      setResult(String(e));
      setPhase('error');
    }
  }

  return (
    <div className="block p-2 border-2 border-accent bg-bg shadow-brut-sm">
      <div className="font-mono text-xs uppercase tracking-wider text-accent">
        write episode from this session
      </div>
      <div className="font-mono text-[10px] text-muted mt-0.5 mb-2">
        invokes <code>claude -p</code> with the session log as context · 1–3 min
      </div>
      <motion.button
        type="button"
        onClick={run}
        disabled={phase === 'running' || phase === 'done'}
        whileHover={phase === 'running' || phase === 'done' ? {} : hover}
        whileTap={phase === 'running' || phase === 'done' ? {} : press}
        transition={{ duration: 0.1 }}
        className="font-mono text-[11px] uppercase tracking-wider px-2 py-1 border-2 border-border bg-accent text-accent-fg disabled:opacity-50"
      >
        {phase === 'running' ? 'drafting…' : phase === 'done' ? 'done' : 'draft'}
      </motion.button>
      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-2 font-mono text-[10px] text-muted break-all"
          >
            {result}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MarkTrivialAction({
  slug,
  press,
  hover,
}: {
  slug: string;
  press: object;
  hover: object;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setPhase('running');
    try {
      const res = await fetch(`/api/session/${slug}/mark-trivial`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setResult(data.detail ?? 'failed');
        setPhase('error');
        return;
      }
      setResult('marked trivial — refresh to see the chip update');
      setPhase('done');
    } catch (e) {
      setResult(String(e));
      setPhase('error');
    }
  }

  return (
    <div className="block p-2 border-2 border-border bg-bg shadow-brut-sm">
      <div className="font-mono text-xs uppercase tracking-wider">
        mark this session trivial
      </div>
      <div className="font-mono text-[10px] text-muted mt-0.5 mb-2">
        patches <code>episode_written:</code> to <code>"not-needed"</code>;
        the missed-episode chip will clear on refresh
      </div>
      <motion.button
        type="button"
        onClick={run}
        disabled={phase === 'running' || phase === 'done'}
        whileHover={phase === 'running' || phase === 'done' ? {} : hover}
        whileTap={phase === 'running' || phase === 'done' ? {} : press}
        transition={{ duration: 0.1 }}
        className="font-mono text-[11px] uppercase tracking-wider px-2 py-1 border-2 border-border bg-bg disabled:opacity-50"
      >
        {phase === 'running' ? '…' : phase === 'done' ? 'done' : 'mark trivial'}
      </motion.button>
      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-2 font-mono text-[10px] text-muted"
          >
            {result}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
