// Single source of truth for the tracked repos. UI surfaces and routes consult
// this list; the FastAPI status server has its own mirror in scripts/serve.py.
export const REPOS = ['jax', 'xla', 'orbax', 'tunix', 'tokamax'] as const;
export type Repo = (typeof REPOS)[number];

export const isRepo = (s: string): s is Repo =>
  (REPOS as readonly string[]).includes(s);
