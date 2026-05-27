import { useMemo, useState, useEffect } from 'react';
import { motion, useReducedMotion } from 'motion/react';

// Card payload: SSR pre-computes the per-walkthrough metadata so this
// island never has to talk to the FS. The grid filters client-side via
// `?repo=<repo>` (synchronised to URL + chip clicks).
export interface WalkthroughCard {
  slug: string;
  title: string;
  repo: string | null;
  topic: string | null;
  lastRevised: string | null;
  wordCount: number;
}

interface Props {
  cards: WalkthroughCard[];
  repos: string[];
}

export default function WalkthroughGrid({ cards, repos }: Props) {
  const reduced = useReducedMotion();
  const [active, setActive] = useState<string>('all');

  // Read initial filter from `?repo=` once on mount.
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const r = u.searchParams.get('repo');
      if (r && (repos.includes(r) || r === 'all')) setActive(r);
    } catch {
      /* ignore */
    }
  }, [repos]);

  // Push filter to the URL without a navigation. Lets users share
  // `/walkthroughs?repo=jax` and have it stick.
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      if (active === 'all') u.searchParams.delete('repo');
      else u.searchParams.set('repo', active);
      window.history.replaceState({}, '', u.toString());
    } catch {
      /* ignore */
    }
  }, [active]);

  const filtered = useMemo(() => {
    if (active === 'all') return cards;
    return cards.filter((c) => c.repo === active);
  }, [active, cards]);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-2 font-mono text-xs">
        <span className="text-muted uppercase tracking-widest mr-1">filter</span>
        <FilterChip label="all" active={active === 'all'} onClick={() => setActive('all')} count={cards.length} />
        {repos.map((r) => {
          const count = cards.filter((c) => c.repo === r).length;
          if (count === 0) return null;
          return (
            <FilterChip
              key={r}
              label={r}
              active={active === r}
              onClick={() => setActive(r)}
              count={count}
            />
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="brutal-card p-6 font-mono text-sm text-muted">
          no walkthroughs match <span className="text-fg">{active}</span>.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filtered.map((c) => (
            <motion.a
              key={c.slug}
              href={`/walkthroughs/${c.slug}/`}
              className="brutal-card p-5 block no-underline text-fg"
              whileHover={
                reduced
                  ? { opacity: 0.92 }
                  : { x: -3, y: -3, boxShadow: '9px 9px 0 0 var(--shadow)' }
              }
              whileTap={reduced ? undefined : { x: 1, y: 1 }}
              transition={{ duration: 0.12, ease: [0.4, 0, 0.2, 1] }}
            >
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                  walkthrough
                </span>
                {c.repo && (
                  <span className="chip chip-accent">{c.repo}</span>
                )}
              </div>
              <h3 className="font-bold text-lg leading-snug mb-2 tracking-tightish">
                {c.title}
              </h3>
              {c.topic && (
                <div className="font-mono text-xs text-muted mb-3 truncate">
                  topic: {c.topic}
                </div>
              )}
              <div className="font-mono text-xs text-muted flex gap-3 flex-wrap">
                <span>{c.wordCount.toLocaleString()} words</span>
                {c.lastRevised && <span>· revised {c.lastRevised}</span>}
              </div>
            </motion.a>
          ))}
        </div>
      )}
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
      style={
        active
          ? { boxShadow: '3px 3px 0 0 var(--shadow)' }
          : undefined
      }
      aria-pressed={active}
    >
      {label}
      <span className="text-muted ml-1">{count}</span>
    </button>
  );
}
