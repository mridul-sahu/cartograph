// At-a-glance server health for the header. Polls /api/health every 60s and
// renders a colored dot linking to /settings. green = healthy, amber =
// degraded (github unreachable or doctor FAIL), red = server unreachable.
import { useEffect, useState } from 'react';

type Phase = 'loading' | 'ok' | 'degraded' | 'down';

export default function ServerHealthDot() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [label, setLabel] = useState('checking');

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const r = await fetch('/api/health');
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (cancelled) return;
        const githubOk = Boolean(j?.github?.reachable);
        const doctorOk = j?.doctor?.status === 'OK';
        if (githubOk && doctorOk) {
          setPhase('ok');
          setLabel('healthy');
        } else {
          setPhase('degraded');
          setLabel(!githubOk ? 'github down' : 'doctor');
        }
      } catch {
        if (!cancelled) {
          setPhase('down');
          setLabel('offline');
        }
      }
    }
    check();
    const id = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const color =
    phase === 'ok' ? 'var(--ok)'
    : phase === 'degraded' ? 'var(--warn)'
    : phase === 'down' ? 'var(--danger)'
    : 'var(--muted)';

  return (
    <a
      href="/settings/"
      title={`server: ${label}`}
      aria-label={`server health: ${label}`}
      className="flex items-center gap-1.5 font-mono text-xs text-muted hover:text-fg no-underline whitespace-nowrap"
    >
      <span
        aria-hidden
        style={{ width: 9, height: 9, borderRadius: 9999, background: color, display: 'inline-block' }}
        className={phase === 'down' ? 'animate-pulse' : undefined}
      />
      <span className="hidden lg:inline">{label}</span>
    </a>
  );
}
