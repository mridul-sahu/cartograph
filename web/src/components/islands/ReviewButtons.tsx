// ReviewButtons — in-place bless / reject for topics + auto-drafted episodes.
//
// Posts to the existing review endpoints:
//   POST /api/topic/{repo}/{topic}/review   { verdict: 'approve' | 'reject', notes? }
//   POST /api/episode/{slug}/review         { verdict: 'approve' | 'reject' | 'discard', notes? }
//
// Per claude-designs/cartograph/ui-audit-2026-05-25/ R1.

import { useEffect, useState } from 'react';

type Kind = 'topic' | 'episode';

interface Props {
  kind: Kind;
  // For topics: pass repo + topic slug; for episodes: pass slug only.
  repo?: string;
  slug: string;
  // Pre-fetched state — if set, skip the initial GET. Otherwise we probe
  // the API for the current reviewed/rejected state.
  initialReviewed?: string | null;
  initialRejected?: boolean;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'posting' }
  | { kind: 'done'; verdict: 'approve' | 'reject' | 'discard' }
  | { kind: 'error'; message: string };

export default function ReviewButtons(props: Props) {
  const [reviewed, setReviewed] = useState<string | null>(props.initialReviewed ?? null);
  const [rejected, setRejected] = useState<boolean>(props.initialRejected ?? false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [showRejectNote, setShowRejectNote] = useState(false);
  const [rejectNote, setRejectNote] = useState('');

  const reviewUrl = props.kind === 'topic'
    ? `/api/topic/${props.repo}/${props.slug}/review`
    : `/api/episode/${props.slug}/review`;

  // If initial state wasn't passed, fetch it (topics expose GET; episodes don't —
  // they ship the state inline on the page already, so caller always provides it).
  useEffect(() => {
    if (props.initialReviewed !== undefined || props.initialRejected !== undefined) return;
    if (props.kind !== 'topic') return;
    fetch(reviewUrl)
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (j?.state) {
          setReviewed(j.state.reviewed_by_human ?? null);
          setRejected(Boolean(j.state.rejected));
        }
      })
      .catch(() => {});
  }, [props.kind, props.initialReviewed, props.initialRejected, reviewUrl]);

  const post = async (verdict: 'approve' | 'reject' | 'discard', notes?: string) => {
    setStatus({ kind: 'posting' });
    try {
      const r = await fetch(reviewUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict, ...(notes ? { notes } : {}) }),
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j = await r.json();
      if (j?.state) {
        setReviewed(j.state.reviewed_by_human ?? null);
        setRejected(Boolean(j.state.rejected));
      } else if (verdict === 'approve') {
        setReviewed(new Date().toISOString().slice(0, 10));
        setRejected(false);
      } else if (verdict === 'reject') {
        setRejected(true);
        setReviewed(null);
      }
      setStatus({ kind: 'done', verdict });
    } catch (e) {
      setStatus({ kind: 'error', message: String(e) });
    }
  };

  return (
    <div className="border-2 border-border bg-bg p-4">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted mb-2">review</div>

      {reviewed && (
        <div className="mb-3 font-mono text-xs text-[var(--ok)]">
          ✓ blessed by human on <code>{reviewed}</code>
        </div>
      )}
      {rejected && (
        <div className="mb-3 font-mono text-xs text-[var(--danger)]">
          ✗ rejected — excluded from auto-promotion
        </div>
      )}
      {!reviewed && !rejected && (
        <div className="mb-3 font-mono text-xs text-muted">awaiting review</div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={status.kind === 'posting'}
          onClick={() => post('approve')}
          className="px-3 py-1 font-mono text-xs bg-[var(--ok)] text-bg disabled:opacity-50 hover:opacity-90"
        >
          {reviewed ? 're-bless' : 'bless'}
        </button>
        <button
          type="button"
          disabled={status.kind === 'posting'}
          onClick={() => setShowRejectNote((v) => !v)}
          className="px-3 py-1 font-mono text-xs border-2 border-border text-fg hover:bg-[var(--surface-1)]"
        >
          {rejected ? 'rejected' : 'reject…'}
        </button>
        {props.kind === 'episode' && (
          <button
            type="button"
            disabled={status.kind === 'posting'}
            onClick={() => {
              if (confirm('Discard this episode permanently? The file will be deleted.')) post('discard');
            }}
            className="px-3 py-1 font-mono text-xs border-2 border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger)] hover:text-bg"
          >
            discard
          </button>
        )}
      </div>

      {showRejectNote && (
        <div className="mt-3">
          <textarea
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            placeholder="why is this wrong? (stamped on the note for the revising session)"
            className="w-full border-2 border-border bg-bg p-2 font-mono text-xs"
            rows={3}
          />
          <button
            type="button"
            disabled={status.kind === 'posting'}
            onClick={() => { post('reject', rejectNote); setShowRejectNote(false); setRejectNote(''); }}
            className="mt-2 px-3 py-1 font-mono text-xs bg-[var(--danger)] text-bg hover:opacity-90"
          >
            confirm reject
          </button>
        </div>
      )}

      {status.kind === 'posting' && <div className="mt-2 font-mono text-[10px] text-muted">posting…</div>}
      {status.kind === 'error' && <div className="mt-2 font-mono text-[10px] text-[var(--danger)]">error: {status.message}</div>}
      {status.kind === 'done' && status.verdict === 'discard' && (
        <div className="mt-2 font-mono text-[10px] text-muted">discarded — reload to confirm</div>
      )}
    </div>
  );
}
