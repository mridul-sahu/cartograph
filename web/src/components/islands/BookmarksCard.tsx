// BookmarksCard — Home/Sidebar widget rendering pinned notes from /api/bookmarks.

import { useEffect, useState } from 'react';

interface Bookmark {
  path: string;
  title: string;
  pinned_at: string;
}

function pathToHref(path: string): string {
  let m;
  if ((m = path.match(/^guides\/([^/]+)\/topics\/(.+)\.md$/))) return `/repo/${m[1]}/topics/${m[2]}/`;
  if ((m = path.match(/^guides\/([^/]+)\/(overview|architecture|conventions)\.md$/))) return `/repo/${m[1]}/bedrock/${m[2]}/`;
  if ((m = path.match(/^episodes\/\d{4}-\d{2}\/(.+)\.md$/))) return `/episodes/${m[1]}/`;
  if ((m = path.match(/^research\/([^/]+)\/(.+)\.md$/))) return `/research/${m[1]}/${m[2]}/`;
  if ((m = path.match(/^papers\/([^/]+)\/([^/]+)\/.+$/))) return `/papers/${m[1]}/${m[2]}/`;
  if ((m = path.match(/^learn\/walkthroughs\/(.+)\.md$/))) return `/walkthroughs/${m[1]}/`;
  if ((m = path.match(/^designs\/([^/]+)\/([^/]+)\/.+$/))) return `/designs/${m[1]}/${m[2]}/`;
  return '#';
}

export default function BookmarksCard() {
  const [items, setItems] = useState<Bookmark[] | null>(null);

  useEffect(() => {
    fetch('/api/bookmarks')
      .then((r) => r.ok ? r.json() : null)
      .then((j) => setItems(j?.bookmarks ?? []))
      .catch(() => setItems([]));
  }, []);

  if (items === null) return <p className="text-sm text-muted">loading…</p>;
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted">
        No pins yet. Click <code>☆ pin</code> on any note to keep it here.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-[var(--border-soft)]">
      {items.map((b, i) => (
        <li key={b.path} className={i % 2 === 0 ? 'bg-bg' : 'bg-[var(--surface-1)]'}>
          <a
            href={pathToHref(b.path)}
            className="block px-3 py-2 hover:bg-[var(--surface-2)] no-underline text-fg font-mono text-xs"
          >
            <span className="text-accent mr-2">★</span>
            <span>{b.title}</span>
            <span className="text-muted block truncate">{b.path}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
