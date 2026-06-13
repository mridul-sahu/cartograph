# Cartograph integration — every claude session compounds the knowledge base

**Cartograph gets better with each Claude session, automatically.** The
chassis runs `claude -p` in the background to draft episodes, promote
them to topic notes, and fold compelling topics into bedrock. The UI
is for management and audit — not for triggering the compounding loop.

Every Claude Code session whose `cwd` is anywhere under
`<cartograph-root>/` — including the cartograph root,
`workspace/<repo>/`, `web/`, etc. — runs through the same chassis. The
chassis is wired in `.claude/settings.json`; this doc lists exactly
what fires and what it captures.

## The compounding loop (TL;DR)

```
                         AUTO at SessionStart                      AUTO at SessionStart
                         scripts/auto-promote.sh                   scripts/auto-promote.sh
                         (≥3 same-tag, non-rejected)               (reviewed_by_human set, not rejected)
                          ─────────────────────────►                ───────────────────────►
  session ──► episode  ────────────────────────►  topic note  ────────────────────────►  bedrock
   AUTO       AUTO-DRAFT                            AUTO-DRAFT                            (surgical edit)
   every      (Stop hook,                           (background                           (background
   session    ≥3 edits)                              claude -p)                            claude -p)
              auto_drafted=true                      auto_promoted=true                    last_revised bumped
                  │                                       │                                  │
                  ▼                                       ▼                                  ▼
              user reviews              user reviews + approves (default-approve)        user reviews diff
              approve / reject          → unblocks bedrock fold                          → commits when satisfied
              (UI buttons)              reject → halt promotion forever
```

**Default-approve**: unreviewed auto-drafts are ELIGIBLE for the next
step. Rejection is opt-out, not opt-in.

## The four lifecycle events

| Event | Scripts fired (in order) | What they do |
|---|---|---|
| **SessionStart** | `session-log.sh start` · `upstream-sync.sh` · `digest.sh` | Writes a new session log file. Fetches upstream's default branch + writes a drift report if behind. Surfaces ≥3-episodes-same-tag promotion candidates. (`gh` identity is verified by `scripts/doctor.sh` rather than auto-switched.) |
| **UserPromptSubmit** | `inject-context.sh` | Reads `cwd` → injects **identity reminder** + **hard discipline block** + bedrock for the repo + cross-repo seams + top-3 topic notes by keyword + top-3 episodes + top-3 research notes + revision reminder. Claude sees this before every turn. |
| **PostToolUse** (Edit / Write / NotebookEdit) | `token-check.sh` · `session-log.sh touch` | Scans the new content for forbidden identity tokens (framework defaults + `CARTOGRAPH_FORBIDDEN_EXTRAS`). Appends a `- HH:MM:SS  <tool>` line to the session log. |
| **Stop** | `episode-prompt.sh` · `session-log.sh stop` | Reminds Claude to write an episode if anything was learned. Finalises the session log: bumps `ended_at`, and if ≥3 edits happened but no episode was written, appends a "hint at stop" block to the log so the gap is auditable later. |

## What is captured

| Captured | Where it lives | When |
|---|---|---|
| **Session log** (one file per session) | `sessions/<YYYY-MM>/<YYYY-MM-DD>-<HHMMSS>-<scope>.md` | Auto, every session |
| **File-touched audit** (Edit / Write / NotebookEdit) | Inside the session log's `## tool use log` section | Auto, every tool use |
| **Drift report** (when upstream moved past bedrock) | `.drift-reports/<repo>.md` | Auto on SessionStart |
| **Episode** (session worknote) | `episodes/<YYYY-MM>/<YYYY-MM-DD>-<slug>.md` | Manual — Claude writes if it learned something. Stop hook hints if it didn't. |
| **Research note** (external context / comparisons) | `research/<repo>/<slug>.md` | Manual — `/research <repo> <slug>` |
| **Paper note** (academic paper / RFC) | `papers/<repo>/<slug>/notes.md` | Manual |
| **Topic-note revision** (when contradicted by code) | `guides/<repo>/topics/<slug>.md` | Manual — Claude edits in place per CLAUDE.md §7 |
| **Bedrock revision** (when section out of date) | `guides/<repo>/{overview,architecture,conventions}.md` | Manual — `/auto-revise` from /status UI, or `bash scripts/auto-revise.sh <repo>` |

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
| Content lint | `scripts/lint-content.sh` | Hard-fails for missing required sections in bedrock; soft-warns for below-floor word counts. Runnable via `/lint`, `/api/lint`, or the **lint panel** on `/status/`. |
| Drift self-heal | `scripts/serve.py:_drift_summary` | If bedrock sha matches upstream sha, deletes stale drift report files so the UI reflects reality. |

## Session log — UI

`/sessions/` lists every recorded session with:

- start / end times
- scope (`cartograph` vs `fork-<repo>`)
- file-touched count
- whether an episode was written (auto-detected — looks for an episode
  file newer than the session start)
- a "missed-episode" badge when ≥3 edits happened but no episode was
  written, so you can audit gaps after the fact

Aggregated stats appear on `/status/` next to the lint panel.

## Adjacent-repo detection

`/api/adjacent-repos` scans `guides/`, `episodes/`, `research/`, `papers/`
for substring matches of a configurable watch-list of common adjacent
libraries. Candidates over the threshold
(≥5 mentions across ≥2 files) get surfaced on `/seams/` with a "set up
in cartograph" panel — 4-step install: `fork-setup.sh` → REPOS edit →
`backfill-bedrock.sh` → restart. Once a candidate is added as a tracked
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
│   ├── auto-revise.sh         ← /api/auto-revise
│   ├── backfill-bedrock.sh    ← /api/backfill
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
                                  /promote (≥3 same tag)        fold-into-bedrock OR auto-revise
session log  ──►  episode  ──────────────────────────►  topic note  ───────────────────────────►  bedrock
   AUTO          MANUAL                                 SEMI-AUTO                                  MANUAL

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
| **session → episode** | Stop hook → `episode-prompt.sh` AUTO-DRAFTS via background `claude -p` when ≥3 edits + no episode for today; user reviews on `/episodes/<slug>/` (the draft has `auto_drafted: true` in frontmatter). User can also still run `/episode` manually or click "write episode" on `/sessions/<slug>/` | the draft itself (claude -p runs in the background, no user action needed) | the user reviews the draft; decides to keep, edit, or mark trivial. Opt-out via `CARTOGRAPH_AUTO_EPISODE=0`; threshold via `CARTOGRAPH_AUTO_EPISODE_THRESHOLD=N` |
| **3+ episodes → topic note** | `/api/promote/<tag>` → `scripts/promote-tag.sh` invokes claude -p with all matching non-distilled episodes; drafts `guides/<repo>/topics/<tag>.md`; sets `distilled_into:` on each source | finding the candidates (`digest.sh` SessionStart hook, `/api/promote-candidates`), the claude invocation, the frontmatter bookkeeping | the human decision to promote (it's editorial); the user reviews the drafted topic note + signs off via the audit panel (`reviewed_by_human`) |
| **topic note → bedrock revision** | Two paths: (1) **on contradiction** — `/auto-revise/<repo>` button or `bash scripts/auto-revise.sh <repo>` rewrites bedrock against current code via `claude -p` + `docs/quality-bar.md`; (2) **on editorial fold** — the **"fold into bedrock" button** on `/repo/<repo>/topics/<slug>/` (POST `/api/topic/<repo>/<topic>/fold-into-bedrock` → `scripts/fold-topic-to-bedrock.sh`) does a SURGICAL update: claude picks the most affected bedrock file (overview / architecture / conventions), adds a 1–3 sentence reference under the relevant section, bumps `last_revised:`, and leaves the topic note unchanged. The topic stays the deep dive; bedrock just gets a pointer + the load-bearing sentence | claude -p invocation, file selection, lint re-runs after | the user decides this topic's insight is compelling enough to fold (or that bedrock has fallen behind code) |
| **research note → topic note** | Manual `Edit` (no API endpoint yet). Topic notes are the durable layer; research notes are intermediate | nothing — this is an editorial decision | full manual edit; bump `distilled_into:` on the research note |
| **draft → walkthrough** | "promote to walkthrough" button on `/drafts/<slug>/` → POST `/api/promote-draft/<slug>` | the file move + frontmatter bump (`kind: draft → walkthrough`, `last_revised: today`) | the human decision to promote; review diff before commit |

### Is it deterministic?

| | Deterministic | Heuristic | Editorial |
|---|---|---|---|
| Session log | ✓ (every session, always) | | |
| Drift report | ✓ (SessionStart hook, always when behind) | | |
| Stop hint | ✓ (fires if ≥3 edits and no episode) | | |
| Episode auto-draft (≥3 edits + no episode for today) | ✓ (background `claude -p` at Stop hook) | | |
| Episode content quality | | ✓ (claude drafts; user reviews) | |
| Promote candidates list | ✓ (≥3 same tag, not distilled) | | |
| Topic note draft (from /promote) | | ✓ (claude drafts; needs review) | |
| Bedrock revision | | | ✓ (user-triggered) |
| Audit (`reviewed_by_human:`) | | | ✓ (always human) |

The *capture* of every session is deterministic. The *promotion* of
content between layers is semi-automatic — the system surfaces candidates
and runs the heavy lifting (claude -p with the right context), but the
**human decides when to promote and reviews every draft**. This is the
intended design: cartograph compounds value through revision, and
revision is an editorial judgment.

## Verification

Every claim in this doc has a corresponding `/api/*` endpoint or a CLI
command that proves it's working. From the dashboard:

- `/status/` — drift / lint / PRs / freshness gauges (live data)
- `/sessions/` — full session log (chronological)
- `/seams/` — cross-repo edges + adjacent-repo candidates
- `/api/status` / `/api/lint` / `/api/sessions` / `/api/adjacent-repos` — JSON

From the terminal:

- `bash scripts/session-log.sh start` then `... touch` then `... stop`
  exercises the lifecycle and writes a real session file under `sessions/`.
- `bash scripts/lint-content.sh --human` runs the full content lint.
- `bash scripts/drift-check.sh` writes drift reports if any are needed.
- `bash scripts/metrics.sh --human` prints per-repo counts.
