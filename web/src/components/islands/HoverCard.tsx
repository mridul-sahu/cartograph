import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';

interface Props {
  href: string;
  children: ReactNode;
  className?: string;
}

// Wraps a brutalist card with the standard hover motion: shift up-left,
// extend shadow. Skipped (flattened to opacity) under prefers-reduced-motion.
export default function HoverCard({ href, children, className = '' }: Props) {
  const reduced = useReducedMotion();
  return (
    <motion.a
      href={href}
      className={`brutal-card p-5 block no-underline text-fg ${className}`}
      whileHover={
        reduced
          ? { opacity: 0.92 }
          : { x: -3, y: -3, boxShadow: '9px 9px 0 0 var(--shadow)' }
      }
      whileTap={reduced ? undefined : { x: 1, y: 1 }}
      transition={{ duration: 0.12, ease: [0.4, 0, 0.2, 1] }}
    >
      {children}
    </motion.a>
  );
}
