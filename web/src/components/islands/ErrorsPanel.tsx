// ErrorsPanel — last 20 chassis script errors from GET /api/errors?n=50.
// Polls every 60s. Defensive: the endpoint may not exist yet (the chassis
// agent ships it separately) — a non-OK response renders the same quiet
// empty state instead of an error wall.

import { useEffect, useState } from 'react';
import { timeAgo } from '~/lib/time';

interface ErrEntry {
  ts?: string;
  script?: string;
  message?: string;
}

const SHOW_MAX = 20;

function normalize(j: unknown): ErrEntry[] {
  // Accept either a bare array or an {errors: [...]} envelope.
  const arr = Array.isArray(j)
    ? j
    : j && typeof j === 'object' && Array.isArray((j as { errors?: unknown }).errors)
      ? (j as { errors: unknown[] }).errors
      : [];
  return arr.filter((e): e is ErrEntry => !!e && typeof e === 'object');
}

export default function ErrorsPanel() {
  const [entries, setEntries] = useState<ErrEntry[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/errors?n=50');
        if (!r.ok) {
          if (!cancelled) {
            setUnavailable(true);
            setEntries([]);
          }
          return;
        }
        const j = (await r.json()) as unknown;
        if (!cancelled) {
          const all = normalize(j);
          // Newest first; assume ts is sortable ISO when present.
          all.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
          setEntries(all.slice(0, SHOW_MAX));
          setUnavailable(false);
        }
      } catch {
        if (!cancelled) {
          setUnavailable(true);
          setEntries([]);
        }
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (entries === null) return <p className="p-5 text-sm text-muted">loading…</p>;

  if (entries.length === 0) {
    return (
      <p className="p-5 text-sm text-muted">
        {unavailable
          ? 'Errors feed unavailable — /api/errors not served by this chassis yet.'
          : 'No recent script errors. 🎉'}
      </p>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-5 py-2 flex items-center justify-between gap-3 font-mono text-xs hover:bg-[var(--surface-1)] cursor-pointer"
      >
        <span>
          <span className="px-1.5 py-0.5 bg-[var(--danger)] text-bg mr-2">{entries.length}</span>
          <span className="text-fg">recent script error{entries.length === 1 ? '' : 's'}</span>
        </span>
        <span className="text-muted">{open ? '▾ collapse' : '▸ expand'}</span>
      </button>
      {open && (
        <ul className="border-t-2 border-border">
          {entries.map((e, i) => (
            <li
              key={i}
              className={`px-5 py-2 font-mono text-xs flex items-baseline gap-3 border-b border-[var(--border-soft)] last:border-b-0 ${
                i % 2 === 0 ? 'bg-bg' : 'bg-[var(--surface-1)]'
              }`}
            >
              <span className="text-muted whitespace-nowrap flex-shrink-0 w-20" title={e.ts ?? ''}>
                {e.ts ? timeAgo(e.ts) : '—'}
              </span>
              <span className="chip chip-sm chip-danger flex-shrink-0">{e.script || 'unknown'}</span>
              <span className="text-fg min-w-0 break-words" title={e.message ?? ''}>
                {e.message || '(no message)'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
