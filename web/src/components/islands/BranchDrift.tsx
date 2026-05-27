// BranchDrift — F3. Surfaces "you have N branches behind main" on
// per-repo pages so the human knows the cascade needs attention without
// opening the stack view.

import { useEffect, useState } from 'react';

interface Branch {
  name: string;
  parent: string;
  commits_behind_main: number;
  commits_behind_parent: number;
  pr: { state: string } | null;
}

interface Stack {
  default_branch: string;
  head: string | null;
  branches: Branch[];
}

export default function BranchDrift({ repo }: { repo: string }) {
  const [data, setData] = useState<Stack | null>(null);

  useEffect(() => {
    fetch(`/api/stack/${repo}`)
      .then((r) => r.ok ? r.json() : null)
      .then((j) => setData(j))
      .catch(() => setData(null));
  }, [repo]);

  if (!data) return null;
  if (data.branches.length === 0) return null;

  const stale = data.branches.filter((b) => b.commits_behind_main > 0 || b.commits_behind_parent > 0);
  const open = data.branches.filter((b) => b.pr && b.pr.state === 'OPEN').length;

  if (stale.length === 0 && open === 0) return null;

  return (
    <div class="flex flex-wrap items-center gap-3 px-3 py-2 border-2 border-[var(--border-soft)] bg-[var(--surface-1)] font-mono text-xs mb-3">
      <span className="text-muted uppercase tracking-widest text-[10px]">branches</span>
      <span>
        <span className="text-fg">{data.branches.length}</span>
        <span className="text-muted"> local</span>
      </span>
      {open > 0 && (
        <span>
          <span className="text-[var(--accent)]">{open}</span>
          <span className="text-muted"> PR{open === 1 ? '' : 's'} open</span>
        </span>
      )}
      {stale.length > 0 && (
        <span className="text-[var(--warn)]">
          {stale.length} cascade-rebase needed
        </span>
      )}
      <a href={`/repo/${repo}/stack/`} className="text-accent hover:underline ml-auto">stack view ↗</a>
    </div>
  );
}
