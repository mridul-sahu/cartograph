// Whatknows — file-path reverse index lookup, bound to /api/whatknows.
//
// Design: claude-designs/cartograph/file-reverse-index/, ui-overhaul/

import { useState } from 'react';

interface Entry {
  note: string;
  layer: string | null;
  anchors: number[];
  sources: string[];
}

interface Hit {
  path: string;
  entries: Entry[];
}

interface Response {
  hits: Hit[];
  total: number;
  generated_at?: string;
}

const LAYER_ORDER = ['bedrock', 'topic', 'episode', 'research', 'paper', 'design', 'learn'];

/**
 * Map a note's repo-relative path to the UI route that renders it. Matches
 * the same routing convention used by /queue and the command palette.
 * Returns null when no UI route exists.
 */
function noteHref(note: string): string | null {
  let m;
  if ((m = note.match(/^guides\/([^/]+)\/topics\/(.+)\.md$/))) return `/repo/${m[1]}/topics/${m[2]}/`;
  if ((m = note.match(/^guides\/([^/]+)\/(overview|architecture|conventions)\.md$/))) return `/repo/${m[1]}/bedrock/${m[2]}/`;
  if ((m = note.match(/^episodes\/\d{4}-\d{2}\/(.+)\.md$/))) return `/episodes/${m[1]}/`;
  if ((m = note.match(/^research\/([^/]+)\/(.+)\.md$/))) return `/research/${m[1]}/${m[2]}/`;
  if ((m = note.match(/^papers\/([^/]+)\/([^/]+)\/notes\.md$/))) return `/papers/${m[1]}/${m[2]}/`;
  if ((m = note.match(/^learn\/walkthroughs\/(.+)\.md$/))) return `/walkthroughs/${m[1]}/`;
  if ((m = note.match(/^learn\/drafts\/(.+)\.md$/))) return `/drafts/${m[1]}/`;
  if ((m = note.match(/^learn\/ramp-up\/(.+)\.md$/))) return `/ramp-up/${m[1]}/`;
  if ((m = note.match(/^designs\/([^/]+)\/([^/]+)\/.+$/))) return `/designs/${m[1]}/${m[2]}/`;
  return null;
}

export default function Whatknows() {
  const [q, setQ] = useState('');
  const [data, setData] = useState<Response | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/whatknows?path=${encodeURIComponent(q.trim())}`);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j = (await r.json()) as Response;
      setData(j);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <form onSubmit={submit} className="flex gap-2 mb-3">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="path or substring (e.g. async_checkpointer.py)"
          className="flex-1 border-2 border-border bg-bg px-3 py-2 font-mono text-sm focus:outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy || !q.trim()}
          className="border-2 border-border px-3 py-2 font-mono text-xs bg-bg hover:bg-muted-bg disabled:opacity-50"
        >
          {busy ? '…' : 'lookup'}
        </button>
      </form>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      {data && data.hits.length === 0 && (
        <p className="text-sm text-muted">No notes reference “{q}”.</p>
      )}

      {data && data.hits.length > 0 && (
        <div className="space-y-3">
          {data.hits.map((hit) => (
            <div key={hit.path} className="border-2 border-[var(--border-soft)] p-3 bg-bg">
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted mb-1">cited code path</div>
              <code className="font-mono text-xs text-fg break-all mb-2 block">{hit.path}</code>
              <ul className="space-y-0.5">
                {[...hit.entries]
                  .sort((a, b) => LAYER_ORDER.indexOf(a.layer || '') - LAYER_ORDER.indexOf(b.layer || ''))
                  .map((e, i) => {
                    const href = noteHref(e.note);
                    const inner = (
                      <span>
                        <span className="text-muted">[{e.layer || '?'}]</span>{' '}
                        <span className="text-fg">{e.note}</span>
                      </span>
                    );
                    return (
                      <li key={i} className="font-mono text-xs flex items-center justify-between gap-2">
                        {href ? (
                          <a href={href} className="hover:text-accent no-underline">{inner}</a>
                        ) : (
                          inner
                        )}
                        {e.anchors.length > 0 && (
                          <span className="text-muted">:{e.anchors.join(',')}</span>
                        )}
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))}
          {data.total > data.hits.length && (
            <p className="text-xs text-muted">+ {data.total - data.hits.length} more (capped at 50)</p>
          )}
        </div>
      )}
    </div>
  );
}
