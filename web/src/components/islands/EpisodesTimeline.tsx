// Vertical episode timeline grouped by YYYY-MM bucket.
//
// Filter chips at the top — by repo and by tag — drive client-side filtering
// over a pre-computed list (the Astro page reads the FS at build time and
// hands a flat array of episode cards to this island).
//
// The tag chip list is capped: by default we render only the top
// TAG_VISIBLE_DEFAULT most-used tags plus the currently-active one if it
// would otherwise be hidden. A text input filters chips by typed substring
// so a 60-tag list is searchable instead of scroll-walls of one-each tags.
// "Show all N" expands the long tail.
//
// All animations gate on `prefers-reduced-motion`. Each card uses the
// standard brutalist hover idiom (translate -3/-3 + extend shadow).
import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

// Default chip cap. Tweak here, not at the callsite — the page's tag list
// arrives already sorted by frequency descending.
const TAG_VISIBLE_DEFAULT = 12;

export interface EpisodeCard {
  slug: string;
  month: string;
  title: string;
  excerpt: string;
  repo: string | null;
  tags: string[];
  date: string | null;
  wordCount: number;
}

interface Props {
  episodes: EpisodeCard[];
  repos: string[];
  tags: string[];
}

export default function EpisodesTimeline({ episodes, repos, tags }: Props) {
  const reduced = useReducedMotion();
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');

  // Per-tag episode count, computed once. Drives the chip count + the
  // "more tags" expansion order so heavy-hitters always appear first.
  const tagCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const e of episodes) for (const t of e.tags) {
      out.set(t, (out.get(t) ?? 0) + 1);
    }
    return out;
  }, [episodes]);

  const filtered = useMemo(() => {
    return episodes.filter((e) => {
      if (repoFilter !== 'all' && e.repo !== repoFilter) return false;
      if (tagFilter !== 'all' && !e.tags.includes(tagFilter)) return false;
      return true;
    });
  }, [episodes, repoFilter, tagFilter]);

  // Group filtered episodes by month (descending, since the array already
  // arrives sorted by date desc).
  const groups = useMemo(() => {
    const map = new Map<string, EpisodeCard[]>();
    for (const e of filtered) {
      const slot = map.get(e.month) ?? [];
      slot.push(e);
      map.set(e.month, slot);
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  return (
    <div>
      <div className="mb-6 space-y-3">
        <FilterRow
          label="repo"
          all="all"
          allCount={episodes.length}
          options={repos.map((r) => ({
            value: r,
            count: episodes.filter((e) => e.repo === r).length,
          }))}
          active={repoFilter}
          onChange={setRepoFilter}
        />
        {tags.length > 0 && (
          <TagFilter
            tags={tags}
            tagCounts={tagCounts}
            totalCount={episodes.length}
            active={tagFilter}
            onChange={setTagFilter}
          />
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="brutal-card p-6 font-mono text-sm text-muted">
          no episodes match these filters.
        </div>
      ) : (
        <div className="relative pl-6 md:pl-10">
          {/* Vertical timeline rail */}
          <div
            aria-hidden
            className="absolute left-0 top-0 bottom-0 w-[2px] bg-border"
            style={{ left: '0.6rem' }}
          />
          {groups.map(([month, items]) => (
            <section key={month} className="mb-10">
              <header className="-ml-6 md:-ml-10 mb-4 flex items-center gap-3">
                <span
                  aria-hidden
                  className="inline-block w-3 h-3 bg-accent border-2 border-border ml-[3px]"
                />
                <h3 className="font-mono text-xs uppercase tracking-widest text-muted">
                  {month}
                  <span className="text-fg ml-2">·</span>
                  <span className="text-fg ml-2">{items.length} episode{items.length === 1 ? '' : 's'}</span>
                </h3>
              </header>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {items.map((e, i) => (
                  <motion.a
                    key={e.slug}
                    href={`/episodes/${e.slug}/`}
                    className="brutal-card p-5 no-underline text-fg block"
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.22,
                      delay: i * 0.03,
                      ease: [0.4, 0, 0.2, 1],
                    }}
                    whileHover={
                      reduced
                        ? { opacity: 0.95 }
                        : { x: -3, y: -3, boxShadow: '9px 9px 0 0 var(--shadow)' }
                    }
                  >
                    <div className="flex items-baseline justify-between gap-3 mb-2">
                      <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                        episode
                      </span>
                      <span className="font-mono text-xs text-muted">
                        {e.date ?? e.slug}
                      </span>
                    </div>
                    <h4 className="font-bold text-lg leading-snug mb-2 tracking-tightish">
                      {e.title}
                    </h4>
                    <p className="text-sm text-muted leading-relaxed mb-3 line-clamp-2">
                      {e.excerpt || '(no body)'}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      {e.repo && <span className="chip chip-accent">{e.repo}</span>}
                      {e.tags.slice(0, 4).map((t) => (
                        <span key={t} className="chip">{t}</span>
                      ))}
                      {e.tags.length > 4 && (
                        <span className="font-mono text-xs text-muted">+{e.tags.length - 4}</span>
                      )}
                    </div>
                    <div className="font-mono text-xs text-muted">
                      {e.wordCount.toLocaleString()} words
                    </div>
                  </motion.a>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

interface FilterRowProps {
  label: string;
  all: string;
  allCount: number;
  options: { value: string; count: number }[];
  active: string;
  onChange: (v: string) => void;
}

function FilterRow({ label, all, allCount, options, active, onChange }: FilterRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
      <span className="text-muted uppercase tracking-widest mr-1 min-w-[2.5rem]">{label}</span>
      <FilterChip
        label={all}
        active={active === 'all'}
        onClick={() => onChange('all')}
        count={allCount}
      />
      {options
        .filter((o) => o.count > 0)
        .map((o) => (
          <FilterChip
            key={o.value}
            label={o.value}
            active={active === o.value}
            onClick={() => onChange(o.value)}
            count={o.count}
          />
        ))}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  count,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'chip cursor-pointer transition-[transform,box-shadow] duration-100 ' +
        (active ? 'chip-accent' : '')
      }
      style={active ? { boxShadow: '3px 3px 0 0 var(--shadow)' } : undefined}
      aria-pressed={active}
    >
      {label}
      <span className="text-muted ml-1">{count}</span>
    </button>
  );
}

// Dedicated tag filter — typed-text search + cap-and-expand. The old
// FilterRow rendered every option, which on the real corpus meant 60+ one-
// each chips that wrapped across five rows and dwarfed the actual content.
function TagFilter({
  tags,
  tagCounts,
  totalCount,
  active,
  onChange,
}: {
  tags: string[];
  tagCounts: Map<string, number>;
  totalCount: number;
  active: string;
  onChange: (v: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);

  // Tags arrive sorted by frequency desc; if the user types a query, narrow
  // first and only then apply the cap. The active tag is force-included so
  // a current selection never disappears from the chip row.
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? tags.filter((t) => t.toLowerCase().includes(q)) : tags;
  }, [tags, query]);

  const visible = useMemo(() => {
    if (expanded || matched.length <= TAG_VISIBLE_DEFAULT) return matched;
    const head = matched.slice(0, TAG_VISIBLE_DEFAULT);
    if (active !== 'all' && !head.includes(active) && matched.includes(active)) {
      head.push(active);
    }
    return head;
  }, [matched, expanded, active]);

  const hiddenCount = Math.max(0, matched.length - visible.length);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <span className="text-muted uppercase tracking-widest mr-1 min-w-[2.5rem]">tag</span>
        <FilterChip
          label="all"
          active={active === 'all'}
          onClick={() => onChange('all')}
          count={totalCount}
        />
        {visible.map((t) => (
          <FilterChip
            key={t}
            label={t}
            active={active === t}
            onClick={() => onChange(t)}
            count={tagCounts.get(t) ?? 0}
          />
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="chip cursor-pointer text-muted hover:text-fg"
          >
            +{hiddenCount} more ▾
          </button>
        )}
        {expanded && matched.length > TAG_VISIBLE_DEFAULT && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="chip cursor-pointer text-muted hover:text-fg"
          >
            collapse ▴
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 font-mono text-xs">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`filter ${tags.length} tags…`}
          className="px-2 py-1 border-2 border-border bg-bg text-fg font-mono text-xs focus:border-accent focus:outline-none w-full max-w-xs"
          aria-label="Filter tags"
        />
        {query && (
          <span className="text-muted">
            {matched.length}/{tags.length} match
          </span>
        )}
      </div>
    </div>
  );
}
