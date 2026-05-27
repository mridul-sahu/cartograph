// PromoteCandidates — tags with ≥3 undistilled episodes ready for /promote.
//
// Sourced from /api/promote-candidates. Row layout matches BulkAll's
// per-row rhythm so the console feels uniform across surfaces.

import { useEffect, useState } from 'react';

interface Candidate {
  tag: string;
  episode_count: number;
  episode_slugs: string[];
}

type RunState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; topic_path?: string }
  | { phase: 'error'; error: string };

export default function PromoteCandidates() {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runState, setRunState] = useState<Record<string, RunState>>({});

  const load = async () => {
    try {
      const r = await fetch('/api/promote-candidates');
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j = await r.json();
      setCandidates(j.candidates || []);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => { load(); }, []);

  const promote = async (tag: string) => {
    setRunState((s) => ({ ...s, [tag]: { phase: 'running' } }));
    try {
      const r = await fetch(`/api/promote/${encodeURIComponent(tag)}`, { method: 'POST' });
      // The endpoint returns 5xx when promote-tag.sh failed in any way
      // (claude exited 0 but didn't write, no source-episode stamping,
      // bash 3.2 incompatibility, etc.). Surface the detail so we don't
      // silently claim 'topic drafted' on a no-op.
      if (!r.ok) {
        let detail = `${r.status}`;
        try {
          const j = await r.json();
          if (j && j.detail) detail = `${r.status}: ${String(j.detail).slice(0, 300)}`;
        } catch { /* fall through to status-only */ }
        setRunState((s) => ({ ...s, [tag]: { phase: 'error', error: detail } }));
        return;
      }
      const j = await r.json();
      // Defense in depth: even on HTTP 200, only declare success if the
      // server actually said ok:true. (Older clients might be talking to
      // an old endpoint that returned 200 with ok:false.)
      if (j && j.ok === false) {
        setRunState((s) => ({ ...s, [tag]: { phase: 'error', error: `script exit ${j.exit_code ?? '?'}: ${(j.stderr || j.stdout || '').slice(0, 300)}` } }));
        return;
      }
      setRunState((s) => ({ ...s, [tag]: { phase: 'done', topic_path: j.topic_path } }));
      load();
    } catch (e) {
      setRunState((s) => ({ ...s, [tag]: { phase: 'error', error: String(e) } }));
    }
  };

  if (error) return <p className="px-4 py-3 font-mono text-xs text-[var(--danger)]">unavailable: {error}</p>;
  if (candidates === null) return <p className="px-4 py-3 font-mono text-xs text-muted">loading…</p>;
  if (candidates.length === 0) {
    return (
      <p className="px-4 py-3 font-mono text-xs text-muted">
        Nothing to promote — every tag with ≥3 episodes is already distilled.
      </p>
    );
  }

  return (
    <div>
      <div className="px-4 py-2 border-b-2 border-border bg-[var(--surface-1)] font-mono text-[10px] text-muted leading-snug">
        <div><strong>Rule:</strong> tag has ≥3 episodes where <code>distilled_into:</code> is unset (threshold from <code>CARTOGRAPH_AUTO_PROMOTE_EPISODES</code>, default 3). Any tag on an undistilled episode counts; an episode tagged with both <code>orbax</code> and <code>jax</code> contributes to both buckets.</div>
        <div className="mt-1"><strong>Auto:</strong> <code>scripts/auto-promote.sh</code> already runs this at every <code>SessionStart</code> and fires <code>promote-tag.sh</code> in the background — that's why this list is usually short. The button below is a safety net for when the hook didn't fire (workspace-fork session, stuck lock in <code>.auto-promote-locks/</code>, or you crossed ≥3 mid-session and don't want to wait).</div>
        <div className="mt-1"><strong>Effect:</strong> claude reads sources, drafts <code>guides/&lt;repo&gt;/topics/&lt;tag&gt;.md</code>, stamps <code>distilled_into:</code> on each source. New topic lands on <a href="/console/review/" className="text-accent hover:underline">/console/review/</a> as unblessed.</div>
      </div>
      <ul className="divide-y divide-[var(--border-soft)]">
        {candidates.map((c, i) => {
          const rs = runState[c.tag] || { phase: 'idle' as const };
          const elapsed = rs.phase === 'running' ? '…' : '';
          // Compact each slug to something distinguishable. The common
          // pattern is `<date>-from-session-<date>-<HHMMSS>-<repo>`; keep
          // the session HH:MM:SS so four cartograph-session episodes
          // don't all render as the indistinguishable string 'cartograph'.
          const compact = (slug: string): string => {
            const m = slug.match(/^\d{4}-\d{2}-\d{2}-from-session-\d{4}-\d{2}-\d{2}-(\d{2})(\d{2})(\d{2})-(.+)$/);
            if (m) return `${m[1]}:${m[2]}:${m[3]} ${m[4]}`;
            return slug.replace(/^\d{4}-\d{2}-\d{2}-/, '');
          };
          return (
            <li key={c.tag}>
              <div className={`px-3 py-1.5 flex items-baseline gap-3 font-mono text-[11px] ${i % 2 === 0 ? 'bg-bg' : 'bg-[var(--surface-1)]'}`}>
                <span className="px-1.5 py-0.5 font-mono text-[10px] bg-[var(--accent)] text-[var(--accent-fg)] w-16 text-center">promote</span>
                <span className="text-fg font-bold min-w-0 flex-shrink-0">{c.tag}</span>
                <span className="text-muted whitespace-nowrap flex-shrink-0">{c.episode_count} episodes</span>
                <span className="flex-1" />
                {rs.phase === 'idle' && (
                  <button
                    type="button"
                    onClick={() => promote(c.tag)}
                    className="px-2.5 py-0.5 font-mono text-[10px] bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90"
                  >▶ promote → topic</button>
                )}
                {rs.phase === 'running' && (
                  <span className="text-[var(--accent)] whitespace-nowrap">claude is drafting{elapsed}</span>
                )}
                {rs.phase === 'done' && (
                  <span className="text-[var(--ok)] whitespace-nowrap">✓ topic drafted{rs.topic_path ? ` · ${rs.topic_path.replace(/^guides\/[^/]+\/topics\//, '').replace(/\.md$/, '')}` : ''}</span>
                )}
                {rs.phase === 'error' && (
                  <span className="text-[var(--danger)] whitespace-nowrap truncate max-w-md">error: {rs.error}</span>
                )}
              </div>
              {c.episode_slugs.length > 0 && (
                <ul className={`border-t border-[var(--border-soft)] ${i % 2 === 0 ? 'bg-bg' : 'bg-[var(--surface-1)]'}`}>
                  {c.episode_slugs.map((slug, j) => (
                    <li key={slug} className="border-b border-[var(--border-soft)] last:border-b-0">
                      <a
                        href={`/episodes/${slug}/`}
                        className="block px-3 py-1 pl-20 font-mono text-[10px] text-muted hover:bg-[var(--surface-2)] hover:text-accent no-underline flex items-baseline gap-3"
                      >
                        <span className="text-muted opacity-60">{j + 1}.</span>
                        <span className="text-fg">{compact(slug)}</span>
                        <span className="ml-auto opacity-40">↗</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
