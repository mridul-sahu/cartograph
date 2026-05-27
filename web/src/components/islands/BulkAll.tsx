// BulkAll — unified bulk review surface for every flagged item type:
//   • bless    — auto-drafted episodes + unblessed topics (claude opinion + apply)
//   • anchor   — topics with anchor-coverage gaps (claude adds anchors)
//   • drift    — topics with per-topic drift open (claude revises or bumps)
//
// Loads from /api/review/pending, /api/anchor-coverage, /api/drift-list in
// parallel, unifies into a single list with type tags. One "Run all"
// button walks the list serially, dispatching the right action per type.
// Type-filter toggles let you scope to one or two kinds at a time. All
// per-row state hydrates from .cartograph/jobs/*.json on mount so reloads
// don't lose progress.

import { useEffect, useRef, useState } from 'react';

type Kind = 'bless' | 'anchor' | 'drift';

interface Item {
  kind: Kind;
  // For bless: path is the full repo-relative path (used by /api/review/opinion).
  // For anchor/drift: path is the topic guides/<repo>/topics/<slug>.md path.
  path: string;
  repo?: string;
  slug?: string;
  // Sub-kind for bless items so we know which review endpoint to hit:
  // 'episode' → /api/episode/<slug>/review, 'topic' → /api/topic/<r>/<s>/review.
  blessKind?: 'episode' | 'topic';
  // Short context shown under the row when pending.
  detail?: string;
}

type Phase = 'pending' | 'running' | 'done' | 'error';
interface ItemStatus {
  phase: Phase;
  // Bless action result.
  verdict?: 'approve' | 'reject';
  reason?: string;
  confidence?: 'high' | 'medium' | 'low';
  applied?: boolean;
  // Anchor / drift action result.
  action?: string;
  summary?: string;
  files?: number;
  sections?: number;
  // Common.
  elapsed_secs?: number;
  error?: string;
}

interface Row { item: Item; status: ItemStatus }

interface PendingResp { episodes: any[]; topics: any[] }
interface AnchorAudit { gaps_by_repo: Record<string, { slug: string; missing: { file: string; episode_signal: number }[] }[]> }
interface DriftList { by_repo: Record<string, { slug: string; path: string }[]> }

const POLL_MS = 3000;
const MAX_POLL_SECS = 900;

function blessReviewUrl(item: Item): string | null {
  if (item.blessKind === 'episode') {
    const m = item.path.match(/episodes\/\d{4}-\d{2}\/(.+)\.md$/);
    if (m) return `/api/episode/${m[1]}/review`;
  }
  if (item.blessKind === 'topic' && item.repo && item.slug) {
    return `/api/topic/${item.repo}/${item.slug}/review`;
  }
  return null;
}

function topicDetailHref(item: Item): string {
  if (item.kind === 'bless' && item.blessKind === 'episode') {
    const m = item.path.match(/episodes\/\d{4}-\d{2}\/(.+)\.md$/);
    if (m) return `/episodes/${m[1]}/`;
  }
  if (item.repo && item.slug) return `/repo/${item.repo}/topics/${item.slug}/`;
  return '#';
}

async function loadAll(): Promise<Item[]> {
  const [pending, anchor, drift] = await Promise.all([
    fetch('/api/review/pending').then((r) => r.ok ? r.json() as Promise<PendingResp> : { episodes: [], topics: [] }),
    fetch('/api/anchor-coverage').then((r) => r.ok ? r.json() as Promise<AnchorAudit> : { gaps_by_repo: {} }),
    fetch('/api/drift-list').then((r) => r.ok ? r.json() as Promise<DriftList> : { by_repo: {} }),
  ]);

  const out: Item[] = [];
  for (const ep of pending.episodes || []) {
    out.push({ kind: 'bless', blessKind: 'episode', path: ep.path, repo: ep.repo ?? undefined });
  }
  for (const tp of pending.topics || []) {
    out.push({ kind: 'bless', blessKind: 'topic', path: tp.path, repo: tp.repo ?? undefined, slug: tp.slug ?? undefined });
  }
  for (const [repo, gaps] of Object.entries(anchor.gaps_by_repo || {})) {
    for (const g of gaps) {
      out.push({
        kind: 'anchor', repo, slug: g.slug,
        path: `guides/${repo}/topics/${g.slug}.md`,
        detail: g.missing.slice(0, 3).map((m) => `${m.file}×${m.episode_signal}`).join(', '),
      });
    }
  }
  for (const [repo, entries] of Object.entries(drift.by_repo || {})) {
    for (const e of entries) {
      out.push({ kind: 'drift', repo, slug: e.slug, path: `guides/${repo}/topics/${e.slug}.md`, detail: e.path });
    }
  }
  return out;
}

async function jobStatusFor(item: Item): Promise<ItemStatus | null> {
  try {
    if (item.kind === 'bless') {
      const r = await fetch(`/api/job/opinion?path=${encodeURIComponent(item.path)}`);
      if (!r.ok) return null;
      const j = await r.json();
      if (j.status === 'done') {
        return {
          phase: 'done', verdict: j.verdict, reason: j.reason, confidence: j.confidence,
          applied: false, elapsed_secs: j.elapsed_secs,
        };
      }
      if (j.status === 'running') return { phase: 'running', elapsed_secs: j.elapsed_secs };
      if (j.status === 'error') return { phase: 'error', error: j.error, elapsed_secs: j.elapsed_secs };
      return null;
    }
    // anchor / drift
    if (!item.repo || !item.slug) return null;
    const r = await fetch(`/api/job/${item.kind}/${item.repo}/${item.slug}`);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.status === 'done') {
      return {
        phase: 'done', action: j.action || '?', summary: j.summary,
        files: j.files_added, sections: j.sections_changed, elapsed_secs: j.elapsed_secs,
      };
    }
    if (j.status === 'running') return { phase: 'running', elapsed_secs: j.elapsed_secs };
    if (j.status === 'error') return { phase: 'error', error: j.error, elapsed_secs: j.elapsed_secs };
  } catch { /* fall through */ }
  return null;
}

async function pollOpinion(path: string, onUpdate: (s: { elapsed_secs?: number }) => void): Promise<any> {
  const started = Date.now();
  while ((Date.now() - started) / 1000 < MAX_POLL_SECS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const r = await fetch(`/api/job/opinion?path=${encodeURIComponent(path)}`);
      if (!r.ok) continue;
      const j = await r.json();
      onUpdate({ elapsed_secs: j.elapsed_secs });
      if (j.status === 'done' || j.status === 'error') return j;
    } catch { /* transient */ }
  }
  return { status: 'error', error: 'client poll timed out (job may still be running server-side)' };
}

async function pollFixJob(kind: 'anchor' | 'drift', repo: string, slug: string, onUpdate: (s: { elapsed_secs?: number }) => void): Promise<any> {
  const started = Date.now();
  while ((Date.now() - started) / 1000 < MAX_POLL_SECS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const r = await fetch(`/api/job/${kind}/${repo}/${slug}`);
      if (!r.ok) continue;
      const j = await r.json();
      onUpdate({ elapsed_secs: j.elapsed_secs });
      if (j.status === 'done' || j.status === 'error') return j;
    } catch { /* transient */ }
  }
  return { status: 'error', error: 'client poll timed out (job may still be running server-side)' };
}

// localStorage flag set on Run, cleared on natural-completion or cancel.
// If a reload finds it still set, BulkAll auto-resumes the loop so an
// in-flight run continues serving items from wherever it was interrupted.
const ACTIVE_KEY = 'cartograph.bulkall.active';
const readActive = () => { try { return localStorage.getItem(ACTIVE_KEY) === '1'; } catch { return false; } };
const setActive = (on: boolean) => { try { on ? localStorage.setItem(ACTIVE_KEY, '1') : localStorage.removeItem(ACTIVE_KEY); } catch { /* */ } };

export default function BulkAll() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState<Record<Kind, boolean>>({ bless: true, anchor: true, drift: true });
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [requireHigh, setRequireHigh] = useState(true);
  const cancelRef = useRef(false);
  // Guard against double-running the loop if React StrictMode re-mounts.
  const loopActiveRef = useRef(false);

  // Mount: load + hydrate per-row state from job status files. If any
  // rows hydrate as 'running' or the localStorage flag says a prior run
  // is still in progress, resume the loop from the first item that
  // still needs work. This makes the run survive page reloads.
  useEffect(() => {
    (async () => {
      const list = await loadAll();
      setItems(list);
      const hydrated: Row[] = await Promise.all(list.map(async (item) => {
        const status = await jobStatusFor(item);
        return { item, status: status ?? { phase: 'pending' } };
      }));
      setRows(hydrated);

      const hasRunning = hydrated.some((r) => r.status.phase === 'running');
      if (hasRunning) {
        // Genuinely in-flight on disk — resume so we keep polling the
        // running rows and walking any remaining pending items.
        runLoop(hydrated);
      } else if (readActive()) {
        // Flag set but nothing is in flight. Either the prior loop
        // crashed before clearing the flag, or every item terminated
        // and the cleanup race lost. Don't auto-spawn — clear the flag
        // and leave the page idle. The user clicks Run on all to
        // explicitly resume pending / errored items.
        setActive(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The core loop. Takes the rows snapshot at call time so it isn't
  // sensitive to stale React state when invoked from the mount effect.
  const runLoop = async (initialRows: Row[]) => {
    if (loopActiveRef.current) return;
    loopActiveRef.current = true;
    setRunning(true);
    setDone(false);
    cancelRef.current = false;
    setActive(true);

    for (let i = 0; i < initialRows.length; i++) {
      if (cancelRef.current) break;
      const row = initialRows[i];
      if (!filter[row.item.kind]) continue;
      if (row.status.phase === 'done' && row.status.applied !== false) continue; // already-processed, skip

      if (row.item.kind === 'bless') {
        // If hydration found a prior opinion already on disk, reuse it and
        // jump straight to the apply phase — no point re-asking claude.
        let opinion: { verdict: 'approve' | 'reject'; reason: string; confidence: 'high' | 'medium' | 'low'; elapsed_secs?: number };
        if (row.status.phase === 'done' && row.status.verdict) {
          opinion = {
            verdict: row.status.verdict,
            reason: row.status.reason || '',
            confidence: row.status.confidence || 'low',
            elapsed_secs: row.status.elapsed_secs,
          };
        } else {
          setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: { phase: 'running' } } : r));
          // Phase 1: get opinion. (Duplicate-spawn guard server-side
          // prevents kicking off two; if a prior session was running
          // this POST returns 'already in progress' and we just poll.)
          try {
            await fetch('/api/review/opinion', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: row.item.path }),
            });
          } catch { /* ignore — poll will discover */ }
          const j = await pollOpinion(row.item.path, (s) => {
            setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: { phase: 'running', elapsed_secs: s.elapsed_secs } } : r));
          });
          if (j.status !== 'done') {
            setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: { phase: 'error', error: j.error || 'unknown', elapsed_secs: j.elapsed_secs } } : r));
            continue;
          }
          opinion = j as typeof opinion;
        }
        if (requireHigh && opinion.confidence === 'low') {
          setRows((prev) => prev.map((r, idx) => idx === i ? {
            ...r,
            status: { phase: 'done', verdict: opinion.verdict, reason: opinion.reason, confidence: opinion.confidence, applied: false, elapsed_secs: opinion.elapsed_secs, error: 'low confidence — deferred for manual review' }
          } : r));
          continue;
        }
        // Phase 2: apply.
        const url = blessReviewUrl(row.item);
        if (!url) {
          setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: { phase: 'done', verdict: opinion.verdict, reason: opinion.reason, confidence: opinion.confidence, applied: false, elapsed_secs: opinion.elapsed_secs, error: 'no review URL' } } : r));
          continue;
        }
        try {
          // Canonical key is `note` (singular) — both /api/episode/<slug>/review
          // and /api/topic/<r>/<s>/review read body.get('note'). Sending
          // `notes` silently rejected with HTTP 400 and revise-rejected.sh
          // never spawned (user-reported bug).
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
            setRows((prev) => prev.map((r2, idx) => idx === i ? {
              ...r2, status: { phase: 'done', verdict: opinion.verdict, reason: opinion.reason, confidence: opinion.confidence, applied: false, elapsed_secs: opinion.elapsed_secs, error: `${r.status}: ${txt.slice(0, 100)}` }
            } : r2));
          } else {
            setRows((prev) => prev.map((r2, idx) => idx === i ? {
              ...r2, status: { phase: 'done', verdict: opinion.verdict, reason: opinion.reason, confidence: opinion.confidence, applied: true, elapsed_secs: opinion.elapsed_secs }
            } : r2));
          }
        } catch (e) {
          setRows((prev) => prev.map((r2, idx) => idx === i ? {
            ...r2, status: { phase: 'done', verdict: opinion.verdict, reason: opinion.reason, confidence: opinion.confidence, applied: false, elapsed_secs: opinion.elapsed_secs, error: String(e) }
          } : r2));
        }
        continue;
      }

      // anchor / drift fix
      if (!row.item.repo || !row.item.slug) {
        setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: { phase: 'error', error: 'missing repo/slug' } } : r));
        continue;
      }
      setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: { phase: 'running' } } : r));
      try {
        await fetch(`/api/${row.item.kind}-fix`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo: row.item.repo, slug: row.item.slug }),
        });
      } catch { /* ignore */ }
      const j = await pollFixJob(row.item.kind, row.item.repo, row.item.slug, (s) => {
        setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: { phase: 'running', elapsed_secs: s.elapsed_secs } } : r));
      });
      if (j.status === 'done') {
        setRows((prev) => prev.map((r, idx) => idx === i ? {
          ...r, status: { phase: 'done', action: j.action || '?', summary: j.summary, files: j.files_added, sections: j.sections_changed, elapsed_secs: j.elapsed_secs }
        } : r));
      } else {
        setRows((prev) => prev.map((r, idx) => idx === i ? {
          ...r, status: { phase: 'error', error: j.error || 'unknown', elapsed_secs: j.elapsed_secs }
        } : r));
      }
    }

    setRunning(false);
    setDone(!cancelRef.current);
    setActive(false);
    loopActiveRef.current = false;
  };

  const runAll = () => {
    if (running || !items) return;
    runLoop(rows);
  };

  const cancelRun = async () => {
    cancelRef.current = true;
    setActive(false);
    // Actually terminate the script processes that are still running.
    // Without this, cancel only stops the client loop from POSTing the
    // NEXT spawn — the in-flight claude -p subprocesses keep burning
    // compute until they finish naturally. Hit /api/job/cancel for each
    // still-running row in parallel; the server signals the process
    // group (bash + claude together) and rewrites the status file.
    const inflight = rows.filter((r) => r.status.phase === 'running');
    await Promise.all(inflight.map((r) => {
      const body: any = { kind: r.item.kind === 'bless' ? 'opinion' : r.item.kind };
      if (r.item.kind === 'bless') body.path = r.item.path;
      else { body.repo = r.item.repo; body.slug = r.item.slug; }
      return fetch('/api/job/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => null);
    }));
    // Mark rows visually so the user sees the cancel landed even if the
    // server poll hasn't caught up yet.
    setRows((prev) => prev.map((r) => r.status.phase === 'running' ? { ...r, status: { phase: 'error', error: 'cancelled' } } : r));
  };

  if (items === null) return <p className="text-sm text-muted p-4">loading…</p>;
  if (items.length === 0) {
    return <p className="text-sm text-muted p-4">Nothing flagged across bless / anchor / drift. 🎉</p>;
  }

  // A row is "settled" once claude has produced a terminal outcome we
  // shouldn't keep parking in the queue: anchored / revised / bumped-only
  // (the work landed) or no-op (false positive, discarded). Bless rows
  // that were applied also count. Settled rows are hidden from the
  // visible list and roll into the 'cleared' tally.
  const isSettled = (r: Row): boolean => {
    if (r.status.phase !== 'done') return false;
    if (r.item.kind === 'bless') return r.status.applied === true;
    return r.status.action === 'anchored' || r.status.action === 'revised'
        || r.status.action === 'bumped-only' || r.status.action === 'no-op';
  };

  const settled = rows.filter(isSettled);
  const visible = rows.filter((r) => filter[r.item.kind] && !isSettled(r));
  const counts: Record<Kind, number> = { bless: 0, anchor: 0, drift: 0 };
  for (const r of rows) {
    if (!isSettled(r)) counts[r.item.kind]++;
  }

  const tally = { fixed: 0, deferred: 0, errored: 0, discarded: 0 };
  for (const r of rows) {
    if (r.status.phase === 'done') {
      if (r.status.action === 'no-op') tally.discarded++;
      else if (r.status.applied === false) tally.deferred++;
      else tally.fixed++;
    } else if (r.status.phase === 'error') tally.errored++;
  }
  const progress = rows.filter((r) => r.status.phase !== 'pending').length;

  const kindBadge = (k: Kind) => {
    if (k === 'bless') return { label: 'bless', cls: 'bg-[var(--accent)] text-[var(--accent-fg)]' };
    if (k === 'anchor') return { label: 'anchor', cls: 'bg-[var(--warn)] text-bg' };
    return { label: 'drift', cls: 'bg-[var(--danger)] text-bg' };
  };

  return (
    <div>
      <div className="px-4 py-3 border-b-2 border-border bg-[var(--surface-1)]">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          {!running && !done && (
            <button
              type="button"
              onClick={runAll}
              className="px-4 py-2 font-mono text-sm bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90"
            >▶ Run on all {visible.length} items — claude decides + acts per type</button>
          )}
          {running && (
            <>
              <span className="font-mono text-sm text-fg">running… {progress} / {visible.length}</span>
              <button
                type="button"
                onClick={cancelRun}
                className="px-3 py-1 font-mono text-xs border-2 border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger)] hover:text-bg"
              >⏸ cancel</button>
            </>
          )}
          {done && (
            <>
              <span className="font-mono text-sm text-[var(--ok)]">✓ run complete</span>
              <button type="button" onClick={() => window.location.reload()} className="px-3 py-1 font-mono text-xs border-2 border-border hover:bg-[var(--surface-1)]">reload</button>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-4 font-mono text-xs mb-2">
          <span className="text-muted uppercase tracking-widest text-[10px]">include</span>
          {(['bless', 'anchor', 'drift'] as Kind[]).map((k) => {
            const b = kindBadge(k);
            return (
              <label key={k} className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={filter[k]} onChange={(e) => setFilter((f) => ({ ...f, [k]: e.target.checked }))} disabled={running} />
                <span className={`px-1.5 py-0.5 ${b.cls}`}>{b.label}</span>
                <span className="text-muted">{counts[k]}</span>
              </label>
            );
          })}
          <label className="flex items-center gap-1.5 cursor-pointer ml-4">
            <input type="checkbox" checked={requireHigh} onChange={(e) => setRequireHigh(e.target.checked)} disabled={running} />
            <span className="text-muted">defer low-confidence bless verdicts</span>
          </label>
        </div>

        {(progress > 0 || done || settled.length > 0) && (
          <div className="font-mono text-xs flex flex-wrap gap-4">
            <span className="text-[var(--ok)]">✓ fixed/applied: {tally.fixed}</span>
            <span className="text-muted">🗑 discarded (no-op): {tally.discarded}</span>
            {tally.deferred > 0 && <span className="text-muted">⊘ deferred: {tally.deferred}</span>}
            {tally.errored > 0 && <span className="text-[var(--danger)]">⚠ errored: {tally.errored}</span>}
            {settled.length > 0 && <span className="text-muted">· {settled.length} cleared from queue</span>}
          </div>
        )}

        <p className="mt-2 font-mono text-[10px] text-muted leading-snug max-w-3xl">
          Bless → /api/review/opinion + apply via /api/{`{episode|topic}`}/review.
          Anchor → /api/anchor-fix. Drift → /api/drift-fix. All async; per-row
          state survives reloads (read from .cartograph/jobs/*.json).
        </p>
      </div>

      <ul className="divide-y divide-[var(--border-soft)] max-h-[70vh] overflow-y-auto">
        {visible.map((row, i) => {
          const s = row.status;
          const b = kindBadge(row.item.kind);
          const elapsed = s.elapsed_secs;
          let label = '·';
          let cls = 'text-muted';
          if (s.phase === 'running') {
            label = `claude is working…${elapsed ? ` (${elapsed}s)` : ''}`;
            cls = 'text-[var(--accent)]';
          } else if (s.phase === 'error') {
            label = `error: ${s.error}`;
            cls = 'text-[var(--danger)]';
          } else if (s.phase === 'done') {
            if (row.item.kind === 'bless') {
              if (s.applied && s.verdict === 'approve') { label = `✓ approved (${s.confidence})`; cls = 'text-[var(--ok)]'; }
              else if (s.applied && s.verdict === 'reject') { label = `✗ rejected → fix queued`; cls = 'text-[var(--warn)]'; }
              else { label = `${s.verdict} (${s.confidence}) — not applied`; cls = 'text-muted'; }
            } else {
              if (s.action === 'no-op') { label = '⊘ no-op'; cls = 'text-muted'; }
              else { label = `✓ ${s.action}${s.files !== undefined ? ` · ${s.files} anchors` : ''}${s.sections !== undefined ? ` · ${s.sections} sections` : ''}`; cls = 'text-[var(--ok)]'; }
            }
            if (elapsed !== undefined) label += ` · ${elapsed}s`;
          }
          return (
            <li key={`${row.item.kind}-${row.item.path}`}>
              <div className={`px-3 py-1.5 flex items-baseline gap-3 font-mono text-[11px] ${rows.indexOf(row) % 2 === 0 ? 'bg-bg' : 'bg-[var(--surface-1)]'}`}>
                <span className={`px-1.5 py-0.5 font-mono text-[10px] ${b.cls} w-14 text-center`}>{b.label}</span>
                {row.item.repo && <span className="text-accent w-14">{row.item.repo}</span>}
                <a href={topicDetailHref(row.item)} className="flex-1 min-w-0 truncate text-fg hover:text-accent">
                  {row.item.slug ?? row.item.path}
                </a>
                <span className={`${cls} whitespace-nowrap`}>{label}</span>
              </div>
              {(s.summary || s.reason) && s.phase === 'done' && (
                <div className="px-3 pb-1.5 text-[10px] text-muted ml-20 max-w-3xl">{s.summary ?? s.reason}</div>
              )}
              {row.item.detail && s.phase === 'pending' && (
                <div className="px-3 pb-1.5 text-[10px] text-muted ml-20">{row.item.detail}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
