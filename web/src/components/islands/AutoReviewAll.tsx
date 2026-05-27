// AutoReviewAll — one-click "review every pending item" pass.
//
// Walks /api/review/pending serially. For each item:
//   1. POST /api/review/opinion       → {verdict, reason, confidence}
//   2. POST /api/{episode|topic}/.../review with that verdict + reason as note
//
// Rejects automatically queue scripts/revise-rejected.sh on the server
// (existing chassis behavior — no extra work needed here).
//
// Designed for the user's "I have 47 items in the queue, deal with them"
// case. Serial because claude -p has rate limits; the UI shows progress
// and tally inline. Cancellable mid-stream. Optional dry-run mode just
// fetches opinions without applying — useful for confidence-building
// before a real run.

import { useEffect, useRef, useState } from 'react';

interface PendingItem {
  path: string;
  kind: 'episode' | 'topic';
  layer: string | null;
  repo: string | null;
  slug: string | null;
}

interface Opinion {
  verdict: 'approve' | 'reject';
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

type ItemStatus =
  | { phase: 'pending' }
  | { phase: 'opinion' }
  | { phase: 'applying' }
  | { phase: 'done'; verdict: 'approve' | 'reject'; reason: string; confidence: string; applied: boolean; error?: string }
  | { phase: 'error'; error: string };

interface Row {
  item: PendingItem;
  status: ItemStatus;
}

function reviewUrlFor(item: PendingItem): string | null {
  if (item.kind === 'episode') {
    const m = item.path.match(/episodes\/\d{4}-\d{2}\/(.+)\.md$/);
    if (m) return `/api/episode/${m[1]}/review`;
  }
  if (item.kind === 'topic' && item.repo && item.slug) {
    return `/api/topic/${item.repo}/${item.slug}/review`;
  }
  return null;
}

export default function AutoReviewAll() {
  const [pending, setPending] = useState<PendingItem[] | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [done, setDone] = useState(false);
  const [requireHigh, setRequireHigh] = useState(true);
  const cancelRef = useRef(false);

  useEffect(() => {
    (async () => {
      const r = await fetch('/api/review/pending');
      if (!r.ok) return;
      const j = await r.json();
      const items: PendingItem[] = [...(j.episodes || []), ...(j.topics || [])];
      setPending(items);

      // Hydrate per-row state from .cartograph/jobs/opinion-*.json so
      // prior opinion results survive page reloads. Items whose opinion
      // was already fetched come back with their verdict + reason inline.
      const hydrated: Row[] = await Promise.all(items.map(async (item) => {
        try {
          const s = await fetch(`/api/job/opinion?path=${encodeURIComponent(item.path)}`);
          if (!s.ok) return { item, status: { phase: 'pending' as const } };
          const sj = await s.json();
          if (sj.status === 'done') {
            return { item, status: {
              phase: 'done' as const,
              verdict: sj.verdict, reason: sj.reason, confidence: sj.confidence,
              // Opinion was fetched in a prior session but the apply step never ran;
              // mark as applied=false so the user sees the verdict without acting on it.
              applied: false,
            } };
          }
          if (sj.status === 'running') {
            return { item, status: { phase: 'opinion' as const } };
          }
        } catch { /* fall through */ }
        return { item, status: { phase: 'pending' as const } };
      }));
      setRows(hydrated);
    })();
  }, []);

  const runAll = async () => {
    if (running || !pending) return;
    setRunning(true);
    setCancel(false);
    cancelRef.current = false;
    setDone(false);

    for (let i = 0; i < rows.length; i++) {
      if (cancelRef.current) break;
      const row = rows[i];

      // Phase 1: fetch opinion via fire-and-forget + poll.
      setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: { phase: 'opinion' } } : r));
      let opinion: Opinion | null = null;
      try {
        await fetch('/api/review/opinion', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: row.item.path }),
        });
        const started = Date.now();
        const MAX_SECS = 300;
        while ((Date.now() - started) / 1000 < MAX_SECS) {
          if (cancelRef.current) break;
          await new Promise((res) => setTimeout(res, 3000));
          try {
            const r = await fetch(`/api/job/opinion?path=${encodeURIComponent(row.item.path)}`);
            if (!r.ok) continue;
            const j = await r.json();
            if (j.status === 'done') { opinion = j as Opinion; break; }
            if (j.status === 'error') {
              opinion = { verdict: 'approve', reason: `error: ${j.error}`, confidence: 'low' };
              break;
            }
          } catch { /* transient */ }
        }
        if (!opinion) {
          opinion = { verdict: 'approve', reason: 'client poll timed out (job may still be running)', confidence: 'low' };
        }
      } catch (e) {
        setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: { phase: 'error', error: `opinion: ${String(e)}` } } : r));
        continue;
      }

      // Safety gate: if requireHigh is on, defer any low-confidence verdict (mark done, applied=false).
      if (requireHigh && opinion.confidence === 'low') {
        setRows((prev) => prev.map((r, idx) => idx === i ? {
          ...r,
          status: { phase: 'done', verdict: opinion!.verdict, reason: opinion!.reason, confidence: opinion!.confidence, applied: false, error: 'low confidence — deferred for manual review' }
        } : r));
        continue;
      }

      // Dry-run: just record the verdict.
      if (dryRun) {
        setRows((prev) => prev.map((r, idx) => idx === i ? {
          ...r,
          status: { phase: 'done', verdict: opinion!.verdict, reason: opinion!.reason, confidence: opinion!.confidence, applied: false }
        } : r));
        continue;
      }

      // Phase 2: apply the verdict.
      setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: { phase: 'applying' } } : r));
      const url = reviewUrlFor(row.item);
      if (!url) {
        setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: { phase: 'error', error: 'no review URL — kind/slug missing' } } : r));
        continue;
      }
      try {
        // Backend reads body.get('note'); 'notes' was silently 400ing
        // and revise-rejected.sh never spawned. See BulkAll.tsx.
        const body = opinion.verdict === 'reject'
          ? { verdict: 'reject', note: opinion.reason }
          : { verdict: 'approve' };
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const txt = await r.text();
          setRows((prev) => prev.map((row2, idx) => idx === i ? {
            ...row2,
            status: { phase: 'done', verdict: opinion!.verdict, reason: opinion!.reason, confidence: opinion!.confidence, applied: false, error: `${r.status}: ${txt.slice(0, 100)}` }
          } : row2));
          continue;
        }
        setRows((prev) => prev.map((row2, idx) => idx === i ? {
          ...row2,
          status: { phase: 'done', verdict: opinion!.verdict, reason: opinion!.reason, confidence: opinion!.confidence, applied: true }
        } : row2));
      } catch (e) {
        setRows((prev) => prev.map((r, idx) => idx === i ? {
          ...r,
          status: { phase: 'done', verdict: opinion!.verdict, reason: opinion!.reason, confidence: opinion!.confidence, applied: false, error: String(e) }
        } : r));
      }
    }

    setRunning(false);
    setDone(true);
  };

  const requestCancel = () => {
    setCancel(true);
    cancelRef.current = true;
  };

  if (pending === null) return <p className="text-sm text-muted p-4">loading queue…</p>;
  if (pending.length === 0) {
    return <p className="text-sm text-muted p-4">Inbox is clear — no items pending review. 🎉</p>;
  }

  // Tally
  const tally = rows.reduce((acc, r) => {
    if (r.status.phase === 'done') {
      if (r.status.applied && r.status.verdict === 'approve') acc.approved++;
      else if (r.status.applied && r.status.verdict === 'reject') acc.rejected++;
      else acc.deferred++;
    } else if (r.status.phase === 'error') {
      acc.errored++;
    } else if (r.status.phase !== 'pending') {
      acc.running++;
    }
    return acc;
  }, { approved: 0, rejected: 0, deferred: 0, errored: 0, running: 0 });

  const progress = rows.filter((r) => r.status.phase !== 'pending').length;

  return (
    <div>
      <div className="px-4 py-3 border-b-2 border-border bg-[var(--surface-1)]">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          {!running && !done && (
            <button
              type="button"
              onClick={runAll}
              className="px-4 py-2 font-mono text-sm bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90"
            >
              ▶ Run auto-review on all {pending.length} items
            </button>
          )}
          {running && (
            <>
              <span className="font-mono text-sm text-fg">running… {progress} / {pending.length}</span>
              <button
                type="button"
                onClick={requestCancel}
                disabled={cancel}
                className="px-3 py-1 font-mono text-xs border-2 border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger)] hover:text-bg disabled:opacity-50"
              >{cancel ? 'cancelling…' : '⏸ cancel'}</button>
            </>
          )}
          {done && (
            <>
              <span className="font-mono text-sm text-[var(--ok)]">✓ run complete</span>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-3 py-1 font-mono text-xs border-2 border-border hover:bg-[var(--surface-1)]"
              >reload</button>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4 font-mono text-xs">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={running} />
            <span className="text-muted">dry-run — fetch opinions, don't apply verdicts</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={requireHigh} onChange={(e) => setRequireHigh(e.target.checked)} disabled={running} />
            <span className="text-muted">defer low-confidence — leave low-confidence verdicts to manual review</span>
          </label>
        </div>
        {(progress > 0 || done) && (
          <div className="mt-2 font-mono text-xs flex flex-wrap gap-4">
            <span className="text-[var(--ok)]">✓ approved: {tally.approved}</span>
            <span className="text-[var(--warn)]">✗ rejected (+queued fix): {tally.rejected}</span>
            <span className="text-muted">⊘ deferred: {tally.deferred}</span>
            {tally.errored > 0 && <span className="text-[var(--danger)]">⚠ errored: {tally.errored}</span>}
          </div>
        )}
      </div>

      <ul className="divide-y divide-[var(--border-soft)] max-h-[60vh] overflow-y-auto">
        {rows.map((row, i) => {
          const s = row.status;
          const stateLabel =
            s.phase === 'pending' ? '·' :
            s.phase === 'opinion' ? 'asking claude…' :
            s.phase === 'applying' ? 'applying…' :
            s.phase === 'error' ? `error: ${s.error}` :
            s.applied ? (s.verdict === 'approve' ? `✓ approved` : `✗ rejected → fix queued`) :
            `${s.verdict} (${s.confidence}) — not applied${s.error ? `: ${s.error}` : ''}`;
          const stateCls =
            s.phase === 'pending' ? 'text-muted' :
            s.phase === 'opinion' || s.phase === 'applying' ? 'text-[var(--accent)]' :
            s.phase === 'error' ? 'text-[var(--danger)]' :
            s.applied && s.verdict === 'approve' ? 'text-[var(--ok)]' :
            s.applied && s.verdict === 'reject' ? 'text-[var(--warn)]' :
            'text-muted';
          return (
            <li key={row.item.path} className={i % 2 === 0 ? 'bg-bg' : 'bg-[var(--surface-1)]'}>
              <div className="px-3 py-1.5 flex items-baseline gap-3 font-mono text-[11px]">
                <span className="text-muted w-12 text-right">{i + 1}.</span>
                <span className="text-accent w-16">{row.item.kind}</span>
                <span className="flex-1 min-w-0 truncate text-fg">{row.item.path}</span>
                <span className={`${stateCls} whitespace-nowrap`}>{stateLabel}</span>
              </div>
              {s.phase === 'done' && s.reason && (
                <div className="px-3 pb-1.5 text-[10px] text-muted ml-12">{s.reason}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
