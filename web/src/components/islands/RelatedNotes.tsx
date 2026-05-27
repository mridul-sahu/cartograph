// RelatedNotes — "more like this" panel driven by /api/related (BM25).
// Right-rail widget on topic/episode/research detail pages.

import { useEffect, useState } from 'react';

interface Hit {
  path: string;
  title: string;
  layer: string | null;
  repo: string | null;
  score: number;
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

export default function RelatedNotes({ path }: { path: string }) {
  const [hits, setHits] = useState<Hit[] | null>(null);

  useEffect(() => {
    fetch(`/api/related?path=${encodeURIComponent(path)}&k=6`)
      .then((r) => r.ok ? r.json() : null)
      .then((j) => setHits(j?.hits ?? []))
      .catch(() => setHits([]));
  }, [path]);

  if (hits === null) return <p className="text-xs text-muted">loading…</p>;
  if (hits.length === 0) return <p className="text-xs text-muted">no related notes</p>;

  return (
    <ul className="divide-y divide-[var(--border-soft)]">
      {hits.map((h) => (
        <li key={h.path}>
          <a
            href={pathToHref(h.path)}
            className="block px-3 py-2 hover:bg-[var(--surface-2)] no-underline text-fg font-mono text-xs"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-fg truncate flex-1 min-w-0">{h.title || h.path}</span>
              <span className="text-muted whitespace-nowrap">{h.score.toFixed(1)}</span>
            </div>
            <div className="text-muted text-[10px] truncate">[{h.layer || '?'}] {h.path}</div>
          </a>
        </li>
      ))}
    </ul>
  );
}
