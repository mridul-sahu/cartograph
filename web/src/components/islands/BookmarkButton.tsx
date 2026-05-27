// BookmarkButton — pin / unpin a note via /api/bookmarks.
// Local state, lives in .cartograph/state/bookmarks.json (gitignored).

import { useEffect, useState } from 'react';

interface Props {
  path: string;
  title?: string;
}

export default function BookmarkButton({ path, title }: Props) {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/bookmarks')
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (j?.bookmarks) {
          setPinned(j.bookmarks.some((b: { path: string }) => b.path === path));
        }
      })
      .catch(() => setPinned(false));
  }, [path]);

  const toggle = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/bookmarks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, title: title || path }),
      });
      if (r.ok) {
        const j = await r.json();
        setPinned(j.pinned);
      }
    } finally {
      setBusy(false);
    }
  };

  if (pinned === null) {
    return <span className="font-mono text-xs text-muted">···</span>;
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={pinned ? 'Unpin from bookmarks' : 'Pin to bookmarks'}
      className={`font-mono text-xs px-2 py-1 border-2 ${pinned ? 'bg-[var(--accent)] text-[var(--accent-fg)] border-[var(--accent)]' : 'border-border text-muted hover:text-fg'}`}
    >
      {pinned ? '★ pinned' : '☆ pin'}
    </button>
  );
}
