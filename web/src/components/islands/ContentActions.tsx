// ContentActions — unified action bar for content pages.
//
// Renders a vertical column of action buttons appropriate for the content
// type (bedrock / topic / episode / draft) the page is showing.
//
// Actions are intentionally cheap to ship: most either invoke an existing
// API endpoint or open the underlying file in code-server in a new tab.
// Heavy operations (re-backfill, promote-draft) get a Confirm step.
//
// Props:
//   kind                 'bedrock' | 'topic' | 'episode' | 'draft'
//   repo                 repo slug (always set except for cross-cutting content)
//   slug                 e.g. "sharding-and-pjit" (topic) or "2026-05-22-...-jax-..." (episode)
//   filePath             relative-to-cartograph file path (used for "open in editor")
//   layer?               for bedrock: 'overview' | 'architecture' | 'conventions'
import { useState } from 'react';
import {
  motion,
  AnimatePresence,
  useReducedMotion,
} from 'motion/react';
import AskClaude from './AskClaude';

type ContentKind = 'bedrock' | 'topic' | 'episode' | 'draft' | 'research' | 'paper';

interface Props {
  kind: ContentKind;
  repo?: string;
  slug?: string;
  layer?: 'overview' | 'architecture' | 'conventions';
  filePath: string;
  codeServerOrigin?: string;
  cartographRoot?: string;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

export default function ContentActions({
  kind,
  repo,
  slug,
  layer,
  filePath,
  codeServerOrigin = 'http://localhost:47780',
  cartographRoot = '<cartograph-root>',
}: Props) {
  const reduced = useReducedMotion();
  const press = reduced ? {} : { x: 2, y: 2, boxShadow: '0 0 0 0 var(--shadow)' };
  const hover = reduced ? {} : { x: -1, y: -1 };

  // Editor URL: open code-server pointing at the cartograph repo root,
  // with this file pre-selected. (workspace/<repo>/ is the OTHER folder
  // we run code-server against by default for /browse/<repo>/.)
  const editorPayload = JSON.stringify([
    [
      'openFile',
      `vscode-remote://${codeServerOrigin.replace(/^https?:\/\//, '')}${cartographRoot}/${filePath}`,
    ],
  ]);
  const editorUrl = `${codeServerOrigin}/?folder=${encodeURIComponent(
    cartographRoot,
  )}&payload=${encodeURIComponent(editorPayload)}`;

  return (
    <div className="brutal-card p-4 space-y-4">
      <div>
        <div className="font-mono text-xs uppercase tracking-widest text-muted mb-2">
          actions
        </div>
        <div className="space-y-2">
          <ActionLink
            href={editorUrl}
            label="open in editor ↗"
            description="opens this markdown file in code-server (new tab)"
            press={press}
            hover={hover}
          />

          {kind === 'bedrock' && repo && (
            <RebackfillAction repo={repo} press={press} hover={hover} />
          )}

          {kind === 'draft' && slug && (
            <PromoteDraftAction slug={slug} press={press} hover={hover} />
          )}

          {kind === 'topic' && repo && slug && (
            <FoldIntoBedrockAction repo={repo} topic={slug} press={press} hover={hover} />
          )}

          {kind === 'episode' && (
            <ActionLink
              href={`/episodes/`}
              label="see all episodes ↗"
              description="distill into a topic note via /promote when ≥3 share a tag"
              press={press}
              hover={hover}
            />
          )}

          <ActionLink
            href={`/api/code/${repo ?? 'jax'}/`}
            label="view raw markdown ↗"
            description="raw frontmatter + body via /api/code"
            press={press}
            hover={hover}
            disabled
            disabledNote="raw view: see git or open the file in editor"
          />
        </div>
      </div>

      <div className="border-t-2 border-border pt-4">
        <AskClaude
          kind={
            kind === 'bedrock'
              ? 'review-bedrock'
              : kind === 'topic'
              ? 'review-topic'
              : kind === 'episode'
              ? 'review-episode'
              : kind === 'research'
              ? 'review-research'
              : kind === 'paper'
              ? 'review-paper'
              : 'review-draft'
          }
          repo={repo}
          context={filePath}
          title={`ask claude to review this ${kind}`}
          placeholder={
            kind === 'bedrock'
              ? `e.g., "Does the ${layer ?? 'overview'} hold up against the current code?"`
              : kind === 'topic'
              ? `e.g., "Are the file:line citations still accurate?"`
              : kind === 'episode'
              ? `e.g., "Is this still relevant, or should it be superseded?"`
              : kind === 'research'
              ? `e.g., "Fact-check the comparison claims against current code."`
              : `e.g., "Read the spine and tell me where the argument breaks down."`
          }
        />
      </div>
    </div>
  );
}

function ActionLink({
  href,
  label,
  description,
  press,
  hover,
  disabled,
  disabledNote,
}: {
  href: string;
  label: string;
  description?: string;
  press: object;
  hover: object;
  disabled?: boolean;
  disabledNote?: string;
}) {
  if (disabled) {
    return (
      <div className="block p-2 border-2 border-dashed border-border opacity-60">
        <div className="font-mono text-xs uppercase tracking-wider text-muted">
          {label}
        </div>
        {disabledNote && (
          <div className="font-mono text-[10px] text-muted mt-0.5">
            {disabledNote}
          </div>
        )}
      </div>
    );
  }
  return (
    <motion.a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      whileHover={hover}
      whileTap={press}
      transition={{ duration: 0.1 }}
      className="block p-2 border-2 border-border bg-bg text-fg no-underline shadow-brut-sm"
    >
      <div className="font-mono text-xs uppercase tracking-wider">{label}</div>
      {description && (
        <div className="font-mono text-[10px] text-muted mt-0.5">
          {description}
        </div>
      )}
    </motion.a>
  );
}

function FoldIntoBedrockAction({
  repo,
  topic,
  press,
  hover,
}: {
  repo: string;
  topic: string;
  press: object;
  hover: object;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    if (!confirm(
      `Fold "${topic}" into ${repo} bedrock?\n\n` +
      `Surgical update via claude -p: adds a 1–3 sentence reference under the most relevant bedrock section + bumps last_revised. The topic note itself is unchanged.\n\n` +
      `Takes 1–3 minutes. Review the diff before committing.`
    )) return;
    setPhase('running');
    try {
      const res = await fetch(
        `/api/topic/${repo}/${topic}/fold-into-bedrock`,
        { method: 'POST' },
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setResult(data.detail ?? data.note ?? `exit ${data.exit_code ?? '?'}`);
        setPhase('error');
        return;
      }
      setResult(data.note ?? 'folded — review git diff');
      setPhase('done');
    } catch (e) {
      setResult(String(e));
      setPhase('error');
    }
  }

  return (
    <div className="block p-2 border-2 border-accent bg-bg shadow-brut-sm">
      <div className="font-mono text-xs uppercase tracking-wider text-accent">
        fold into {repo} bedrock
      </div>
      <div className="font-mono text-[10px] text-muted mt-0.5 mb-2">
        surgical reference (not a rewrite) — when this topic's insight is
        compelling enough to belong in bedrock
      </div>
      <motion.button
        type="button"
        onClick={run}
        disabled={phase === 'running' || phase === 'done'}
        whileHover={phase === 'running' || phase === 'done' ? {} : hover}
        whileTap={phase === 'running' || phase === 'done' ? {} : press}
        transition={{ duration: 0.1 }}
        className="font-mono text-[11px] uppercase tracking-wider px-2 py-1 border-2 border-border bg-accent text-accent-fg disabled:opacity-50"
      >
        {phase === 'running' ? 'folding…' : phase === 'done' ? 'done' : 'fold'}
      </motion.button>
      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-2 font-mono text-[10px] text-muted break-all"
          >
            {result}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RebackfillAction({
  repo,
  press,
  hover,
}: {
  repo: string;
  press: object;
  hover: object;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setPhase('running');
    try {
      const res = await fetch(`/api/backfill/${repo}`, { method: 'POST' });
      const data = await res.json();
      setResult(
        data.ok ? 'done — review git diff in editor' : `failed: ${data.note ?? ''}`,
      );
      setPhase('done');
    } catch (e) {
      setResult(String(e));
      setPhase('error');
    }
  }

  return (
    <div className="block p-2 border-2 border-border bg-bg shadow-brut-sm">
      <div className="font-mono text-xs uppercase tracking-wider">
        re-backfill {repo} bedrock
      </div>
      <div className="font-mono text-[10px] text-muted mt-0.5 mb-2">
        runs <code>claude -p</code> against docs/quality-bar.md, 1–3 min
      </div>
      <motion.button
        type="button"
        onClick={run}
        disabled={phase === 'running'}
        whileHover={phase === 'running' ? {} : hover}
        whileTap={phase === 'running' ? {} : press}
        transition={{ duration: 0.1 }}
        className="font-mono text-[11px] uppercase tracking-wider px-2 py-1 border-2 border-border bg-accent text-accent-fg disabled:opacity-50"
      >
        {phase === 'running' ? 'running…' : 'run'}
      </motion.button>
      <AnimatePresence>
        {phase !== 'idle' && phase !== 'running' && (
          <motion.div
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-2 font-mono text-[10px] text-muted"
          >
            {result}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PromoteDraftAction({
  slug,
  press,
  hover,
}: {
  slug: string;
  press: object;
  hover: object;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    if (!confirm(`Promote ${slug} from draft to walkthrough?`)) return;
    setPhase('running');
    try {
      const res = await fetch(`/api/promote-draft/${slug}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setResult(data.detail ?? `HTTP ${res.status}`);
        setPhase('error');
        return;
      }
      setResult(data.note ?? `promoted to ${data.to}`);
      setPhase('done');
      // This /drafts/<slug>/ page no longer exists after the rebuild —
      // send the reader to the freshly-built walkthrough.
      setTimeout(() => {
        window.location.href = `/walkthroughs/${slug}/`;
      }, 1800);
    } catch (e) {
      setResult(String(e));
      setPhase('error');
    }
  }

  return (
    <div className="block p-2 border-2 border-border bg-bg shadow-brut-sm">
      <div className="font-mono text-xs uppercase tracking-wider">
        promote to walkthrough
      </div>
      <div className="font-mono text-[10px] text-muted mt-0.5 mb-2">
        moves <code>learn/drafts/{slug}.md</code> →{' '}
        <code>learn/walkthroughs/{slug}.md</code>
      </div>
      <motion.button
        type="button"
        onClick={run}
        disabled={phase === 'running' || phase === 'done'}
        whileHover={phase === 'running' || phase === 'done' ? {} : hover}
        whileTap={phase === 'running' || phase === 'done' ? {} : press}
        transition={{ duration: 0.1 }}
        className="font-mono text-[11px] uppercase tracking-wider px-2 py-1 border-2 border-border bg-accent text-accent-fg disabled:opacity-50"
      >
        {phase === 'running' ? 'promoting…' : phase === 'done' ? 'done' : 'promote'}
      </motion.button>
      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-2 font-mono text-[10px] text-muted break-all"
          >
            {result}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
