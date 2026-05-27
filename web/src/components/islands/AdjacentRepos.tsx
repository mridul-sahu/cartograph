// AdjacentRepos — surfaces adjacent / candidate repos that show up in
// cartograph content (episodes, research, topic notes) often enough to
// suggest we should track them as forks.
//
// Source: /api/adjacent-repos scans guides/ / episodes/ / research/ /
// papers/ for substring matches of known adjacent project names. When
// a candidate crosses the threshold (≥5 hits across ≥2 files), it's
// marked `suggest_add: true` and rendered as a "consider adding" card
// with a "set up in cartograph" panel that walks through the install.
import { useEffect, useState } from 'react';

// Best-guess upstream for each candidate. Used to pre-fill the
// fork-setup command so the user can paste-and-run without looking it up.
// Not authoritative — the user can edit before running.
const UPSTREAM_HINTS: Record<string, string> = {
  flax: 'google/flax',
  optax: 'google-deepmind/optax',
  qwix: 'google-deepmind/qwix',
  'sglang-jax': 'sgl-project/sglang-jax',
  vllm: 'vllm-project/vllm',
  jaxlib: 'jax-ml/jax', // jaxlib lives in the jax monorepo
  shardy: 'openxla/shardy',
  stablehlo: 'openxla/stablehlo',
  treescope: 'google-deepmind/treescope',
};

interface Suggestion {
  name: string;
  mention_count: number;
  file_count: number;
  files: string[];
  suggest_add: boolean;
}

interface Payload {
  ok: boolean;
  tracked_repos: string[];
  suggestions: Suggestion[];
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: Payload }
  | { kind: 'error'; message: string };

export default function AdjacentRepos() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/adjacent-repos')
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setState({ kind: 'ready', data: d });
      })
      .catch((e) => {
        if (!cancelled) setState({ kind: 'error', message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return <div className="font-mono text-sm text-muted">loading adjacency stats…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="brutal-card p-4 font-mono text-sm">
        <div className="text-danger font-bold">unable to load</div>
        <div className="text-muted">{state.message}</div>
      </div>
    );
  }

  const candidates = state.data.suggestions.filter((s) => s.suggest_add);
  const others = state.data.suggestions.filter((s) => !s.suggest_add);

  return (
    <section>
      <div className="font-mono text-xs text-muted uppercase tracking-widest mb-2">
        adjacent repos — mention frequency in cartograph content
      </div>
      <h2 className="text-2xl md:text-3xl font-bold tracking-tightish mb-3">
        candidate forks
      </h2>
      <p className="text-sm text-muted mb-5 max-w-3xl">
        adjacent projects that show up often in episodes / research / notes.
        when a candidate crosses the threshold (≥5 mentions across ≥2 files),
        it's worth considering as a tracked fork — see
        <code className="font-mono mx-1">scripts/fork-setup.sh</code>.
      </p>

      {candidates.length === 0 ? (
        <div className="brutal-card p-5 font-mono text-sm text-muted">
          no candidates over the threshold yet. write more episodes /
          research notes naming the adjacent repos — when ≥5 mentions
          across ≥2 files accumulate, they'll appear here.
        </div>
      ) : (
        <ul className="space-y-3 mb-8">
          {candidates.map((c) => (
            <CandidateCard key={c.name} c={c} highlighted />
          ))}
        </ul>
      )}

      {others.length > 0 && (
        <details className="brutal-card p-3 font-mono text-xs">
          <summary className="cursor-pointer text-muted">
            other adjacent repos with mentions ({others.length})
          </summary>
          <ul className="mt-3 space-y-2">
            {others.map((c) => (
              <CandidateCard key={c.name} c={c} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function SetupPanel({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const upstreamGuess = UPSTREAM_HINTS[name] ?? `<UPSTREAM_ORG>/${name}`;
  const steps: { label: string; cmd: string; note?: string }[] = [
    {
      label: '1. fork + clone + per-fork hooks',
      cmd: `bash scripts/fork-setup.sh ${name} ${upstreamGuess}`,
      note: 'creates workspace/<name>/, installs commit-msg + pre-push hooks, drops per-fork CLAUDE.md',
    },
    {
      label: '2. add to the tracked-repo list',
      cmd: `# scripts/serve.py — REPOS tuple\n#   ("${name}", ...)\n# web/src/lib/repos.ts — export const REPOS\n#   '${name}',`,
      note: 'until this is dynamic, both files need the new name',
    },
    {
      label: '3. bootstrap bedrock (claude -p, 1–3 min)',
      cmd: `bash scripts/backfill-bedrock.sh ${name}`,
      note: 'writes guides/<name>/{overview,architecture,conventions}.md against docs/quality-bar.md',
    },
    {
      label: '4. rebuild + restart',
      cmd: `cd web && npm run build && cd .. && bash scripts/serve.py &`,
    },
  ];
  async function copy(i: number, cmd: string) {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(i);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="font-mono text-[11px] uppercase tracking-wider px-2 py-1 border-2 border-border bg-bg shadow-brut-sm"
      >
        {open ? 'hide setup ↑' : 'set up in cartograph ↓'}
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          {steps.map((s, i) => (
            <div key={i} className="border-2 border-border p-2 bg-muted-bg">
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted">
                  {s.label}
                </div>
                <button
                  type="button"
                  onClick={() => copy(i, s.cmd)}
                  className="font-mono text-[10px] uppercase tracking-widest text-muted hover:text-accent"
                >
                  {copied === i ? '✓ copied' : 'copy'}
                </button>
              </div>
              <pre className="font-mono text-[11px] whitespace-pre-wrap text-fg break-all">
                {s.cmd}
              </pre>
              {s.note && (
                <div className="font-mono text-[10px] text-muted mt-1 leading-snug">
                  {s.note}
                </div>
              )}
            </div>
          ))}
          <div className="font-mono text-[10px] text-muted leading-snug">
            done in your terminal — run each block in order. step 1 will
            prompt for sudo / gh auth if needed; the others are
            non-interactive.
          </div>
        </div>
      )}
    </div>
  );
}

function CandidateCard({
  c,
  highlighted,
}: {
  c: Suggestion;
  highlighted?: boolean;
}) {
  return (
    <li
      className={`brutal-card p-4 ${
        highlighted ? '' : 'border-dashed'
      }`}
      style={
        highlighted
          ? {
              background:
                'color-mix(in srgb, var(--accent) 8%, var(--bg))',
              borderColor: 'var(--accent)',
            }
          : undefined
      }
    >
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-2">
        <h3 className="font-mono text-lg font-bold tracking-tightish">
          {c.name}
        </h3>
        <div className="font-mono text-xs">
          <span className="text-fg">{c.mention_count}</span>
          <span className="text-muted"> mentions in </span>
          <span className="text-fg">{c.file_count}</span>
          <span className="text-muted"> file{c.file_count === 1 ? '' : 's'}</span>
        </div>
      </div>
      {c.files.length > 0 && (
        <details>
          <summary className="font-mono text-xs cursor-pointer text-muted">
            where it appears
          </summary>
          <ul className="mt-2 font-mono text-[11px] space-y-0.5">
            {c.files.map((f) => (
              <li key={f} className="text-muted break-all">
                {f}
              </li>
            ))}
          </ul>
        </details>
      )}
      {highlighted && <SetupPanel name={c.name} />}
    </li>
  );
}
