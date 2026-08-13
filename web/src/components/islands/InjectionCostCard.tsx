// InjectionCostCard — per-repo orientation-injection token estimates from
// GET /api/injection-cost. Repos flagged budget_warn get the warn treatment.
// Defensive: the endpoint ships separately — accept several payload shapes
// ({repos:[...]}, bare array, or {<repo>: {...}} map) and degrade quietly
// when it is missing.

import { useEffect, useState } from 'react';

interface CostRow {
  repo: string;
  est_tokens: number | null;
  budget_warn: boolean;
}

function toRow(repo: string, v: unknown): CostRow {
  if (typeof v === 'number') return { repo, est_tokens: v, budget_warn: false };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const tokens = o.est_tokens ?? o.tokens ?? o.estimate;
    return {
      repo: typeof o.repo === 'string' ? o.repo : repo,
      est_tokens: typeof tokens === 'number' ? tokens : null,
      budget_warn: o.budget_warn === true,
    };
  }
  return { repo, est_tokens: null, budget_warn: false };
}

function normalize(j: unknown): CostRow[] {
  if (Array.isArray(j)) return j.map((v, i) => toRow(String(i), v)).filter((r) => r.repo);
  if (j && typeof j === 'object') {
    const o = j as Record<string, unknown>;
    if (Array.isArray(o.repos)) return o.repos.map((v, i) => toRow(String(i), v));
    // The live payload: {repos: {<repo>: {...}}, budget_tokens, budget_warn}.
    if (o.repos && typeof o.repos === 'object') {
      return Object.entries(o.repos as Record<string, unknown>).map(([k, v]) => toRow(k, v));
    }
    // Plain {repo: estimate} map — skip envelope-ish keys.
    return Object.entries(o)
      .filter(([k]) => !['generated_at', 'total', 'ok', 'budget_tokens', 'budget_warn'].includes(k))
      .map(([k, v]) => toRow(k, v));
  }
  return [];
}

export default function InjectionCostCard() {
  const [rows, setRows] = useState<CostRow[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/injection-cost')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        if (cancelled) return;
        if (j == null) {
          setUnavailable(true);
          setRows([]);
          return;
        }
        const out = normalize(j);
        out.sort((a, b) => (b.est_tokens ?? 0) - (a.est_tokens ?? 0));
        setRows(out);
      })
      .catch(() => {
        if (!cancelled) {
          setUnavailable(true);
          setRows([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (rows === null) return <p className="p-5 text-sm text-muted">loading…</p>;
  if (rows.length === 0) {
    return (
      <p className="p-5 text-sm text-muted">
        {unavailable
          ? 'Injection-cost feed unavailable — /api/injection-cost not served yet.'
          : 'No injection-cost estimates.'}
      </p>
    );
  }

  return (
    <ul>
      {rows.map((r, i) => (
        <li
          key={r.repo}
          className={`px-5 py-2 font-mono text-xs flex items-center justify-between gap-3 border-b border-[var(--border-soft)] last:border-b-0 ${
            i % 2 === 0 ? 'bg-bg' : 'bg-[var(--surface-1)]'
          }`}
        >
          <span className="flex items-center gap-2 min-w-0">
            <a href={`/repo/${r.repo}/`} className="text-accent hover:underline no-underline truncate">
              {r.repo}
            </a>
            {r.budget_warn && <span className="chip chip-sm chip-warn">over budget</span>}
          </span>
          <span className={r.budget_warn ? 'text-[var(--warn)] font-bold' : 'text-muted'}>
            {r.est_tokens !== null ? `~${r.est_tokens.toLocaleString()} tok` : '—'}
          </span>
        </li>
      ))}
    </ul>
  );
}
