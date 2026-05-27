// DriftCallout — fetches the per-topic drift report markdown if one exists
// for this (repo, slug), and renders it as a callout above the article.
// Closes R2 (diff-aware revise view) from the UI audit.

import { useEffect, useState } from 'react';
import FixWithClaude from './FixWithClaude';

export default function DriftCallout({ repo, slug }: { repo: string; slug: string }) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [present, setPresent] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch(`/api/topic-drift/${repo}/${slug}`)
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (j?.present) {
          setPresent(true);
          setMarkdown(j.markdown ?? '');
        } else {
          setPresent(false);
        }
      })
      .catch(() => setPresent(false));
  }, [repo, slug]);

  if (!present) return null;

  return (
    <div className="border-2 border-[var(--warn)] bg-bg mb-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-4 py-3 flex items-center justify-between gap-3 hover:bg-[var(--surface-1)] cursor-pointer"
      >
        <span>
          <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--warn)]">drift open</span>
          <span className="ml-3 text-sm text-fg">
            cited files have changed since this topic was last revised — citations may be stale
          </span>
        </span>
        <span className="font-mono text-xs text-muted">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <pre className="px-4 py-3 border-t-2 border-[var(--warn)] font-mono text-[11px] leading-relaxed overflow-x-auto whitespace-pre-wrap">{markdown}</pre>
      )}
      <div className="px-4 py-2 border-t border-[var(--border-soft)] flex items-center justify-between gap-3 flex-wrap">
        <span className="font-mono text-[10px] text-muted">
          Or run <code>/revise {slug}</code> in a workspace Claude session.
        </span>
        <FixWithClaude kind="drift" repo={repo} slug={slug} compact />
      </div>
    </div>
  );
}
