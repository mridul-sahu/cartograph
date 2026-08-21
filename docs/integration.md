# Cartograph integration — every claude session compounds the knowledge base

**Cartograph gets better with each Claude session.** The session that
holds the context writes episodes, promotes them to topic notes, and
folds compelling topics into bedrock (all via slash commands). The
deterministic chassis surfaces the work; the UI is read-and-review.

Every Claude Code session whose `cwd` is anywhere under
`<cartograph-root>/` — including the cartograph root,
`workspace/<repo>/`, `web/`, etc. — runs through the same chassis. The
chassis is wired in `.claude/settings.json`; this doc lists exactly
what fires and what it captures.

## The compounding loop (TL;DR)

```
                         IN-SESSION /promote <tag>                 IN-SESSION fold
                         (the digest suggests it;                  (topic blessed, not rejected)
                          ≥3 not yet distilled under the tag)
                          ─────────────────────────►                ───────────────────────►
  session ──► episode  ────────────────────────►  topic note  ────────────────────────►  bedrock
   AUTO       YOU WRITE IT                          the session                           (surgical edit,
   every      (Stop hook                            distills the                          the session adds the
   session    reminds at                            episodes itself                       reference itself)
              ≥3 edits)                                                                   last_revised bumped
                  │                                       │                                  │
                  ▼                                       ▼                                  ▼
              user may veto             folds to bedrock IMMEDIATELY,                    user may veto
              (rejected: true)          same session, no review gate                     (rejected: true)
```

**Veto-only**: nothing waits for approval; every note is eligible for
the next step unless the human sets `rejected: true`.

## The four lifecycle events

| Event | Scripts fired (in order) | What they do |
|---|---|---|
| **SessionStart** | `session-log.sh start` · serve self-heal · drift kick · digest cache | Writes a new session log file, repairs the serve daemon if needed, kicks the deterministic drift pass for the current fork, and prints daemon-precomputed /promote candidates. Upstream fetch + drift reports come from the daemon's 6h loop. (`gh` identity is verified by `scripts/doctor.sh` rather than auto-switched.) |
| **UserPromptSubmit** | `inject-context.sh` | Reads `cwd` → injects **identity reminder** + **hard discipline block** + bedrock for the repo + cross-repo seams + top-3 topic notes by keyword + top-3 episodes + top-3 research notes + revision reminder. Claude sees this before every turn. |
| **PostToolUse** (Edit / Write / NotebookEdit) | `token-check.sh` · `session-log.sh touch` | Scans the new content for forbidden identity tokens (framework defaults + `CARTOGRAPH_FORBIDDEN_EXTRAS`). Appends a `- HH:MM:SS  <tool>` line to the session log. |
| **Stop** | `episode-prompt.sh` · `session-log.sh stop` | Reminds Claude to write an episode if anything was learned. Finalises the session log: bumps `ended_at`, and if ≥3 edits happened but no episode was written, appends a "hint at stop" block to the log so the gap is auditable later. |

## What is captured

| Captured | Where it lives | When |
|---|---|---|
| **Session log** (one file per session) | `sessions/<YYYY-MM>/<YYYY-MM-DD>-<HHMMSS>-<scope>.md` | Auto, every session |
| **File-touched audit** (Edit / Write / NotebookEdit) | Inside the session log's `## tool use log` section | Auto, every tool use |
| **Drift report** (when upstream moved past bedrock) | `.drift-reports/<repo>.md` | Auto via the daemon's 6h upstream-sync loop |
| **Episode** (session worknote) | `episodes/<YYYY-MM>/<YYYY-MM-DD>-<slug>.md` | Manual — Claude writes if it learned something. Stop hook hints if it didn't. |
| **Research note** (external context / comparisons) | `research/<repo>/<slug>.md` | Manual — `/research <repo> <slug>` |
| **Paper note** (academic paper / RFC) | `papers/<repo>/<slug>/notes.md` | Manual |
| **Topic-note revision** (when contradicted by code) | `guides/<repo>/topics/<slug>.md` | Manual — Claude edits in place per CLAUDE.md §7 |
| **Bedrock revision** (when section out of date) | `guides/<repo>/{overview,architecture,conventions}.md` | Manual — resolve the drift in-session per CLAUDE.md §3b, or `/backfill <repo>` for structural drift |

## The hard rules — enforced on every turn

These appear at the top of every Claude Code session via the
`UserPromptSubmit` injection, so every prompt sees them:

### Identity (fork sessions only)

- Author email: `[your-email]`. The `commit-msg` hook in each
  fork enforces.
- No `Co-Authored-By: Claude` trailers. No mention of
  Cartograph / Claude / Anthropic in any commit, branch, PR, or code comment.
- No generic comments — only WHY notes when non-obvious.
- Push only via `git@github.com:` URLs. The `pre-push` hook in each
  fork enforces.

### Discipline (every layer)

Before writing ANY new content under `cartograph/`:

1. **Read** what the inject-context hook already surfaced. If your insight
   overlaps with existing content, **REVISE IT IN PLACE** — bump
   `last_revised:`, add a `## YYYY-MM-DD update:` section, do NOT create
   a new file with a similar slug.
2. **Pick the right layer:**

   | Insight shape | Layer |
   |---|---|
   | task-driven, from THIS session | episode (200-600w) |
   | external paper / RFC / design doc | paper note |
   | exploratory comparison / external context | research note |
   | stable mental model | revise existing topic note |
   | cross-repo edge | append to `guides/seams.md` |

3. **Bump frontmatter** on anything touched (`last_revised:`,
   `backfilled_from_sha:`, `superseded_by:`, `distilled_into:`).

See [docs/revision-discipline.md](./revision-discipline.md) for the full
decision table and per-layer rules.

## Backstop gates (the system enforces beyond the prompt)

| Gate | Where | What it blocks |
|---|---|---|
| `PostToolUse` token-check | `scripts/token-check.sh` | Forbidden tokens (framework defaults + `CARTOGRAPH_FORBIDDEN_EXTRAS`) in any file Claude writes. Soft warning (early signal). |
| `commit-msg` per-fork hook | `workspace/<repo>/.git/hooks/commit-msg` | Same regex on commit messages. **Hard reject.** |
| `pre-push` per-fork hook | `workspace/<repo>/.git/hooks/pre-push` | Requires the push URL to use `CARTOGRAPH_SSH_HOST_ALIAS` (so the push authenticates as the configured `CARTOGRAPH_GITHUB_USER`). **Hard reject.** |
| `cgh pr create` wrapper | shell alias | Runs the same regex on PR title + body before submission. **Hard reject.** |
| Content lint | `scripts/lint-content.sh` | Hard-fails for missing required sections in bedrock; soft-warns for below-floor word counts. Runnable via `/lint`, `/api/lint`, or the **lint panel** on `/console/`. |
| Drift self-heal | `scripts/serve.py:_drift_summary` | If bedrock sha matches upstream sha, deletes stale drift report files so the UI reflects reality. |

## Session logs

Every session is recorded under `sessions/<YYYY-MM>/` (start/end times,
scope, per-tool-use audit trail, hint-at-stop blocks). They are plain
files: browse them in the repo or query them via
`scripts/cartograph_query.py`. There is no dedicated UI surface.

## Adjacent-repo detection

`/api/adjacent-repos` scans `guides/`, `episodes/`, `research/`, `papers/`
for substring matches of a configurable watch-list of common adjacent
libraries. Candidates over the threshold
(≥5 mentions across ≥2 files) get surfaced on `/seams/` with a "set up
in cartograph" panel — 4-step install: `fork-setup.sh` → REPOS edit →
`/backfill` in a session → restart. Once a candidate is added as a tracked
fork, it'll be excluded from suggestions.

## Topology summary

```
<cartograph-root>/
├── .claude/
│   ├── settings.json          ← the 4 lifecycle hooks
│   └── commands/              ← /research /lint /backfill /episode (planned)
├── scripts/                   ← every hook + script the chassis fires
│   ├── session-log.sh         ← new — captures every session
│   ├── inject-context.sh      ← UserPromptSubmit (top of every turn)
│   ├── upstream-sync.sh       ← SessionStart
│   ├── episode-prompt.sh      ← Stop
│   ├── token-check.sh         ← PostToolUse
│   ├── digest.sh              ← SessionStart (promotion candidates)
│   ├── lint-content.sh        ← runs via /api/lint
│   ├── fork-setup.sh          ← bootstrap a new repo
│   └── drift-check.sh         ← writes drift reports
├── guides/                    ← bedrock + topic notes (cartograph's authoritative)
├── learn/                     ← walkthroughs + ramp-ups + drafts
├── episodes/                  ← session worknotes (auto-suggested)
├── research/                  ← intermediate notes (revise in place)
├── papers/                    ← bookshelf with optional inline PDF
├── sessions/                  ← session log (auto, every session)
├── docs/
│   ├── quality-bar.md         ← content-quality floors
│   ├── revision-discipline.md ← per-layer revision rules
│   └── integration.md         ← THIS DOC
├── workspace/<repo>/          ← tracked forks (gitignored from cartograph)
│   ├── .git/hooks/{commit-msg, pre-push}  ← per-fork backstops
│   └── CLAUDE.md              ← per-fork identity + discipline (.git/info/exclude'd)
└── web/                       ← the dashboard
```

## Lifecycle — how layers promote

The layers don't merge automatically. Each promotion is a deterministic
invocation, but the *decision* to invoke is editorial.

### The full promotion graph

```
                                  /promote (≥3 same tag)        in-session fold OR drift fix
session log  ──►  episode  ──────────────────────────►  topic note  ───────────────────────────►  bedrock
   AUTO          MANUAL                                 MANUAL                                     MANUAL

research note  ──(manual revise into topic when stable)──►  topic note
paper note     ──(manual reference from topic when relevant)──►  topic note

draft  ──/promote-draft──►  walkthrough           (essay-shape promotion only)
episode  ──(manual essay expansion)──►  draft     (when an insight grows essay-shaped)
topic    ──(manual essay expansion)──►  draft

seams.md  ←─(append-only)──  any layer whose insight crosses repos
```

### What does NOT happen

| Asked-about path | Why it isn't a thing |
|---|---|
| **draft → episode** | Different shapes. Drafts are essay-shaped, 1500w+, kind `blog-draft`. Episodes are session worknotes, 200–600w, kind `episode`. If an insight is essay-shaped, it stays a draft → walkthrough. Episodes that grow ESSAY-shaped go the *other* direction (episode → draft). |
| **paper → bedrock directly** | Bedrock is OUR repos' mental model. External papers can inform topic notes (which can then fold into bedrock), but a paper itself doesn't get merged into bedrock. |
| **research → bedrock directly** | Same reason — research is exploratory; bedrock is curated. Promote research → topic when it stabilises, then fold the topic into bedrock if compelling. |
| **walkthrough → topic note** | Walkthroughs are narratives; topic notes are reference. They serve different audiences. A walkthrough's insight can prompt revising a topic note, but you wouldn't "demote" a walkthrough into a topic. |

| Transition | Mechanism | What's automatic | What's manual |
|---|---|---|---|
| **session → episode** | Stop hook → `episode-prompt.sh` REMINDS the session (≥3 edits + no episode for today) to write its own episode via `/episode` or a direct Write. No background drafting exists. | the reminder + the discipline scorecard | the session (or the user) writes the episode itself; threshold via `CARTOGRAPH_AUTO_EPISODE_THRESHOLD=N` |
| **3+ episodes → topic note** | AUTOMATIC: the digest / post-edit signal issues a distillation contract; the session runs the `/promote` procedure itself (dedup-first merge into an existing topic, graph edges, tag canonicalization) | detection AND execution (the session distills without being asked) | veto only: set `rejected: true` on any note to stop it flowing; `reviewed_by_human` is optional signal |
| **topic note → bedrock revision** | Two automatic in-session paths: (1) **on ingestion** — the ingestion report (upstream moved) is a contract: absorb the new behavior into the notes per CLAUDE.md §3b, or `/backfill <repo>` for structural change; (2) **on fold** — immediate at distillation time: a 1-3 sentence cross-linked reference in the most affected bedrock file, `folded_into_bedrock:` stamped, replace-not-append under the word budget | detection AND execution (contracts, no asking) | veto only (`rejected: true`) |
| **research note → topic note** | Manual `Edit` (no API endpoint yet). Topic notes are the durable layer; research notes are intermediate | nothing — this is an editorial decision | full manual edit; bump `distilled_into:` on the research note |
| **draft → walkthrough** | "promote to walkthrough" button on `/drafts/<slug>/` → POST `/api/promote-draft/<slug>` | the file move + frontmatter bump (`kind: draft → walkthrough`, `last_revised: today`) | the human decision to promote; review diff before commit |

### Is it deterministic?

| | Deterministic | Heuristic | Editorial |
|---|---|---|---|
| Session log | ✓ (every session, always) | | |
| Drift report | ✓ (SessionStart hook, always when behind) | | |
| Stop hint | ✓ (fires if ≥3 edits and no episode) | | |
| Episode content quality | | ✓ (the session writes; user may veto) | |
| Promote candidates list | ✓ (≥3 same tag, not distilled) | | |
| Topic note draft (from /promote) | | ✓ (the session distills; needs review) | |
| Bedrock revision | | | ✓ (user-triggered) |
| Audit (`reviewed_by_human:`) | | | ✓ (always human) |

The *capture* of every session is deterministic. The *promotion* of
content between layers is in-session work — the system surfaces
candidates, the session does the heavy lifting, and the
**human decides when to promote and reviews every draft**. This is the
intended design: cartograph compounds value through revision, and
revision is an editorial judgment.

## Verification

Every claim in this doc has a corresponding `/api/*` endpoint or a CLI
command that proves it's working. From the dashboard:

- `/console/` — review queue, lint panel, promotion candidates
- `/seams/` — cross-repo edges + adjacent-repo candidates
- `/api/status` / `/api/lint` / `/api/adjacent-repos` — JSON

From the terminal:

- `bash scripts/session-log.sh start` then `... touch` then `... stop`
  exercises the lifecycle and writes a real session file under `sessions/`.
- `bash scripts/lint-content.sh --human` runs the full content lint.
- `bash scripts/drift-check.sh` writes drift reports if any are needed.
- `bash scripts/metrics.sh --human` prints per-repo counts.
