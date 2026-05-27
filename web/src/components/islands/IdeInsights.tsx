// IdeInsights — repo-level cartograph context pane for the IDE.
//
// Surfaces:
//   - bedrock entries (overview / architecture / conventions) with quick
//     links into the dashboard
//   - topic notes for this repo
//   - walkthroughs that mention the repo
//   - episodes tagged with the repo
//
// Read-only. Companion to the embedded code-server iframe — gives the user
// a way to keep Cartograph context on screen while exploring code in the IDE.
import { useEffect, useState } from 'react';

interface RepoStatus {
  name: string;
  backfilled_from_sha: string | null;
  upstream_sha: string | null;
  topics_count: number;
  walkthroughs_count: number;
}

interface StatusPayload {
  repos: Record<string, RepoStatus>;
}

interface TopicMeta {
  slug: string;
  topic: string;
}

interface State {
  status: RepoStatus | null;
  topics: TopicMeta[];
  loading: boolean;
  error: string | null;
}

interface Props {
  repo: string;
}

export default function IdeInsights({ repo }: Props) {
  const [state, setState] = useState<State>({
    status: null,
    topics: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/api/status').then((r) => r.json() as Promise<StatusPayload>),
    ])
      .then(([statusPayload]) => {
        if (cancelled) return;
        setState({
          status: statusPayload.repos[repo] ?? null,
          topics: [],
          loading: false,
          error: null,
        });
      })
      .catch((e) => {
        if (!cancelled) {
          setState((s) => ({ ...s, loading: false, error: String(e) }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  if (state.loading) {
    return (
      <div className="font-mono text-xs text-muted">loading insights…</div>
    );
  }
  if (state.error) {
    return (
      <div className="font-mono text-xs">
        <div className="text-danger font-bold">error</div>
        <div className="text-muted">{state.error}</div>
      </div>
    );
  }

  const status = state.status;
  return (
    <div>
      <div className="font-mono text-[11px] uppercase tracking-widest text-muted mb-3">
        cartograph · <code className="text-fg">{repo}</code>
      </div>

      {status && (
        <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 font-mono text-xs mb-4">
          <dt className="text-muted">bedrock</dt>
          <dd>
            <code className="text-fg">{status.backfilled_from_sha ?? '—'}</code>
          </dd>
          <dt className="text-muted">upstream</dt>
          <dd>
            <code className="text-fg">{status.upstream_sha ?? '—'}</code>
          </dd>
          <dt className="text-muted">topics</dt>
          <dd className="text-fg">{status.topics_count}</dd>
          <dt className="text-muted">walkthrough</dt>
          <dd className="text-fg">{status.walkthroughs_count}</dd>
        </dl>
      )}

      <div className="space-y-3">
        <section>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted mb-1.5">
            bedrock
          </div>
          <ul className="font-mono text-xs space-y-1">
            {['overview', 'architecture', 'conventions'].map((layer) => (
              <li key={layer}>
                <a
                  href={`/repo/${repo}/bedrock/${layer}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-accent"
                >
                  {layer} ↗
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted mb-1.5">
            quick links
          </div>
          <ul className="font-mono text-xs space-y-1">
            <li>
              <a
                href={`/repo/${repo}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent"
              >
                repo dashboard ↗
              </a>
            </li>
            <li>
              <a
                href={`/ramp-up/${repo}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent"
              >
                ramp-up path ↗
              </a>
            </li>
            <li>
              <a
                href={`/walkthroughs/`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent"
              >
                walkthroughs ↗
              </a>
            </li>
            <li>
              <a
                href={`/seams/`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent"
              >
                cross-repo seams ↗
              </a>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
