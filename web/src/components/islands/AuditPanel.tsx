// Audit panel for the topic-note viewer.
//
// The Astro page reads `reviewed_by_human` / `review_notes` frontmatter at
// build time and hands them in. From there this island talks to
// `POST /api/topic/<repo>/<topic>/review`:
//   approve  → stamps reviewed_by_human
//   reject   → records the note, then a claude agent researches + fixes
//              the topic per the note and resets it to pending re-review
//   discard  → deletes the topic note for good
//
// Buttons use the brutalist press idiom; gestures gate on reduced-motion.
import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface Props {
  repo: string;
  topic: string;
  initialReviewed: string | null;
  initialNotes: string | null;
}

type Toast = { kind: 'ok' | 'err'; message: string };
type Busy = 'approve' | 'reject' | 'discard' | null;

export default function AuditPanel({
  repo,
  topic,
  initialReviewed,
  initialNotes,
}: Props) {
  const reduced = useReducedMotion();
  const [reviewed, setReviewed] = useState<string | null>(initialReviewed);
  const [notes, setNotes] = useState<string | null>(initialNotes);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [submitting, setSubmitting] = useState<Busy>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  function showToast(t: Toast) {
    setToast(t);
    if (typeof window !== 'undefined') {
      window.setTimeout(() => setToast(null), 7000);
    }
  }

  async function approve() {
    if (submitting) return;
    const prevReviewed = reviewed;
    const prevNotes = notes;
    setReviewed(new Date().toISOString().slice(0, 10));
    setNotes(null);
    setSubmitting('approve');
    try {
      const r = await fetch(`/api/topic/${repo}/${topic}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'approve' }),
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const json = (await r.json()) as {
        state: { reviewed_by_human: string | null; review_notes: string | null };
      };
      setReviewed(json.state?.reviewed_by_human ?? null);
      setNotes(json.state?.review_notes ?? null);
      showToast({ kind: 'ok', message: 'approved — refresh to confirm.' });
    } catch (err) {
      setReviewed(prevReviewed);
      setNotes(prevNotes);
      showToast({ kind: 'err', message: `approve failed — ${String(err)}` });
    } finally {
      setSubmitting(null);
    }
  }

  async function reject() {
    if (submitting) return;
    const trimmed = rejectNote.trim();
    if (!trimmed) {
      showToast({ kind: 'err', message: 'add a note describing what to fix.' });
      return;
    }
    const prevReviewed = reviewed;
    const prevNotes = notes;
    setReviewed(null);
    setNotes(trimmed);
    setSubmitting('reject');
    try {
      const r = await fetch(`/api/topic/${repo}/${topic}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'reject', note: trimmed }),
      });
      if (!r.ok) {
        throw new Error(`${r.status} ${await r.text().catch(() => '')}`);
      }
      const json = (await r.json()) as { note?: string };
      setRejecting(false);
      setRejectNote('');
      showToast({
        kind: 'ok',
        message:
          json.note ??
          'rejected — claude is revising it per your note. reload in a few minutes to re-review.',
      });
    } catch (err) {
      setReviewed(prevReviewed);
      setNotes(prevNotes);
      showToast({ kind: 'err', message: `reject failed — ${String(err)}` });
    } finally {
      setSubmitting(null);
    }
  }

  async function discard() {
    if (submitting) return;
    if (
      !confirm(
        `Discard the "${topic}" topic note permanently?\n\nThe file is deleted for good — this cannot be undone.`,
      )
    ) {
      return;
    }
    setSubmitting('discard');
    try {
      const r = await fetch(`/api/topic/${repo}/${topic}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'discard' }),
      });
      if (!r.ok) {
        throw new Error(`${r.status} ${await r.text().catch(() => '')}`);
      }
      // The topic file is gone — leave the (now-dead) page.
      window.location.href = `/repo/${repo}/`;
    } catch (err) {
      showToast({ kind: 'err', message: `discard failed — ${String(err)}` });
      setSubmitting(null);
    }
  }

  const isApproved = Boolean(reviewed);
  const hasNotes = Boolean(notes && notes.trim());
  // When the note is already blessed we collapse the action buttons.
  // Re-approving is a no-op; reject/discard remain available behind a
  // "change my mind" disclosure so the panel stops shouting at a state
  // the user already resolved.
  const [showOverride, setShowOverride] = useState(false);

  const buttonTap = reduced
    ? undefined
    : { x: 2, y: 2, boxShadow: '0 0 0 0 var(--shadow)' };
  const buttonHover = reduced
    ? undefined
    : { x: -2, y: -2, boxShadow: '6px 6px 0 0 var(--shadow)' };
  const tx = {
    duration: 0.12,
    ease: [0.4, 0, 0.2, 1] as [number, number, number, number],
  };

  return (
    <div className="brutal-card p-4">
      <h3 className="font-mono text-xs uppercase tracking-widest text-muted mb-3">
        audit this topic
      </h3>

      {isApproved ? (
        <div className="mb-2">
          <div
            className="px-3 py-2 mb-2 font-mono text-xs flex items-center gap-2"
            style={{
              background: 'color-mix(in srgb, var(--ok) 18%, var(--bg))',
              color: 'var(--ok)',
              border: '2px solid var(--ok)',
            }}
          >
            <span aria-hidden>✓</span>
            <span>blessed by human on <strong>{reviewed}</strong></span>
          </div>
          <button
            type="button"
            onClick={() => setShowOverride((v) => !v)}
            className="font-mono text-[10px] text-muted hover:text-fg underline decoration-dotted"
          >
            {showOverride ? '× cancel' : '↻ change my mind (reject / discard)'}
          </button>
        </div>
      ) : (
        <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1.5 font-mono text-xs mb-3">
          <dt className="text-muted">reviewed</dt>
          <dd><span className="text-muted">— pending</span></dd>
          <dt className="text-muted">notes</dt>
          <dd className="break-words">
            {hasNotes ? (
              <span style={{ color: 'var(--warn)' }}>{notes}</span>
            ) : (
              <span className="text-muted">—</span>
            )}
          </dd>
        </dl>
      )}

      <div className="flex flex-col gap-2 mb-2">
        {!isApproved && (
          <motion.button
            type="button"
            onClick={approve}
            disabled={submitting !== null}
            className="brutal-button font-mono text-xs justify-center"
            style={{
              background: 'color-mix(in srgb, var(--ok) 18%, var(--bg))',
              color: 'var(--ok)',
              borderColor: 'var(--ok)',
              opacity: submitting === 'approve' ? 0.6 : 1,
            }}
            whileHover={buttonHover}
            whileTap={buttonTap}
            transition={tx}
          >
            <span aria-hidden>✓</span>
            <span>{submitting === 'approve' ? 'approving…' : 'approve'}</span>
          </motion.button>
        )}

        {(!isApproved || showOverride) && !rejecting ? (
          <>
            <motion.button
              type="button"
              onClick={() => setRejecting(true)}
              disabled={submitting !== null}
              className="brutal-button font-mono text-xs justify-center"
              style={{
                background: 'color-mix(in srgb, var(--warn) 18%, var(--bg))',
                color: 'var(--warn)',
                borderColor: 'var(--warn)',
              }}
              whileHover={buttonHover}
              whileTap={buttonTap}
              transition={tx}
            >
              <span aria-hidden>!</span>
              <span>reject &amp; fix</span>
            </motion.button>
            <motion.button
              type="button"
              onClick={discard}
              disabled={submitting !== null}
              className="brutal-button font-mono text-xs justify-center"
              style={{
                color: 'var(--muted)',
                opacity: submitting === 'discard' ? 0.6 : 1,
              }}
              whileHover={buttonHover}
              whileTap={buttonTap}
              transition={tx}
            >
              <span aria-hidden>🗑</span>
              <span>{submitting === 'discard' ? 'discarding…' : 'discard'}</span>
            </motion.button>
          </>
        ) : rejecting ? (
          <div className="space-y-2">
            <div className="font-mono text-[10px] text-muted leading-snug">
              what's wrong? claude will research this and fix the topic note.
            </div>
            <textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="what needs fixing? (e.g. 'wrong assertion about jvp dispatch — verify against ad.py')"
              rows={3}
              className="w-full p-2 border-2 border-border bg-bg font-mono text-xs leading-snug resize-y"
              style={{ outlineColor: 'var(--warn)' }}
              autoFocus
            />
            <div className="grid grid-cols-2 gap-2">
              <motion.button
                type="button"
                onClick={() => {
                  setRejecting(false);
                  setRejectNote('');
                }}
                disabled={submitting !== null}
                className="brutal-button font-mono text-xs justify-center"
                whileHover={buttonHover}
                whileTap={buttonTap}
                transition={tx}
              >
                cancel
              </motion.button>
              <motion.button
                type="button"
                onClick={reject}
                disabled={submitting !== null || !rejectNote.trim()}
                className="brutal-button font-mono text-xs justify-center"
                style={{
                  background: 'color-mix(in srgb, var(--warn) 18%, var(--bg))',
                  color: 'var(--warn)',
                  borderColor: 'var(--warn)',
                  opacity: submitting === 'reject' ? 0.6 : 1,
                }}
                whileHover={buttonHover}
                whileTap={buttonTap}
                transition={tx}
              >
                {submitting === 'reject' ? 'sending…' : 'reject → claude'}
              </motion.button>
            </div>
          </div>
        ) : null}
      </div>

      {(!isApproved || showOverride) && (
        <p className="font-mono text-[10px] text-muted leading-snug mt-2">
          <strong>reject &amp; fix</strong> hands the note to a claude agent that
          revises <code>guides/{repo}/topics/{topic}.md</code> and re-queues it
          for review. <strong>discard</strong> deletes it.
        </p>
      )}

      <AnimatePresence>
        {toast && <ToastPill toast={toast} reduced={reduced} />}
      </AnimatePresence>
    </div>
  );
}

function ToastPill({ toast, reduced }: { toast: Toast; reduced: boolean | null }) {
  const isErr = toast.kind === 'err';
  return (
    <motion.output
      role={isErr ? 'alert' : 'status'}
      aria-live="polite"
      initial={reduced ? { opacity: 0 } : { opacity: 0, x: 16 }}
      animate={reduced ? { opacity: 1 } : { opacity: 1, x: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: 16 }}
      transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
      className="fixed z-50 brutal-card p-3 font-mono text-xs"
      style={{
        bottom: '1.25rem',
        right: '1.25rem',
        maxWidth: '22rem',
        background: 'var(--bg)',
        borderColor: isErr ? 'var(--danger)' : 'var(--ok)',
      }}
    >
      <div className="flex items-start gap-2">
        <span
          style={{ color: isErr ? 'var(--danger)' : 'var(--ok)' }}
          className="font-bold"
          aria-hidden
        >
          {isErr ? '✗' : '✓'}
        </span>
        <span className="text-fg leading-snug">{toast.message}</span>
      </div>
    </motion.output>
  );
}
