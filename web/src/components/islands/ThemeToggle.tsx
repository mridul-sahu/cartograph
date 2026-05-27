import { useEffect, useState } from 'react';
import { motion } from 'motion/react';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'cartograph-theme';

function resolveInitial(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const initial = resolveInitial();
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
    setMounted(true);
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem(STORAGE_KEY, next);
  }

  return (
    <motion.button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      className="brutal-button font-mono text-sm"
      whileHover={{ x: -2, y: -2 }}
      whileTap={{ x: 2, y: 2 }}
      transition={{ duration: 0.12, ease: [0.4, 0, 0.2, 1] }}
    >
      <span aria-hidden>{mounted ? (theme === 'dark' ? '◐' : '◑') : '◐'}</span>
      <span>{mounted ? theme : '—'}</span>
    </motion.button>
  );
}
