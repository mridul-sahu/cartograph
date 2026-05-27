// Backlinks — "what links here?" panel. Backed by /api/backlinks (body grep).

import { useEffect, useState } from 'react';

interface Hit { path: string }

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

export default function Backlinks({ path }: { path: string }) {
  const [hits, setHits] = useState<Hit[] | null>(null);

  useEffect(() => {
    fetch(`/api/backlinks?path=${encodeURIComponent(path)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((j) => setHits(j?.backlinks ?? []))
      .catch(() => setHits([]));
  }, [path]);

  if (hits === null) return <p className="text-xs text-muted">loading…</p>;
  if (hits.length === 0) return <p className="text-xs text-muted">nothing links here yet</p>;

  return (
    <ul className="space-y-0.5">
      {hits.slice(0, 8).map((h) => (
        <li key={h.path}>
          <a href={pathToHref(h.path)} className="font-mono text-[11px] text-accent hover:underline break-all">
            {h.path}
          </a>
        </li>
      ))}
      {hits.length > 8 && (
        <li className="font-mono text-[10px] text-muted">+ {hits.length - 8} more</li>
      )}
    </ul>
  );
}
