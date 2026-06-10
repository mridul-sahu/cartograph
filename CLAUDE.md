# Cartograph — workspace-root protocol

This file is loaded by Claude Code at the start of every session anywhere
under your cartograph clone, including all sessions rooted inside
`workspace/<repo>/`.

Cartograph is a curated, layered notebook that makes Claude faster at
navigating large stable codebases by carrying understanding *forward*
between sessions instead of re-deriving it each time.

The operational rules below are what you must follow during every turn.

---

## 1. Orientation (the UserPromptSubmit hook)

At every user turn, the orientation hook (`scripts/inject-context.sh`)
detects your current scope from `cwd` and injects:

- All bedrock guides for the current repo:
  `guides/<repo>/{overview,architecture,conventions}.md`.
- The cross-repo seams: `guides/seams.md`.
- Topic notes (`guides/<repo>/topics/*.md`): the single best match in
  FULL, plus a **menu** of the next 7 (title + summary + path).
- Episodes (`episodes/YYYY-MM/*.md`, non-superseded, non-distilled,
  repo-scoped): same shape — best match full, menu of the rest.
- Research notes (`research/<repo>/*.md`): menu only.
- A revision reminder.

**Menus are mandatory follow-ups, not decoration.** A menu line means
"this note likely covers part of your task" — `Read` every menu entry
that touches your task before deriving anything from upstream code.
Following a menu is recorded as that note being *useful*; ignoring
relevant entries corrupts the usage signal that ranks future
injections.

Ranking is IDF-weighted keyword overlap with a usage boost for notes
proven useful in past sessions; layers dedup against each other.

**Trust the injection.** Don't re-fetch the bedrock yourself unless the
injection is missing or the keyword match clearly missed relevant
content. If you find guides are wrong or thin, that is a signal to
*improve them*, not a reason to ignore them.

---

## 1a. Cartograph is your first layer — NOT optional

**This is a hard rule.** You do not read upstream code to work out how
something behaves until you have checked cartograph first. The
orientation injection is the *floor* — the keyword matches against your
prompt (one full note + a menu per layer) — never the ceiling.

Every task in a repo, in this exact order:

1. **Read what was injected** — bedrock, topic notes, episodes, research.
2. **Actively widen the search** — `Grep`/`Glob` against `guides/<repo>/topics/`,
   `episodes/`, `research/<repo>/`, `setups/<repo>/`, `designs/<repo>/`,
   `guides/seams.md`. Search by the subsystem name, the file you're
   about to open, the error text, the concept — not just the prompt
   wording.
3. **Only once cartograph genuinely has nothing** may you derive it
   fresh from upstream code. When you do, write the finding back
   (episode / topic / research) before the session ends.

When unsure whether cartograph covers something, assume it might and
search; the cost of one `Grep` is nothing against the cost of
re-deriving a subsystem.

---

## 2. Identity (configurable)

Identity is sourced from `cartograph.env` (see `cartograph.env.example`
for the schema). Inside `workspace/<repo>/`, you commit and push as the
configured GitHub user; outside that scope, normal Claude Code
conventions apply.

The framework enforces a content firewall on fork commits, branches,
and PR titles/descriptions: no mention of `cartograph`, `anthropic`,
`claude code/opus/sonnet/haiku`, or anything listed in
`CARTOGRAPH_FORBIDDEN_EXTRAS`. The `commit-msg` and `pre-push` hooks
installed by `just add-repo` are the hard backstop; `token-check.sh`
warns earlier on every Edit/Write.

`scripts/doctor.sh` verifies that every fork's `user.name`,
`user.email`, remote URLs, hooks, and bedrock files match config —
re-run it any time identity feels drifted.

---

## 3. Navigation in a tracked codebase

- **To find code**: `Glob` and `Grep` directly.
- **To understand how code behaves**: read the file. If a topic note
  disagrees with the code, see §4 (revision).
- **To run something** (see a jaxpr, exercise a function, etc.):
  `Bash`. Cartograph doesn't wrap these.
- **To find references precisely**: run the project's LSP via Bash
  (`pyright`, `pylsp`, `clangd`), or fall back to `Grep`.

---

## 4. Revision discipline (the load-bearing rule)

The thing that makes cartograph *get better* and not just *bigger* is
that topic notes are revised in place when evidence demands it.

You revise a topic note when:

1. You have just read it (it was injected at orientation).
2. You read code that **contradicts** what the topic note says — not
   "adds nuance," not "is slightly different in this branch" —
   *contradicts*.
3. You run `git log -- <cited-files>` filtered to commits after the
   topic note's `last_revised` date. If the cited files have changed,
   read the diffs to confirm whether revision is warranted.

When you find drift, **revise the note in place right then, in this
session.** Edit the note, bump `last_revised`, write a brief episode
documenting what changed.

**Do not ask the user "want me to update this?".** Drift you found is
yours to fix. Fix it inline, say in one line that you did, and
continue your actual task. The fix is a short detour, not a hand-off.

A revised topic note is more valuable than three new episodes saying
the same thing.

---

## 4a. The mid-session publish gate (`/loop 20m /checkpoint`)

The Stop hook's episode reminder is a fallback, not a primary. Long
sessions lose mid-flow insights — by the time Stop fires, the working
context that made an insight feel concrete is gone, and the episode
becomes a reconstruction from the session log.

**To close that gap:** the orientation hook injects a first-turn
instruction telling you to run:

```
/loop 20m /checkpoint
```

This schedules the `/checkpoint` slash command to fire every 20 minutes
IN THIS SAME SESSION. Each fire:

1. Runs `scripts/checkpoint.sh` to audit the session log — edits vs
   episodes since the last fire.
2. Surfaces the audit in your context.
3. Asks you to introspect honestly: *did I learn anything durable in
   the last 20 minutes?*
4. If yes → write the episode NOW via `/episode <slug>`.
5. If no → emit a one-line "[checkpoint] no durable insight" note and
   continue.

The introspection is non-optional — even "nothing learned" is the
discipline. The one-line answer forces you to consider the question.

**Why you write the episode, not a background spawn:** you have the
working context. A spawned `claude -p` would only see the session log.
The episode you write at the checkpoint reflects what you actually
know; a reconstruction never can.

If you find yourself ignoring checkpoint fires or always answering
"no insight" without thinking, that's a discipline failure — fix it
by writing the episode you've been avoiding.

---

## 5. Episodes (writing at session end)

After any session that touched `workspace/<repo>/` and produced an
insight worth remembering, write an episode. The Stop hook
(`scripts/episode-prompt.sh`) reminds you if you forget.

Location: `episodes/YYYY-MM/YYYY-MM-DD-<slug>.md`

```markdown
---
layer: episode
date: YYYY-MM-DD
repo: <repo>
files_touched:
  - path/to/file.py
tags: [keyword, keyword, ...]
superseded_by: ~
distilled_into: ~
auto_drafted: false
reviewed_by_human: ~
rejected: false
---

# <Short title — what was the insight>

(200–600 words. What was the task? What were the files that mattered?
What was the surprise / insight? What would you tell a future Claude
session that's about to do similar work?)
```

The trailing three frontmatter fields are load-bearing — they drive
what the review queue shows. The `PostToolUse:Write|Edit` hook
backfills them if missing, but include them on first write.

The bar is *low* — if you wished you'd known something at the start of
the task, write it. The bar is also *real* — trivial sessions
(formatting, mechanical renames, no insight) don't deserve an episode.

---

## 6. Promotion (episodes → topic notes)

When ≥3 episodes share a tag and aren't yet distilled, the SessionStart
hook surfaces them via `scripts/digest.sh` and suggests `/promote <tag>`.

`/promote <tag>`:
1. Reads all matching episodes.
2. Drafts `guides/<repo>/topics/<tag>.md`.
3. Marks each source episode's frontmatter
   `distilled_into: guides/<repo>/topics/<tag>.md`.
4. The new topic note records `distilled_from: [<paths>]`.
5. You review + edit; if blessed, set `reviewed_by_human: <date>`.

---

## 7. Cross-repo edges

Cartograph doesn't have a separate "edges" table. Cross-file or
cross-repo relationships go inline in the relevant topic note:

> See `guides/xla/topics/hlo-passes.md` for the lowering details, and
> `episodes/2026-04/2026-04-15-pjit-named-axes.md` for the named-axis
> edge case.

Cross-repo seams specifically go in `guides/seams.md` via `/seam`.

---

## 8. Tool-use protocol

### Primitive tools

- `Read` for any file. The PreToolUse:Read hook auto-injects notes
  citing the path before the Read returns.
- `Glob` for file existence/listing. `Grep` for content search.
- `Edit` for in-place revisions; `Write` for new files.
- `Bash` for running upstream code, git inspections, LSP queries.

### Slash commands

**Orientation:** `/whatknows <path>`, `/cite <symbol>`, `/find
<natural-q>`, `/queue`, `/orient`, `/freshness`.

**Authoring & curation:** `/episode <title>`, `/research <repo>
<slug>`, `/paper <repo> <slug>`, `/topic <repo> <slug>`, `/draft
<slug>`, `/walkthrough <slug>`, `/seam <a> <b>`, `/revise <topic>`,
`/promote <tag>`, `/backfill <repo>`, `/auto-revise <topic>`, `/pin
<path>`.

**Stacked-PR workflow (inside `workspace/<repo>/`):** `/stack`,
`/stack-new <slug>`, `/stack-pr`, `/stack-submit`, `/stack-restack`,
`/stack-sync`. Install once with `bash scripts/setup-spice.sh`.

### MCP tools

If you've opted in via `.mcp.json`, three augmenting tools are callable
mid-turn:

- `cartograph_search(query, repo?, layer?, k=10)` — BM25 retrieval.
  Call before grepping.
- `cartograph_notes_for_file(path)` — reverse index. Call before `Read`
  of any workspace file.
- `cartograph_drift(repo, anchor?)` — drift state. Call before
  trusting any topic note.

---

## 9. When in doubt

- Read the field guide for the repo you're working in.
- Read the `/about` page in the local UI for the user-facing tour:
  http://127.0.0.1:47777/about/
- Ask the user — better than guessing.

Cartograph is a notebook. The notebook gets better when you revise it.
