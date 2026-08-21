// BulkReview — bulk-triage surface for the cartograph review backlog.
//
// For each pending item (unblessed episodes + unblessed topics):
//   1. Approve → POST to existing /api/episode/<slug>/review or
//      /api/topic/<repo>/<topic>/review.
//   2. Reject (with note) → same endpoint with verdict=reject + note;
//      the note records why, and you rewrite it in-session via /revise.
//
// The verdict is always yours: nothing pre-judges the item. One item at a
// time, keyboard-navigable, built for clearing a 50-item backlog fast.

import { useEffect, useState } from 'react';

interface PendingItem {
  path: string;
  kind: 'episode' | 'topic';
  layer: string | null;
  repo: string | null;
  slug: string | null;
  date?: string | null;
  last_revised?: string | null;
}

interface ActionResult {
  ok: boolean;
  message: string;
}

function reviewUrlFor(item: PendingItem): string | null {
  if (item.kind === 'episode' && item.slug) {
    // Episode slug in the API is the date-prefixed file basename without .md.
    const m = item.path.match(/episodes\/\d{4}-\d{2}\/(.+)\.md$/);
    if (m) return `/api/episode/${m[1]}/review`;
  }
  if (item.kind === 'topic' && item.repo && item.slug) {
    return `/api/topic/${item.repo}/${item.slug}/review`;
  }
  return null;
}

function detailUrlFor(item: PendingItem): string {
  if (item.kind === 'episode') {
    const m = item.path.match(/episodes\/\d{4}-\d{2}\/(.+)\.md$/);
    if (m) return `/episodes/${m[1]}/`;
  }
  if (item.kind === 'topic' && item.repo && item.slug) {
    return `/repo/${item.repo}/topics/${item.slug}/`;
  }
  return '#';
}

export default function BulkReview() {
  const [items, setItems] = useState<PendingItem[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [body, setBody] = useState<string | null>(null);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  // Load pending list once on mount.
  useEffect(() => {
    fetch('/api/review/pending')
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (!j) { setItems([]); return; }
        setItems([...(j.episodes || []), ...(j.topics || [])]);
      })
      .catch(() => setItems([]));
  }, []);

  // On cursor move, reset per-item state and fetch the rendered body.
  useEffect(() => {
    if (!items || items.length === 0) return;
    setRejectMode(false);
    setRejectNote('');
    setResult(null);
    setBody(null);
    const item = items[cursor];
    if (!item) return;
    // Use the existing slug-detail pages' API of just reading the raw .md
    // is too costly to expose; instead, link to detail. Skip inline body load.
    // (Future: a /api/raw/<path> endpoint could enable in-place rendering.)
  }, [cursor, items]);

  const submitReview = async (verdict: 'approve' | 'reject', notes?: string) => {
    const item = items?.[cursor];
    if (!item) return;
    const url = reviewUrlFor(item);
    if (!url) { setResult({ ok: false, message: 'no review URL for item' }); return; }
    setActionBusy(true);
    try {
      // Backend canonical key is `note` (singular). Sending 'notes'
      // used to 400 silently, so reject reasons never reached the file
      // across all three review surfaces.
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict, ...(notes ? { note: notes } : {}) }),
      });
      if (!r.ok) {
        const text = await r.text();
        setResult({ ok: false, message: `${r.status}: ${text.slice(0, 200)}` });
      } else {
        setResult({ ok: true, message: verdict === 'reject' ? '✓ rejected · revise it in-session with /revise' : '✓ blessed' });
        // Advance to next item after a short delay.
        setTimeout(() => {
          if (items && cursor < items.length - 1) {
            setCursor((c) => c + 1);
          }
        }, 800);
      }
    } catch (e) {
      setResult({ ok: false, message: String(e) });
    } finally {
      setActionBusy(false);
    }
  };

  if (items === null) return <p className="text-sm text-muted p-4">loading queue…</p>;
  if (items.length === 0) {
    return (
      <p className="p-4 text-sm text-muted">
        Inbox is clear — no items pending review. 🎉
      </p>
    );
  }
  if (cursor >= items.length) {
    return (
      <div className="p-4 text-sm">
        <p className="text-fg mb-2">✓ Reviewed all {items.length} items in this batch.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="px-3 py-1 font-mono text-xs border-2 border-border hover:bg-[var(--surface-1)]"
        >Reload queue</button>
      </div>
    );
  }

  const item = items[cursor];
  return (
    <div>
      <div className="px-4 py-2 border-b-2 border-border bg-[var(--surface-1)] flex items-center justify-between font-mono text-xs">
        <span>
          item {cursor + 1} / {items.length}
          {' · '}
          <span className="text-accent">{item.kind}</span>
          {item.repo && <> · <span className="text-fg">{item.repo}</span></>}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCursor((c) => Math.max(0, c - 1))}
            disabled={cursor === 0}
            className="px-2 py-0.5 border border-border text-muted hover:text-fg disabled:opacity-50"
          >← prev</button>
          <button
            type="button"
            onClick={() => setCursor((c) => Math.min(items.length, c + 1))}
            className="px-2 py-0.5 border border-border text-muted hover:text-fg"
          >skip →</button>
        </div>
      </div>

      <div className="p-4 space-y-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted">path</div>
          <a href={detailUrlFor(item)} target="_blank" rel="noopener noreferrer" className="font-mono text-sm text-accent hover:underline break-all">
            {item.path} ↗
          </a>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => submitReview('approve')}
            disabled={actionBusy}
            className="px-3 py-1 font-mono text-xs bg-[var(--ok)] text-bg hover:opacity-90 disabled:opacity-50"
          >✓ approve</button>
          <button
            type="button"
            onClick={() => setRejectMode((v) => !v)}
            disabled={actionBusy}
            className="px-3 py-1 font-mono text-xs border-2 border-[var(--warn)] text-[var(--warn)] hover:bg-[var(--warn)] hover:text-bg disabled:opacity-50"
          >{rejectMode ? 'cancel reject' : '✗ reject…'}</button>
        </div>

        {rejectMode && (
          <div className="space-y-2">
            <textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="what's wrong with this note? (the reason is stamped on the file for the session that revises it)"
              rows={3}
              className="w-full px-3 py-2 font-mono text-xs border-2 border-border bg-bg focus:outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => submitReview('reject', rejectNote || 'rejected via bulk-review UI')}
              disabled={actionBusy}
              className="px-3 py-1 font-mono text-xs bg-[var(--warn)] text-bg hover:opacity-90 disabled:opacity-50"
            >confirm reject</button>
          </div>
        )}

        {result && (
          <div className={`font-mono text-xs ${result.ok ? 'text-[var(--ok)]' : 'text-[var(--danger)]'}`}>
            {result.message}
          </div>
        )}
      </div>
    </div>
  );
}
