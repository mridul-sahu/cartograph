// EpisodeReview — approve / reject / discard controls for an episode page.
//
// Sessions write episodes; the human reviews them here:
//   approve  → sets reviewed_by_human:<today>
//   reject   → records the note; a later session revises per the note
//   discard  → deletes the episode for good
//
// Same brutalist + motion idiom as AuditPanel.
import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface Props {
  slug: string;
  initialReviewed: string | null;
  initialRejected: boolean;
  initialRevisedAfterRejection?: string | null;
}

type Phase = 'idle' | 'rejecting' | 'submitting' | 'success' | 'error';

export default function EpisodeReview({
  slug,
  initialReviewed,
  initialRejected,
  initialRevisedAfterRejection = null,
}: Props) {
  const reduced = useReducedMotion();
  const press = reduced ? {} : { x: 2, y: 2, boxShadow: '0 0 0 0 var(--shadow)' };
  const hover = reduced ? {} : { x: -1, y: -1 };

  const [reviewed, setReviewed] = useState<string | null>(initialReviewed);
  const [rejected, setRejected] = useState<boolean>(initialRejected);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [resultMsg, setResultMsg] = useState('saved');

  async function submit(verdict: 'approve' | 'reject' | 'discard') {
    if (verdict === 'reject' && !note.trim()) {
      setError('reject requires a note (one sentence is fine).');
      setPhase('error');
      return;
    }
    if (
      verdict === 'discard' &&
      !confirm(
        `Discard this episode permanently?\n\nThe file is deleted for good — this cannot be undone.`,
      )
    ) {
      return;
    }
    setPhase('submitting');
    setError(null);
    try {
      const res = await fetch(`/api/episode/${slug}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verdict,
          ...(verdict === 'reject' ? { note: note.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail ?? `HTTP ${res.status}`);

      if (verdict === 'discard') {
        // The episode file is gone — leave the (now-dead) page.
        window.location.href = '/episodes/';
        return;
      }
      if (verdict === 'approve') {
        setReviewed(new Date().toISOString().slice(0, 10));
        setRejected(false);
        setResultMsg('approved');
      } else {
        setRejected(true);
        setReviewed(null);
        setResultMsg(
          data.note ?? 'rejected — revise it in a session (/revise); the review queue keeps it flagged.',
        );
      }
      setPhase('success');
      setNote('');
      setTimeout(() => setPhase('idle'), 4000);
    } catch (e) {
      setError(String(e));
      setPhase('error');
    }
  }

  const btn =
    'font-mono text-[11px] uppercase tracking-wider px-2 py-1 border-2 shadow-brut-sm disabled:opacity-50';
  const busy = phase === 'submitting';
  // Once a verdict has landed, hide the primary action row. Re-approving
  // is a no-op; the user almost never wants to touch it. Keep an escape
  // hatch behind a 'change my mind' disclosure so reject/discard stay
  // available without shouting at the user about a state they resolved.
  const isResolved = Boolean(reviewed) || rejected;
  const [showOverride, setShowOverride] = useState(false);

  return (
    <div className="brutal-card p-4">
      <div className="font-mono text-xs uppercase tracking-widest text-muted mb-2">
        review verdict
      </div>
      {reviewed && (
        <div className="font-mono text-xs mb-3">
          <span className="text-ok">✓ approved</span>
          <span className="text-muted"> · {reviewed}</span>
        </div>
      )}
      {rejected && (
        <div className="font-mono text-xs mb-3">
          <span className="text-danger">✗ rejected</span>
          <span className="text-muted"> · revise it in a session; the queue keeps it flagged</span>
        </div>
      )}
      {!reviewed && !rejected && initialRevisedAfterRejection && (
        <div className="font-mono text-xs mb-3">
          <span className="text-accent">↻ revised after rejection</span>
          <span className="text-muted">
            {' '}
            · {initialRevisedAfterRejection} · please re-review
          </span>
        </div>
      )}
      {!reviewed && !rejected && !initialRevisedAfterRejection && (
        <div className="font-mono text-xs text-muted mb-3">
          flows on its own (distill + fold) · veto here if wrong
        </div>
      )}

      {phase !== 'rejecting' && isResolved && !showOverride && (
        <button
          type="button"
          onClick={() => setShowOverride(true)}
          className="font-mono text-[10px] text-muted hover:text-fg underline decoration-dotted"
        >
          ↻ change my mind (reject / discard)
        </button>
      )}
      {phase !== 'rejecting' && (!isResolved || showOverride) && (
        <div className="flex gap-2 flex-wrap">
          {!isResolved && (
            <motion.button
              type="button"
              onClick={() => submit('approve')}
              disabled={busy}
              whileHover={busy ? {} : hover}
              whileTap={busy ? {} : press}
              transition={{ duration: 0.1 }}
              className={`${btn} border-border bg-accent text-accent-fg`}
            >
              approve
            </motion.button>
          )}
          <motion.button
            type="button"
            onClick={() => setPhase('rejecting')}
            disabled={busy}
            whileHover={busy ? {} : hover}
            whileTap={busy ? {} : press}
            transition={{ duration: 0.1 }}
            className={`${btn} border-danger bg-bg text-danger`}
          >
            reject
          </motion.button>
          <motion.button
            type="button"
            onClick={() => submit('discard')}
            disabled={busy}
            whileHover={busy ? {} : hover}
            whileTap={busy ? {} : press}
            transition={{ duration: 0.1 }}
            className={`${btn} border-border bg-bg text-muted`}
          >
            discard
          </motion.button>
          {showOverride && (
            <button
              type="button"
              onClick={() => setShowOverride(false)}
              className="font-mono text-[10px] text-muted hover:text-fg underline decoration-dotted self-center"
            >
              × cancel
            </button>
          )}
        </div>
      )}

      <AnimatePresence>
        {phase === 'rejecting' && (
          <motion.div
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-3"
          >
            <div className="font-mono text-[10px] text-muted mb-1">
              what's wrong? the note is stamped on the episode for the revising session.
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g., 'the cache-miss explanation contradicts pjit.py:512 — verify and correct'"
              rows={3}
              className="w-full font-mono text-xs border-2 border-border bg-bg p-2 outline-none focus:border-accent"
            />
            <div className="flex gap-2 mt-2">
              <motion.button
                type="button"
                onClick={() => submit('reject')}
                disabled={!note.trim() || busy}
                whileHover={!note.trim() ? {} : hover}
                whileTap={!note.trim() ? {} : press}
                transition={{ duration: 0.1 }}
                className={`${btn} border-danger bg-danger text-bg`}
              >
                reject &amp; send to claude
              </motion.button>
              <motion.button
                type="button"
                onClick={() => {
                  setPhase('idle');
                  setNote('');
                  setError(null);
                }}
                whileHover={hover}
                whileTap={press}
                transition={{ duration: 0.1 }}
                className={`${btn} border-border bg-bg`}
              >
                cancel
              </motion.button>
            </div>
          </motion.div>
        )}
        {phase === 'success' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-3 font-mono text-[10px] text-ok"
          >
            {resultMsg}
          </motion.div>
        )}
        {phase === 'error' && error && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-3 font-mono text-[10px] text-danger break-all"
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
