// AnchorCoverageCallout — surface anchor-coverage gaps inline on the
// affected topic page. Mirrors DriftCallout's chrome but reads from
// /api/anchor-coverage. Closes the loop on the audit shipped in
// commit 4883a8b — `/queue` already lists the gaps; this island brings
// the warning to the topic itself, where the agent reading the note
// can act on it without hunting through /queue.

import { useEffect, useState } from 'react';
import FixWithClaude from './FixWithClaude';

interface Missing { file: string; episode_signal: number }
interface Gap { topic_path: string; slug: string; anchored_count: number; missing: Missing[] }
interface Audit { gaps_by_repo: Record<string, Gap[]> }

export default function AnchorCoverageCallout({ repo, slug }: { repo: string; slug: string }) {
  const [gap, setGap] = useState<Gap | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch('/api/anchor-coverage')
      .then((r) => r.ok ? r.json() : null)
      .then((j: Audit | null) => {
        if (!j) return;
        const list = j.gaps_by_repo?.[repo] ?? [];
        const match = list.find((g) => g.slug === slug);
        if (match) setGap(match);
      })
      .catch(() => {});
  }, [repo, slug]);

  if (!gap) return null;

  return (
    <div className="border-2 border-[var(--warn)] bg-bg mb-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-4 py-3 flex items-center justify-between gap-3 hover:bg-[var(--surface-1)] cursor-pointer"
      >
        <span>
          <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--warn)]">
            anchor coverage
          </span>
          <span className="ml-3 text-sm text-fg">
            {gap.missing.length} canonical file{gap.missing.length === 1 ? '' : 's'} cited by related episodes but not anchored here
          </span>
        </span>
        <span className="font-mono text-xs text-muted">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-4 py-3 border-t-2 border-[var(--warn)]">
          <p className="text-sm text-muted mb-3 max-w-3xl">
            Episodes related to this topic (via tag-token overlap) touched the files below, but
            this topic note doesn't anchor any of them with <code>path:NNN</code>. Adding anchors
            makes the file discoverable via <code>/whatknows</code> in future sessions and tightens
            the citation graph.
          </p>
          <ul className="font-mono text-xs space-y-1 mb-3">
            {gap.missing.map((m) => (
              <li key={m.file} className="flex justify-between gap-3 max-w-md">
                <code className="text-fg">{m.file}</code>
                <span className="text-muted">×{m.episode_signal} episode{m.episode_signal === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
          <FixWithClaude kind="anchor" repo={repo} slug={slug} />
        </div>
      )}
    </div>
  );
}
