// Queue panel — sectioned review-debt dashboard backed by /api/queue.
// One island per page-load; polls every 30s.
//
// Design: claude-designs/cartograph/review-queue/, claude-designs/cartograph/ui-overhaul/

import { useEffect, useState } from 'react';

interface SectionItem {
  path?: string;
  layer?: string;
  repo?: string;
  date?: string;
  last_revised?: string;
  slug?: string;
  acquired_at?: string;
  intent?: string;
  agent?: string;
  commits?: number;
}

interface Section {
  label: string;
  count: number;
  items: SectionItem[];
}

interface QueueResponse {
  sections: Section[];
  generated_at: string;
}

/**
 * Map a Cartograph content path to a clickable URL in the local UI.
 * Falls back to null when no UI route exists (caller renders plain text).
 *
 * Routes used here mirror the Astro page tree:
 *   guides/<r>/topics/<slug>.md         → /repo/<r>/topics/<slug>/
 *   guides/<r>/(overview|architecture|conventions).md → /repo/<r>/bedrock/<layer>/
 *   episodes/<YYYY-MM>/<slug>.md        → /episodes/<slug>/
 *   research/<r>/<slug>.md              → /research/<r>/<slug>/
 *   papers/<r>/<slug>/notes.md          → /papers/<r>/<slug>/
 *   .drift-reports/<r>.md               → /api/drift/<r>     (plain text, until a renderer exists)
 *   .drift-reports/topics/<r>/<slug>.md → /api/drift/<r>?topic=<slug>
 *   .cartograph/in-flight/<slug>.md     → null (local-only worknote)
 */
function pathToHref(path: string): string | null {
  if (!path) return null;
  const m = path.match(/^(.+?)\.md$/);
  const stem = m ? m[1] : path;

  let r;
  if ((r = stem.match(/^guides\/([^/]+)\/topics\/(.+)$/))) return `/repo/${r[1]}/topics/${r[2]}/`;
  if ((r = stem.match(/^guides\/([^/]+)\/(overview|architecture|conventions)$/)))
    return `/repo/${r[1]}/bedrock/${r[2]}/`;
  if ((r = stem.match(/^episodes\/\d{4}-\d{2}\/(.+)$/))) return `/episodes/${r[1]}/`;
  if ((r = stem.match(/^research\/([^/]+)\/(.+)$/))) return `/research/${r[1]}/${r[2]}/`;
  if ((r = stem.match(/^papers\/([^/]+)\/([^/]+)\/notes$/))) return `/papers/${r[1]}/${r[2]}/`;
  if ((r = stem.match(/^learn\/walkthroughs\/(.+)$/))) return `/walkthroughs/${r[1]}/`;
  if ((r = stem.match(/^learn\/drafts\/(.+)$/))) return `/drafts/${r[1]}/`;
  if ((r = stem.match(/^learn\/ramp-up\/(.+)$/))) return `/ramp-up/${r[1]}/`;
  if ((r = path.match(/^\.drift-reports\/topics\/([^/]+)\/(.+)\.md$/))) {
    // Link to the per-topic page; the DriftCallout there will render the
    // pre-staged drift evidence inline.
    return `/repo/${r[1]}/topics/${r[2]}/`;
  }
  if ((r = path.match(/^\.drift-reports\/([^/]+)\.md$/))) return `/drift/${r[1]}/`;
  return null;
}

function summarizeItem(item: SectionItem): { primary: string; secondary: string } {
  const primary = item.path || item.slug || JSON.stringify(item);
  const bits: string[] = [];
  if (item.commits !== undefined) bits.push(`${item.commits} commits`);
  if (item.intent) bits.push(item.intent);
  if (item.acquired_at) bits.push(new Date(item.acquired_at).toLocaleTimeString());
  if (item.date) bits.push(item.date);
  else if (item.last_revised) bits.push(item.last_revised);
  return { primary, secondary: bits.join(' · ') };
}

export default function QueuePanel() {
  const [data, setData] = useState<QueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Track section expansion so a 47-item section doesn't dominate the panel.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Optimistic per-path touch state for aged topics: 'busy' while the POST
  // is in flight, an ISO date once bumped, 'error: …' on failure.
  const [touched, setTouched] = useState<Record<string, string>>({});

  const touchTopic = async (path: string, repo: string, slug: string) => {
    setTouched((prev) => ({ ...prev, [path]: 'busy' }));
    const today = new Date().toISOString().slice(0, 10);
    try {
      const r = await fetch(`/api/topic/${repo}/${slug}/touch`, { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      setTouched((prev) => ({ ...prev, [path]: today }));
    } catch (e) {
      // Endpoint may not exist yet — surface the failure on the row.
      setTouched((prev) => ({ ...prev, [path]: `error: ${String(e)}` }));
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/queue');
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const j = (await r.json()) as QueueResponse;
        if (!cancelled) {
          setData(j);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return <p className="text-sm text-[var(--danger)]">queue unavailable: {error}</p>;
  }
  if (!data) {
    return <p className="text-sm text-muted">loading…</p>;
  }
  if (data.sections.length === 0) {
    return <p className="text-sm text-muted">No review-debt items. Nothing in the queue.</p>;
  }

  // Tag each section with the bulk-action type the /console/review
  // surface dispatches for it. Bless (episode/topic verdicts), anchor
  // (claude-driven anchor add), drift (per-citation re-validation).
  // Sections that aren't actionable from the bulk surface (stale aged
  // topics, repo-level drift reports, active worknote leases) get null.
  type Kind = 'bless' | 'anchor' | 'drift' | 'revise' | null;
  const sectionKind = (label: string): Kind => {
    const l = label.toLowerCase();
    if (l.includes('awaiting human review') || l.includes('awaiting review') || l.includes('auto-drafted')) return 'bless';
    if (l.includes('canonical anchor') || l.includes('anchor gap') || l.includes('missing canonical')) return 'anchor';
    if (l.includes('per-topic drift')) return 'drift';
    // 'Topics whose cited files moved' — written by post-edit-topic-mark.sh
    // when an Edit/Write hits a workspace file that any topic cites.
    if (l.includes('cited files moved') || l.includes('topics needing revision')) return 'revise';
    return null;
  };
  const kindBadge = (k: Kind): { label: string; cls: string } | null => {
    if (!k) return null;
    if (k === 'bless') return { label: 'bless', cls: 'bg-[var(--accent)] text-[var(--accent-fg)]' };
    if (k === 'anchor') return { label: 'anchor', cls: 'bg-[var(--warn)] text-bg' };
    if (k === 'drift') return { label: 'drift', cls: 'bg-[var(--danger)] text-bg' };
    return { label: 'revise', cls: 'bg-[var(--warn)] text-bg border border-[var(--danger)]' };
  };
  const actionable = data.sections.reduce((acc, s) => acc + (sectionKind(s.label) ? s.count : 0), 0);

  return (
    <div className="space-y-4">
      {actionable > 0 && (
        <a
          href="/console/review/"
          className="block px-3 py-2 border-2 border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)] no-underline hover:opacity-90 font-mono text-xs flex items-center justify-between"
        >
          <span>▶ Bulk review — claude decides + acts per item</span>
          <span className="opacity-80">{actionable} pending →</span>
        </a>
      )}
      {data.sections.map((sec) => {
        const open = expanded[sec.label] ?? sec.count <= 8;
        const showAll = expanded[sec.label] === true;
        const visible = showAll ? sec.items : sec.items.slice(0, 8);
        const badge = kindBadge(sectionKind(sec.label));
        // "Topics aged >Nd" — stale-but-correct topics get a one-click
        // last_revised bump instead of a full revision pass.
        const isAgedSection = sec.label.toLowerCase().includes('aged');
        return (
          <details key={sec.label} open={open} className="border-2 border-border bg-bg">
            <summary
              className="cursor-pointer px-3 py-2 flex items-center justify-between gap-2 font-mono text-xs hover:bg-[var(--surface-1)]"
              onClick={(e) => {
                // Native <details> toggling drives `open`; we also flip our
                // "show-all" flag so >8-item sections expand fully on click.
                e.preventDefault();
                setExpanded((prev) => ({ ...prev, [sec.label]: !(prev[sec.label] ?? false) }));
              }}
            >
              <span className="flex items-center gap-2 min-w-0">
                {badge && <span className={`px-1.5 py-0.5 ${badge.cls} flex-shrink-0`}>{badge.label}</span>}
                <span className="text-fg truncate">{sec.label}</span>
              </span>
              <span className="text-muted flex-shrink-0">{sec.count}</span>
            </summary>
            <ul className="border-t-2 border-border">
              {visible.map((item, i) => {
                const { primary, secondary } = summarizeItem(item);
                const href = pathToHref(primary);
                // Zebra stripe — readability across long sections.
                const rowBg = i % 2 === 0 ? 'bg-bg' : 'bg-[var(--surface-1)]';
                // Touch affordance for aged topics (guides/<r>/topics/<s>.md).
                const topicMatch = isAgedSection
                  ? primary.match(/^guides\/([^/]+)\/topics\/(.+)\.md$/)
                  : null;
                const touchState = topicMatch ? touched[primary] : undefined;
                const touchedDate =
                  touchState && touchState !== 'busy' && !touchState.startsWith('error') ? touchState : null;
                const rowSecondary = touchedDate ? `touched ${touchedDate}` : secondary;
                const content = (
                  <div className="px-3 py-1.5 font-mono text-xs flex items-center justify-between gap-3 border-b border-[var(--border-soft)] last:border-b-0 hover:bg-[var(--surface-2)]">
                    {badge && <span className={`px-1.5 py-0.5 ${badge.cls} flex-shrink-0`}>{badge.label}</span>}
                    <span className="truncate text-fg flex-1 min-w-0">{primary}</span>
                    {rowSecondary && (
                      <span className={`whitespace-nowrap flex-shrink-0 ${touchedDate ? 'text-[var(--ok)]' : 'text-muted'}`}>
                        {rowSecondary}
                      </span>
                    )}
                  </div>
                );
                const touchButton = topicMatch ? (
                  <div className="flex items-center gap-2 pr-3 flex-shrink-0">
                    {touchState?.startsWith('error') && (
                      <span className="font-mono text-[10px] text-[var(--danger)]" title={touchState}>
                        touch failed
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={touchState === 'busy' || !!touchedDate}
                      title="Bump last_revised to today without a content revision"
                      onClick={() => touchTopic(primary, topicMatch[1], topicMatch[2])}
                      className="px-2 py-0.5 font-mono text-[10px] border border-border text-muted hover:text-fg hover:bg-[var(--surface-2)] disabled:opacity-50 whitespace-nowrap"
                    >
                      {touchState === 'busy' ? 'touching…' : touchedDate ? '✓ touched' : 'touch last_revised'}
                    </button>
                  </div>
                ) : null;
                return (
                  <li key={i} className={rowBg}>
                    {touchButton ? (
                      <div className="flex items-stretch">
                        <div className="flex-1 min-w-0">
                          {href ? (
                            <a href={href} className="block no-underline text-fg">{content}</a>
                          ) : (
                            content
                          )}
                        </div>
                        {touchButton}
                      </div>
                    ) : href ? (
                      <a href={href} className="block no-underline text-fg">
                        {content}
                      </a>
                    ) : (
                      content
                    )}
                  </li>
                );
              })}
              {sec.count > visible.length && (
                <li className="px-3 py-1.5 text-xs text-muted bg-bg border-t border-[var(--border-soft)]">
                  <button
                    type="button"
                    className="underline decoration-dotted hover:text-fg"
                    onClick={() => setExpanded((prev) => ({ ...prev, [sec.label]: true }))}
                  >
                    + {sec.count - visible.length} more
                  </button>
                </li>
              )}
            </ul>
          </details>
        );
      })}
      <div className="text-[10px] text-muted font-mono">
        Generated {data.generated_at} — bless · anchor · drift all flow through{' '}
        <a href="/console/review/" className="text-accent hover:underline">/console/review/</a>.
      </div>
    </div>
  );
}
