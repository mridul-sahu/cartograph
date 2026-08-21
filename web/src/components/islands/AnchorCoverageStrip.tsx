// AnchorCoverageStrip — per-repo summary of anchor-coverage gaps.
// Mirrors the BranchDrift strip shape on /repo/<r>/.
// Reads /api/anchor-coverage (audit), filters by repo, renders a
// one-line summary with deep links to the affected topic notes.

import { useEffect, useState } from 'react';

interface Missing { file: string; episode_signal: number }
interface Gap { topic_path: string; slug: string; anchored_count: number; missing: Missing[] }
interface Audit { gaps_by_repo: Record<string, Gap[]> }

export default function AnchorCoverageStrip({ repo }: { repo: string }) {
  const [gaps, setGaps] = useState<Gap[] | null>(null);

  useEffect(() => {
    fetch('/api/anchor-coverage')
      .then((r) => r.ok ? r.json() : null)
      .then((j: Audit | null) => {
        setGaps(j?.gaps_by_repo?.[repo] ?? []);
      })
      .catch(() => setGaps([]));
  }, [repo]);

  if (gaps === null || gaps.length === 0) return null;

  const totalMissing = gaps.reduce((acc, g) => acc + g.missing.length, 0);

  return (
    <details className="border-2 border-[var(--warn)] bg-bg mb-4">
      <summary className="cursor-pointer px-4 py-2 font-mono text-xs flex items-center justify-between hover:bg-[var(--surface-1)]">
        <span>
          <span className="text-[var(--warn)] uppercase tracking-widest text-[10px] mr-2">anchor coverage</span>
          <span className="text-fg">
            {gaps.length} topic{gaps.length === 1 ? '' : 's'} missing canonical anchors
          </span>
          <span className="text-muted ml-2">· {totalMissing} file{totalMissing === 1 ? '' : 's'} total</span>
        </span>
        <span className="text-muted">expand ▾</span>
      </summary>
      <ul className="divide-y divide-[var(--border-soft)] border-t-2 border-[var(--warn)]">
        {gaps.map((g) => (
          <li key={g.slug} className="px-4 py-2 font-mono text-xs flex items-center justify-between gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <a href={`/repo/${repo}/topics/${g.slug}/`} className="text-accent hover:underline">
                {g.slug}
              </a>
              <span className="text-muted ml-2">
                missing: {g.missing.slice(0, 4).map((m) => `${m.file}×${m.episode_signal}`).join(', ')}
                {g.missing.length > 4 && ` +${g.missing.length - 4} more`}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="px-4 py-2 border-t border-[var(--border-soft)] font-mono text-[10px] text-muted flex items-center justify-between">
        <span>Or open <a href="/console/review/" className="text-accent hover:underline">/console/review/</a> to batch-fix.</span>
      </div>
    </details>
  );
}
