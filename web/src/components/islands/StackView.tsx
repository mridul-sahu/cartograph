// StackView — live render of /api/stack/<repo>.
// Auto-discovers every local branch in the fork and lays out the stack
// tree, with PR state + cascade hints. Per claude-designs/cartograph/ui-audit-2026-05-25/ F1.

import { useEffect, useState } from 'react';

interface PR {
  number: number;
  title: string;
  state: string; // OPEN | CLOSED | MERGED
  isDraft: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  mergeable?: string;
  reviewDecision?: string;
}

interface Branch {
  name: string;
  committed_at: string;
  sha: string;
  parent: string;
  commits_ahead_of_parent: number;
  commits_behind_parent: number;
  commits_ahead_of_main: number;
  commits_behind_main: number;
  pr: PR | null;
  children: Branch[];
}

interface StackResponse {
  repo: string;
  default_branch: string;
  upstream_slug: string | null;
  fork_slug: string | null;
  head: string | null;
  branches: Branch[];
  stacks: Branch[];
}

// GitHub compare URL for a branch against a given base ref.
// `<fork-owner>:<ref>` lets the upstream compare page resolve refs that only
// live on the fork. Pass `baseRef` as the bare default branch name (e.g.
// "main") to compare against upstream, or as "<owner>:<branch>" to compare
// against a fork-side ref.
function compareUrl(b: Branch, data: StackResponse, baseRef: string): string | null {
  if (!data.upstream_slug || !data.fork_slug) return null;
  const forkOwner = data.fork_slug.split('/')[0];
  return `https://github.com/${data.upstream_slug}/compare/${baseRef}...${forkOwner}:${b.name}`;
}

// Parent-relative diff — matches what a PR reviewer would see in a stacked PR.
function diffUrl(b: Branch, data: StackResponse): string | null {
  if (!data.fork_slug) return null;
  const forkOwner = data.fork_slug.split('/')[0];
  const base = b.parent === data.default_branch ? b.parent : `${forkOwner}:${b.parent}`;
  return compareUrl(b, data, base);
}

// Cumulative diff against upstream default branch — bundles all ancestor
// commits for a stacked branch.
function vsMainUrl(b: Branch, data: StackResponse): string | null {
  return compareUrl(b, data, data.default_branch);
}

function prChip(pr: PR | null) {
  if (!pr) return { label: 'no PR', cls: 'bg-[var(--surface-1)] text-muted' };
  if (pr.state === 'MERGED') return { label: `#${pr.number} merged`, cls: 'bg-[var(--ok)] text-bg' };
  if (pr.state === 'CLOSED') return { label: `#${pr.number} closed`, cls: 'bg-[var(--danger)] text-bg' };
  if (pr.isDraft) return { label: `#${pr.number} draft`, cls: 'bg-[var(--surface-1)] text-fg border-2 border-border' };
  if (pr.reviewDecision === 'APPROVED') return { label: `#${pr.number} approved`, cls: 'bg-[var(--ok)] text-bg' };
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { label: `#${pr.number} changes`, cls: 'bg-[var(--warn)] text-bg' };
  return { label: `#${pr.number} open`, cls: 'bg-[var(--accent)] text-[var(--accent-fg)]' };
}

function cascadeStatus(b: Branch, head: string | null) {
  if (b.commits_behind_main > 0) {
    return { label: `${b.commits_behind_main} behind main`, tone: 'warn' as const };
  }
  if (b.commits_behind_parent > 0) {
    return { label: `${b.commits_behind_parent} behind ${b.parent}`, tone: 'warn' as const };
  }
  if (b.commits_ahead_of_parent === 0 && b.pr?.state !== 'MERGED') {
    return { label: 'no commits', tone: 'muted' as const };
  }
  return { label: 'on parent', tone: 'ok' as const };
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function BranchRow({ branch, data, depth }: { branch: Branch; data: StackResponse; depth: number }) {
  const chip = prChip(branch.pr);
  const cascade = cascadeStatus(branch, data.head);
  const isHead = data.head === branch.name;
  const cascadeCls =
    cascade.tone === 'warn' ? 'text-[var(--warn)]'
    : cascade.tone === 'muted' ? 'text-muted'
    : 'text-[var(--ok)]';
  const diff = diffUrl(branch, data);
  const vsMain = vsMainUrl(branch, data);
  const diffTitle = branch.parent === data.default_branch
    ? `Compare ${branch.name} vs ${data.default_branch} on GitHub`
    : `Compare ${branch.name} vs ${branch.parent} on GitHub (PR-equivalent diff)`;
  const vsMainTitle = `Compare ${branch.name} vs upstream ${data.default_branch} on GitHub (cumulative — includes ancestor branches)`;
  return (
    <>
      <li className={`flex items-center gap-3 px-3 py-2 hover:bg-[var(--surface-2)] ${isHead ? 'bg-[var(--surface-1)]' : ''}`}>
        <span className="font-mono text-xs text-muted" style={{ paddingLeft: `${depth * 1.25}rem` }}>
          {depth === 0 ? '●' : '└─'}
        </span>
        <span className="font-mono text-sm text-fg flex-1 min-w-0 truncate">
          {isHead && <span className="text-accent mr-1">★</span>}
          {branch.name}
        </span>
        <span className={`font-mono text-[10px] px-1.5 py-0.5 ${chip.cls}`}>
          {chip.label}
        </span>
        <span className={`font-mono text-[10px] ${cascadeCls} whitespace-nowrap w-32 text-right`}>
          {cascade.label}
        </span>
        <span className="font-mono text-[10px] text-muted whitespace-nowrap w-12 text-right">
          {branch.commits_ahead_of_parent > 0 && `+${branch.commits_ahead_of_parent}`}
        </span>
        <span className="font-mono text-[10px] text-muted whitespace-nowrap w-12 text-right">
          {timeAgo(branch.committed_at)}
        </span>
        {vsMain ? (
          <a
            href={vsMain}
            target="_blank"
            rel="noopener noreferrer"
            title={vsMainTitle}
            className="font-mono text-[10px] text-muted hover:text-accent hover:underline w-16 text-right"
          >vs main↗</a>
        ) : (
          <span className="w-16"></span>
        )}
        {diff ? (
          <a
            href={diff}
            target="_blank"
            rel="noopener noreferrer"
            title={diffTitle}
            className="font-mono text-[10px] text-muted hover:text-accent hover:underline w-14 text-right"
          >diff↗</a>
        ) : (
          <span className="w-14"></span>
        )}
        {branch.pr ? (
          <a
            href={branch.pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[10px] text-accent hover:underline w-10 text-right"
          >PR↗</a>
        ) : (
          <span className="w-10"></span>
        )}
      </li>
      {branch.children.map((c) => (
        <BranchRow key={c.name} branch={c} data={data} depth={depth + 1} />
      ))}
    </>
  );
}

interface RestackResult {
  ok: boolean;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export default function StackView({ repo }: { repo: string }) {
  const [data, setData] = useState<StackResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCascade, setShowCascade] = useState(false);
  const [restacking, setRestacking] = useState(false);
  const [restackResult, setRestackResult] = useState<RestackResult | null>(null);

  const runCascade = async () => {
    if (restacking) return;
    setRestacking(true);
    setRestackResult(null);
    try {
      const r = await fetch(`/api/stack/${repo}/restack`, { method: 'POST' });
      const j = (await r.json()) as RestackResult;
      setRestackResult(j);
      if (j.ok) {
        // Refresh the stack tree so the new shape shows.
        const r2 = await fetch(`/api/stack/${repo}`);
        if (r2.ok) setData(await r2.json());
      }
    } catch (e) {
      setRestackResult({ ok: false, error: String(e) });
    } finally {
      setRestacking(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/stack/${repo}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [repo]);

  if (error) return <p className="text-sm text-[var(--danger)]">stack unavailable: {error}</p>;
  if (!data) return <p className="text-sm text-muted">loading…</p>;

  // Cascade hint: branches behind main are candidates for `git rebase --onto`.
  const cascadeNeeded = data.branches.filter((b) => b.commits_behind_main > 0 || b.commits_behind_parent > 0);

  return (
    <div>
      <div className="px-3 py-2 border-b-2 border-border bg-[var(--surface-1)] font-mono text-xs flex items-center justify-between">
        <span>
          <span className="text-muted">default branch </span>
          <span className="text-fg">{data.default_branch}</span>
          {data.head && (
            <span className="ml-3">
              <span className="text-muted">HEAD </span>
              <span className="text-accent">{data.head}</span>
            </span>
          )}
        </span>
        <span className="text-muted">{data.branches.length} branches</span>
      </div>

      {data.stacks.length === 0 ? (
        <p className="p-5 text-sm text-muted">
          No local branches besides <code>{data.default_branch}</code>. Create one to start a stack.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border-soft)]">
          {data.stacks.map((root) => (
            <BranchRow key={root.name} branch={root} data={data} depth={0} />
          ))}
        </ul>
      )}

      {cascadeNeeded.length > 0 && (
        <div className="border-t-2 border-border bg-[var(--surface-1)] px-3 py-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <button
              type="button"
              onClick={() => setShowCascade((v) => !v)}
              className="font-mono text-xs text-[var(--warn)] hover:underline"
            >
              {showCascade ? '▾' : '▸'} cascade — {cascadeNeeded.length} branch{cascadeNeeded.length === 1 ? '' : 'es'} need rebase
            </button>
            <button
              type="button"
              onClick={runCascade}
              disabled={restacking}
              className="font-mono text-xs px-3 py-1 bg-[var(--accent)] text-[var(--accent-fg)] disabled:opacity-50 hover:opacity-90"
              title="Run `git-spice upstack restack` from the current HEAD"
            >
              {restacking ? 'restacking…' : '▶ run cascade'}
            </button>
          </div>
          {showCascade && (
            <pre className="mt-2 p-3 bg-bg border-2 border-border font-mono text-[11px] overflow-x-auto leading-relaxed">
              <span className="text-muted"># cd into the fork first</span>
              {'\n'}cd workspace/{data.repo}
              {cascadeNeeded.map((b) => (
                `\n\n# ${b.name}: ${b.commits_behind_parent} behind ${b.parent}\ngit checkout ${b.name}\ngit rebase --onto ${b.parent === data.default_branch ? data.default_branch : b.parent} ${b.parent}`
              )).join('')}
              {'\n\n'}
              <span className="text-muted"># or click "run cascade" — invokes git-spice upstack restack from the current HEAD</span>
            </pre>
          )}
          {restackResult && (
            <div className={`mt-2 p-3 border-2 font-mono text-[11px] ${restackResult.ok ? 'border-[var(--ok)]' : 'border-[var(--danger)]'}`}>
              <div className={`font-bold mb-1 ${restackResult.ok ? 'text-[var(--ok)]' : 'text-[var(--danger)]'}`}>
                {restackResult.ok ? '✓ cascade complete' : `✗ cascade failed (exit ${restackResult.exit_code ?? '?'})`}
              </div>
              {restackResult.error && <div className="text-[var(--danger)]">{restackResult.error}</div>}
              {restackResult.stdout && (
                <pre className="whitespace-pre-wrap mt-1 text-fg">{restackResult.stdout}</pre>
              )}
              {restackResult.stderr && (
                <pre className="whitespace-pre-wrap mt-1 text-[var(--danger)]">{restackResult.stderr}</pre>
              )}
              {!restackResult.ok && (
                <p className="mt-2 text-muted">
                  Conflicts? Resolve in the workspace with <code>git add</code> + <code>git rebase --continue</code>,
                  then re-run the button.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
