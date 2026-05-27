// KeyboardShortcuts — global key handlers.
//
// `/`        focus the Cmd-K palette as search-first
// `g h`      → /          (home)
// `g p`      → /prs/
// `g r`      → /repo/
// `g e`      → /episodes/
// `g l`      → /library/
// `g s`      → /seams/
// `g c`      → /console/
// `j` / `k`  walk between <a> elements inside <main> (skip if input focused)
// `?`        show shortcut help inline (alert for now — could become an overlay)
//
// All handlers no-op when a text input / textarea / contenteditable has focus.

import { useEffect, useState } from 'react';

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

const GO_MAP: Record<string, string> = {
  h: '/',
  p: '/prs/',
  r: '/repo/',
  e: '/episodes/',
  l: '/library/',
  s: '/seams/',
  c: '/console/',
};

function visibleAnchors(): HTMLAnchorElement[] {
  const main = document.querySelector('main');
  if (!main) return [];
  return Array.from(main.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((a) => {
    const r = a.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && a.href;
  });
}

function focusedAnchorIndex(anchors: HTMLAnchorElement[]): number {
  const active = document.activeElement;
  if (!(active instanceof HTMLAnchorElement)) return -1;
  return anchors.indexOf(active);
}

export default function KeyboardShortcuts() {
  const [pendingG, setPendingG] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    let gTimer: number | undefined;

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) {
        // Special: pressing Escape inside an input lets / focus the palette next.
        return;
      }

      // `g` prefix navigation
      if (pendingG) {
        const dest = GO_MAP[e.key.toLowerCase()];
        if (dest) {
          e.preventDefault();
          setPendingG(false);
          if (gTimer) window.clearTimeout(gTimer);
          window.location.href = dest;
          return;
        }
        // Any other key clears the prefix.
        setPendingG(false);
        if (gTimer) window.clearTimeout(gTimer);
      }

      if (e.key === 'g') {
        e.preventDefault();
        setPendingG(true);
        gTimer = window.setTimeout(() => setPendingG(false), 1200);
        return;
      }

      if (e.key === '/') {
        // Cmd-K palette has its own ⌘K hotkey; we synthesize one to open it.
        e.preventDefault();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
        return;
      }

      if (e.key === '?') {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }

      if (e.key === 'j' || e.key === 'k') {
        const anchors = visibleAnchors();
        if (anchors.length === 0) return;
        e.preventDefault();
        const cur = focusedAnchorIndex(anchors);
        const next = e.key === 'j'
          ? (cur < 0 ? 0 : Math.min(anchors.length - 1, cur + 1))
          : (cur <= 0 ? 0 : cur - 1);
        const target = anchors[next];
        target.focus({ preventScroll: false });
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }

      if (e.key === 'Enter') {
        // When an anchor is focused via j/k, Enter activates it (browser default).
        // No special handling needed; just don't intercept.
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (gTimer) window.clearTimeout(gTimer);
    };
  }, [pendingG]);

  if (!showHelp && !pendingG) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 brutal-card bg-bg p-3 font-mono text-xs max-w-sm">
      {pendingG && !showHelp ? (
        <div>
          <div className="text-[10px] uppercase tracking-widest text-muted mb-1">go to…</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <span><kbd>g h</kbd> home</span>
            <span><kbd>g p</kbd> prs</span>
            <span><kbd>g r</kbd> repos</span>
            <span><kbd>g e</kbd> episodes</span>
            <span><kbd>g l</kbd> library</span>
            <span><kbd>g s</kbd> seams</span>
            <span><kbd>g c</kbd> console</span>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-widest text-muted">shortcuts</span>
            <button onClick={() => setShowHelp(false)} className="text-muted hover:text-fg">✕</button>
          </div>
          <ul className="space-y-0.5">
            <li><kbd>⌘K</kbd> / <kbd>/</kbd> — open search palette</li>
            <li><kbd>j</kbd> / <kbd>k</kbd> — next / previous link</li>
            <li><kbd>g</kbd> then h/p/r/e/l/s/c — jump to section</li>
            <li><kbd>?</kbd> — toggle this help</li>
            <li><kbd>Esc</kbd> — close palette</li>
          </ul>
        </div>
      )}
    </div>
  );
}
