// RepoDriftBadge — the fresh / drift / stale chip for a single repo,
// shown on that repo's page. Same data + thresholds as the dashboard
// repo cards (StatusPane) so the two never disagree.
import { useEffect, useState } from 'react';
import { driftLevel, driftLabel, driftChipClass } from '~/lib/drift';

export default function RepoDriftBadge({ repo }: { repo: string }) {
  const [commits, setCommits] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/status');
        if (!r.ok) return;
        const json = await r.json();
        const rs = json.repos?.[repo];
        if (!cancelled && rs) setCommits(rs.drift_commits ?? 0);
      } catch {
        /* status server down — the badge just stays absent */
      }
    }
    load();
    const id = setInterval(load, 60_000);
    // A backfill finishing moves the bedrock sha — re-check at once
    // instead of waiting out the 60s tick.
    window.addEventListener('cartograph:refresh', load);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('cartograph:refresh', load);
    };
  }, [repo]);

  if (commits == null) return null;
  const level = driftLevel(commits);
  return (
    <span className={`chip ${driftChipClass(level)}`}>
      {driftLabel(level)} · {commits}
    </span>
  );
}
