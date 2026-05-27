// Drift commit-count thresholds, shared between the dashboard and the repo page.
export type DriftLevel = 'ok' | 'warn' | 'danger';

export function driftLevel(commits: number | null | undefined): DriftLevel {
  if (commits == null || commits <= 0) return 'ok';
  if (commits <= 10) return 'warn';
  return 'danger';
}

export function driftLabel(level: DriftLevel): string {
  return level === 'ok' ? 'fresh' : level === 'warn' ? 'drift' : 'stale';
}

export function driftChipClass(level: DriftLevel): string {
  return level === 'ok' ? 'chip-ok' : level === 'warn' ? 'chip-warn' : 'chip-danger';
}
