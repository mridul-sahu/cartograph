// PromotionsFeed — chronological feed of every auto-compound event.
//
// Source: /api/promotions returns episodes that were auto-drafted, topic
// notes that were auto-promoted from episodes, and topic-into-bedrock
// folds. The UI just renders the timeline so the user can see what
// cartograph compounded for them.
import { useEffect, useState } from 'react';

interface PromotionEvent {
  kind: 'episode-auto-draft' | 'topic-auto-promote' | 'topic-fold-bedrock';
  title: string;
  repo?: string;
  date: string;
  path: string;
  url: string;
  reviewed?: string | null;
  rejected?: boolean;
}

interface Payload {
  total: number;
  by_kind: Record<string, number>;
  events: PromotionEvent[];
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: Payload }
  | { kind: 'error'; message: string };

const KIND_LABEL: Record<PromotionEvent['kind'], string> = {
  'episode-auto-draft': 'episode (auto-drafted)',
  'topic-auto-promote': 'topic (auto-promoted)',
  'topic-fold-bedrock': 'bedrock fold',
};

// `compact` — used on /console where Promotions is one of several cards.
// Drops the 4-counter strip, caps to the first 8 events, and hides the
// rest behind a + show all (N) toggle so Lint and Diary aren't buried.
export default function PromotionsFeed({ compact = false }: { compact?: boolean } = {}) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/promotions')
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setState({ kind: 'ready', data: d });
      })
      .catch((e) => {
        if (!cancelled) setState({ kind: 'error', message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return <div className="font-mono text-sm text-muted">loading…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="brutal-card p-4 font-mono text-sm">
        <div className="text-danger font-bold">load failed</div>
        <div className="text-muted">{state.message}</div>
      </div>
    );
  }

  const { events, by_kind, total } = state.data;
  const visibleEvents = compact && !expanded ? events.slice(0, 8) : events;
  return (
    <section>
      {!compact && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Counter label="total promotions" value={total} />
          <Counter
            label="auto-drafted episodes"
            value={by_kind['episode-auto-draft'] ?? 0}
          />
          <Counter
            label="auto-promoted topics"
            value={by_kind['topic-auto-promote'] ?? 0}
          />
          <Counter
            label="bedrock folds"
            value={by_kind['topic-fold-bedrock'] ?? 0}
          />
        </div>
      )}
      {compact && (
        <div className="font-mono text-xs text-muted mb-3">
          {total} total · {by_kind['episode-auto-draft'] ?? 0} ep · {by_kind['topic-auto-promote'] ?? 0} tp · {by_kind['topic-fold-bedrock'] ?? 0} fold
        </div>
      )}
      {events.length === 0 ? (
        <div className="brutal-card p-6 font-mono text-sm text-muted">
          no auto-promotions yet. cartograph compounds as you use it —
          the next ≥3-same-tag episodes will trigger the first
          episode → topic promotion automatically on SessionStart.
        </div>
      ) : (
        <ul className="space-y-3">
          {visibleEvents.map((e) => (
            <li key={e.path}>
              <a
                href={e.url}
                target="_blank"
                rel="noopener noreferrer"
                className="brutal-card p-4 no-underline text-fg block"
              >
                <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
                  <h3 className="font-mono text-base font-bold tracking-tightish break-all">
                    {e.title}
                  </h3>
                  <div className="flex items-baseline gap-2">
                    {e.repo && (
                      <code className="chip chip-accent">{e.repo}</code>
                    )}
                    {e.reviewed && (
                      <code className="chip chip-ok">reviewed · {e.reviewed}</code>
                    )}
                    {e.rejected && (
                      <code className="chip chip-danger">rejected</code>
                    )}
                  </div>
                </div>
                <div className="font-mono text-xs text-muted flex gap-4 flex-wrap">
                  <span>{KIND_LABEL[e.kind]}</span>
                  {e.date && <span>· {e.date}</span>}
                  <code className="break-all">{e.path}</code>
                </div>
              </a>
            </li>
          ))}
          {compact && !expanded && events.length > visibleEvents.length && (
            <li>
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="font-mono text-xs text-accent hover:underline"
              >
                + show {events.length - visibleEvents.length} more
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="brutal-card p-4">
      <div className="font-mono text-[11px] uppercase tracking-widest text-muted mb-2">
        {label}
      </div>
      <div className="font-mono text-4xl font-bold leading-none">{value}</div>
    </div>
  );
}
