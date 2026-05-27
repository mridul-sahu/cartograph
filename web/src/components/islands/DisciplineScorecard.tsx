// DisciplineScorecard — the §1a + §4 visibility surface on /console/.
//
// Pulls /api/discipline (last 5 sessions). Shows two things:
//   1. Standing obligations  — auto-drafts to bless, topics to revise
//   2. Per-session table     — edits / whatknows / cited-file edits
//
// The point isn't to shame the agent — it's to make the discipline
// gap visible so the next session can close it. A session row with
// 11 cited-file edits and 0 /whatknows calls is the exact pattern
// that caused the 2026-05-26 benchmark-sibling-drift incident.

import { useEffect, useState } from 'react';

interface SessionRow {
  slug: string;
  date: string | null;
  path: string;
  edits: number;
  reads: number;
  workspace_reads: number;
  cited_file_edits: number;
  whatknows_calls: number;
}

interface Standing {
  unblessed_auto_drafts: number;
  revisions_pending: number;
}

interface Payload {
  sessions: SessionRow[];
  standing: Standing;
}

export default function DisciplineScorecard() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/discipline?limit=5')
      .then((r) => r.ok ? r.json() : Promise.reject(`${r.status}`))
      .then((j: Payload) => { if (!cancelled) setData(j); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <p className="px-4 py-3 font-mono text-xs text-[var(--danger)]">unavailable: {error}</p>;
  if (!data) return <p className="px-4 py-3 font-mono text-xs text-muted">loading…</p>;

  const { sessions, standing } = data;

  return (
    <div>
      <div className="px-4 py-3 border-b-2 border-border bg-[var(--surface-1)] font-mono text-[10px] text-muted leading-snug space-y-1">
        <div><strong>§1a:</strong> /whatknows before any workspace Read or Edit. The reverse-index already documents the file — re-deriving from upstream is the defect.</div>
        <div><strong>§4:</strong> when an edit lands on cited code, the citing topic must be revised in the same change set. Post-edit hook flags drift; this card shows the queue.</div>
      </div>

      <div className="px-4 py-3 border-b-2 border-border flex flex-wrap items-baseline gap-x-6 gap-y-2 font-mono text-xs">
        <span className="text-muted uppercase tracking-widest text-[10px]">standing obligations</span>
        <span>
          <span className={standing.unblessed_auto_drafts > 0 ? 'text-[var(--warn)]' : 'text-[var(--ok)]'}>
            {standing.unblessed_auto_drafts > 0 ? '⚠' : '✓'} unblessed auto-drafts: {standing.unblessed_auto_drafts}
          </span>
          {standing.unblessed_auto_drafts > 0 && (
            <a href="/console/review/" className="ml-2 text-accent hover:underline">review →</a>
          )}
        </span>
        <span>
          <span className={standing.revisions_pending > 0 ? 'text-[var(--warn)]' : 'text-[var(--ok)]'}>
            {standing.revisions_pending > 0 ? '⚠' : '✓'} topics needing revision: {standing.revisions_pending}
          </span>
          {standing.revisions_pending > 0 && (
            <a href="/console/" className="ml-2 text-accent hover:underline">queue ↑</a>
          )}
        </span>
      </div>

      {sessions.length === 0 ? (
        <p className="px-4 py-3 font-mono text-xs text-muted">No session logs yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-xs">
            <thead className="bg-[var(--surface-1)]">
              <tr className="border-b-2 border-border">
                <th className="text-left px-3 py-2 text-muted uppercase tracking-widest text-[10px]">session</th>
                <th className="text-right px-3 py-2 text-muted uppercase tracking-widest text-[10px]">edits</th>
                <th className="text-right px-3 py-2 text-muted uppercase tracking-widest text-[10px]" title="Edits where the target file is cited by ≥1 cartograph note">cited-file edits</th>
                <th className="text-right px-3 py-2 text-muted uppercase tracking-widest text-[10px]">workspace reads</th>
                <th className="text-right px-3 py-2 text-muted uppercase tracking-widest text-[10px]" title="/whatknows or /api/whatknows invocations">/whatknows</th>
                <th className="text-right px-3 py-2 text-muted uppercase tracking-widest text-[10px]">verdict</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s, i) => {
                // A session "violated §1a" if it edited cited files but
                // never invoked /whatknows. The Read-side hook injects
                // automatically on workspace Read, so a session with
                // workspace_reads > 0 and whatknows == 0 isn't strictly
                // a violation — but cited-file edits without /whatknows
                // is the load-bearing signal.
                const violated = s.cited_file_edits > 0 && s.whatknows_calls === 0;
                const verdict = violated ? '✗ §1a' : (s.cited_file_edits > 0 ? '✓' : '·');
                const verdictCls = violated ? 'text-[var(--danger)]' : (s.cited_file_edits > 0 ? 'text-[var(--ok)]' : 'text-muted');
                return (
                  <tr key={s.slug} className={i % 2 === 0 ? 'bg-bg' : 'bg-[var(--surface-1)]'}>
                    <td className="px-3 py-1.5 truncate max-w-md">
                      <a href={`/sessions/${s.slug}/`} className="text-accent hover:underline">{s.slug}</a>
                    </td>
                    <td className="px-3 py-1.5 text-right text-fg">{s.edits}</td>
                    <td className={`px-3 py-1.5 text-right ${s.cited_file_edits > 0 ? 'text-fg' : 'text-muted'}`}>{s.cited_file_edits}</td>
                    <td className="px-3 py-1.5 text-right text-muted">{s.workspace_reads}</td>
                    <td className={`px-3 py-1.5 text-right ${s.whatknows_calls === 0 && s.cited_file_edits > 0 ? 'text-[var(--danger)]' : 'text-fg'}`}>{s.whatknows_calls}</td>
                    <td className={`px-3 py-1.5 text-right ${verdictCls}`}>{verdict}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
