// ReadingQueueCard — manually-curated "what I'm working on this week"
// list. Distinct from bookmarks (those are permanent pins); reading
// queue is intentional, short, with optional context note per item.
// Backed by /api/reading-queue, .cartograph/state/reading-queue.json.

import { useEffect, useState } from 'react';

interface Item {
  path: string;
  title: string;
  note?: string;
  added_at: string;
}

function pathToHref(path: string): string {
  let m;
  if ((m = path.match(/^guides\/([^/]+)\/topics\/(.+)\.md$/))) return `/repo/${m[1]}/topics/${m[2]}/`;
  if ((m = path.match(/^guides\/([^/]+)\/(overview|architecture|conventions)\.md$/))) return `/repo/${m[1]}/bedrock/${m[2]}/`;
  if ((m = path.match(/^episodes\/\d{4}-\d{2}\/(.+)\.md$/))) return `/episodes/${m[1]}/`;
  if ((m = path.match(/^research\/([^/]+)\/(.+)\.md$/))) return `/research/${m[1]}/${m[2]}/`;
  if ((m = path.match(/^designs\/([^/]+)\/([^/]+)\/.+$/))) return `/designs/${m[1]}/${m[2]}/`;
  return '#';
}

export default function ReadingQueueCard() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [note, setNote] = useState('');

  const reload = () => {
    fetch('/api/reading-queue')
      .then((r) => r.ok ? r.json() : null)
      .then((j) => setItems(j?.items ?? []))
      .catch(() => setItems([]));
  };

  useEffect(reload, []);

  const add = async () => {
    if (!path.trim()) return;
    await fetch('/api/reading-queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', path: path.trim(), note: note.trim() }),
    });
    setPath('');
    setNote('');
    setAdding(false);
    reload();
  };

  const remove = async (p: string) => {
    await fetch('/api/reading-queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'remove', path: p }),
    });
    reload();
  };

  if (items === null) return <p className="text-sm text-muted">loading…</p>;

  return (
    <div>
      {items.length === 0 && !adding ? (
        <p className="px-3 py-3 text-sm text-muted">
          No items in the reading queue. This is for the handful of notes you're
          actively working through this week — distinct from permanent bookmarks.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border-soft)]">
          {items.map((i, idx) => (
            <li key={i.path} className={idx % 2 === 0 ? 'bg-bg' : 'bg-[var(--surface-1)]'}>
              <div className="flex items-baseline gap-3 px-3 py-2">
                <a
                  href={pathToHref(i.path)}
                  className="font-mono text-xs text-accent hover:underline flex-1 min-w-0 truncate"
                >{i.title}</a>
                <button
                  type="button"
                  onClick={() => remove(i.path)}
                  className="font-mono text-[10px] text-muted hover:text-[var(--danger)]"
                  title="Remove from queue"
                >×</button>
              </div>
              {i.note && (
                <div className="px-3 pb-2 text-xs text-muted">{i.note}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="border-t-2 border-border px-3 py-2">
        {adding ? (
          <div className="space-y-2">
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="path (e.g. guides/orbax/topics/async-checkpoint-flow.md)"
              className="w-full px-2 py-1 font-mono text-xs border-2 border-border bg-bg"
            />
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="optional context — what are you working on with this?"
              className="w-full px-2 py-1 font-mono text-xs border-2 border-border bg-bg"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={add}
                disabled={!path.trim()}
                className="px-3 py-1 font-mono text-xs bg-[var(--accent)] text-[var(--accent-fg)] disabled:opacity-50"
              >add</button>
              <button
                type="button"
                onClick={() => { setAdding(false); setPath(''); setNote(''); }}
                className="px-3 py-1 font-mono text-xs border-2 border-border text-muted hover:text-fg"
              >cancel</button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="font-mono text-[11px] text-muted hover:text-fg"
          >+ add to queue</button>
        )}
      </div>
    </div>
  );
}
