// PromoteCandidates — tags with ≥3 undistilled episodes ready for /promote.
//
// Read-only: sourced from /api/promote-candidates. Promotion itself is
// in-session work — each row shows the slash command to run.

import { useEffect, useState } from 'react';

interface Candidate {
  tag: string;
  episode_count: number;
  episode_slugs: string[];
}

export default function PromoteCandidates() {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        <div><strong>Rule:</strong> tag has ≥3 episodes not yet distilled under it (threshold from <code>CARTOGRAPH_PROMOTE_THRESHOLD</code>). An episode distilled into one topic still counts toward its other tags, so multi-tag episodes keep their signal.</div>
        <div className="mt-1"><strong>Automatic:</strong> the next session in the tag's repo distills these itself (the digest and the post-edit signal carry a binding contract). This card is visibility, not a to-do list; nothing fires in the background.</div>
        <div className="mt-1"><strong>Effect:</strong> <code>/promote</code> reads the sources, drafts <code>guides/&lt;repo&gt;/topics/&lt;tag&gt;.md</code>, stamps <code>distilled_into:</code> on each source. New topic lands on <a href="/console/review/" className="text-accent hover:underline">/console/review/</a> as unblessed.</div>
      </div>
      <ul className="divide-y divide-[var(--border-soft)]">
        {candidates.map((c, i) => {
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
                <code className="px-2.5 py-0.5 font-mono text-[10px] border border-[var(--accent)] text-[var(--accent)] whitespace-nowrap">
                  /promote {c.tag}
                </code>
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
