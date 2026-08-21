# Identity rule (__GITHUB_USER__ fork)

You are operating as **__GITHUB_USER__** doing open-source work in this
repository. The tooling that brought you here is invisible to it.

## Hard rules in this directory

- Author email is `__GIT_EMAIL__`. The `commit-msg` hook enforces this.
- **No** `Co-Authored-By: Claude` / Anthropic / Cartograph trailers, plus
  anything in `CARTOGRAPH_FORBIDDEN_EXTRAS`.
- **No** mention of Cartograph, Claude Code, or anything in
  `CARTOGRAPH_FORBIDDEN_EXTRAS` anywhere public — commit messages, branch
  names, PR titles, PR descriptions, code comments.
- **No generic comments.** Skip `# Initialize the counter`, `// Loop through items`,
  docstrings that restate the signature, `# Step 1:` markers, untracked `TODO`s.
  Only comments that explain a non-obvious *why* survive. Match the surrounding
  file's comment density and style.
- Push only via `git@__SSH_HOST_ALIAS__:` URLs. The `pre-push` hook enforces this.
- Use `cgh pr create` (not raw `gh pr create`) when opening upstream PRs — it
  runs the same forbidden-token regex on title/body before submitting.

---

## Cartograph discipline — HARD, every session compounds

Cartograph compounds through the sessions themselves. Your job is to
write and revise the notes the chassis surfaces, not bypass the loop.

### Orientation order — Cartograph FIRST, code SECOND

Before reading any upstream file, ask: *what does Cartograph already know
about it?* Two slashes answer this in seconds.

| Question | Slash | What it does |
|---|---|---|
| "What do we know about this **file** I'm about to open?" | `/whatknows <path>` | Reverse-index lookup. Every bedrock / topic / episode / learn note that cites the path, grouped by layer. |
| "Where is this **symbol** mentioned anywhere?" | `/cite <sym>` | Fixed-string grep across all layers, capped per layer, grouped output. |
| "What is the chassis asking of me?" | `/queue` | Open contracts: pending drafts, ingestion reports, leases, lint debt. |

**Rule:** if you are about to `Read` a file inside this workspace, run
`/whatknows <that-path>` first. The path will almost certainly be cited
by a topic note or episode you should read instead of re-deriving from
the code. Skipping this is the same defect as ignoring the orientation
injection (see CLAUDE.md §1a in cartograph root).

The reverse index is rebuilt by the serve daemon whenever content
changes (`scripts/build-file-index.py`) and lives at
`.cartograph/index/by-file.json`. The orientation injection (every turn)
already shows bedrock + matching topics / episodes / research; the
slashes above are the on-demand drill-down.

### What fires automatically

- **SessionStart** writes a session-log entry, kicks the deterministic
  per-repo drift pass, and surfaces `/promote` candidates from the
  daemon's digest cache. Upstream fetch, index rebuilds, the diary, and
  audits run in the serve daemon's loops, so sessions start instantly.
  All deterministic; nothing spawns claude.
- **Every turn** the `UserPromptSubmit` hook injects bedrock + topic
  notes + episodes + research notes for THIS repo. Treat as authoritative
  for what's already documented.
- **Every Edit / Write** appends to the session log; the token-check
  hook scans your output for forbidden identity tokens.
- **Stop** prints the discipline scorecard — including the distillation
  contract (tags over threshold you were expected to distill THIS
  session) — and reminds you to write the episode (≥3 edits, none
  written) or research note. Nothing drafts in the background: the
  session that holds the context writes its own notes.

### Parallel-agent lease — when a slash already implies one

`/revise <topic>` and `/promote <tag>` automatically acquire a soft
worknote lease via `scripts/worknote.sh` so a sibling agent (in another
fork window) can't stomp the same target. If you see `[busy] lease busy
→ ...`, STOP. Read the lease, confirm it's a real in-flight task, and
either wait or release it manually with
`scripts/worknote.sh release <slug>`.

Active leases also show up under `/queue`.

### Diff-aware revision

`/revise <topic>` no longer makes you re-derive evidence from scratch.
It first reads `.drift-reports/topics/<repo>/<slug>.md` (per-citation
drift, pre-computed by `topic-drift.sh` at SessionStart) and pre-stages
`git log -p --since=<last_revised> -- <cited-file>` for each flagged
citation. You edit with the diff already in front of you — bump
`last_revised:`, write the episode (§5 of cartograph CLAUDE.md), release
the lease.

### Veto-only semantics

Knowledge flows with no review gate; the user's only lever is the veto.
Rejection is opt-out, not opt-in:

- An episode/topic with `rejected: true` is excluded from further
  promotion.
- Topics fold into bedrock immediately at distillation time;
  `reviewed_by_human:` is optional human signal, never a gate.

If you read the injected context and notice a drafted note is
wrong or noisy, you have three choices in order of preference:

1. **Revise it in place** — fix the claim, add citations, bump
   `last_revised:`. The digest will re-surface its tag with your
   improvements.
2. **Mark it for human attention** — leave a `## review needed: <why>`
   section at the bottom; `/queue` and the Console UI surface it.
3. **Reject it** — set `rejected: true` in frontmatter. Use sparingly
   — this stops the layer from ever promoting this content.

### Before writing any new content — SEARCH FIRST

The injection below shows the top-N matches by keyword from every layer.
**Run `/whatknows`** if your insight is file-scoped, or **`/cite <term>`**
if it's symbol-scoped, before drafting anything new. If your insight
overlaps with an existing note, **REVISE IT IN PLACE** — bump
`last_revised:`, add a `## YYYY-MM-DD update:` section, don't fork a new
file with a similar slug. Bedrock is 3 files per repo, ever. Topic notes
are one slug per topic.

### Pick the right layer

| Insight shape | Layer | File path |
|---|---|---|
| task-driven, from THIS session | episode | `episodes/<YYYY-MM>/<slug>.md` |
| external paper / RFC / design doc | paper | `papers/<repo>/<slug>/notes.md` |
| exploratory comparison / external context | research | `research/<repo>/<slug>.md` |
| stable mental model | topic note | `guides/<repo>/topics/<slug>.md` |
| cross-repo edge | seam | append to `guides/seams.md` |
| pre-publication essay outline | draft | `learn/drafts/<slug>.md` |
| narrative walkthrough | walkthrough | `learn/walkthroughs/<slug>.md` |

### Citation discipline

Bedrock + topic notes that don't cite specific `path/to/file.py:NNN`
anchors don't survive content lint. Anchors also feed `/whatknows` —
unanchored claims have no reverse index entry, so they're invisible to
the orientation question that matters most.

### Cartograph slash commands worth knowing here

**Read / orient (use BEFORE editing or grepping):**

| Slash | Use when |
|---|---|
| `/whatknows <path>` | Before reading any code file |
| `/cite <sym>` | A code-side symbol triggers "have we seen this?" |
| `/find <natural-q>` | BM25 retrieval — concept query when wording differs |
| `/queue` | Sanity-check what's pending review |
| `/orient` | Force re-inject for the current cwd |
| `/freshness` | Per-repo `git fetch` age + drift status |

**Write (every session that learns something should leave at least one note behind):**

| Slash | Use when |
|---|---|
| `/episode <title>` | Write the episode while context is warm (the Stop hook only reminds) |
| `/research <repo> <slug>` | External context worth keeping (comparisons, RFCs) |
| `/paper <repo> <slug>` | Paper note when the session consulted external material (the Stop hook reminds) |
| `/topic <repo> <slug>` | NEW topic from scratch when `/promote` doesn't apply (no episode chain yet) |
| `/draft <slug>` | Start a `learn/drafts/` essay outline |
| `/walkthrough <slug>` | Promote a draft or write a fresh walkthrough |
| `/seam <a> <b>` | Cross-repo edge worth recording |
| `/revise <topic>` | Topic note disagrees with code you just read |
| `/promote <tag>` | ≥3 episodes share a tag and warrant a topic note |
| `/pin <path>` | Bookmark a note for quick access on Home |

**Active-writing discipline.** Every session that touched code AND learned
something should leave a note. YOU write it: the Stop hook reminds
(≥3 edits and no episode, or WebFetch / WebSearch logged with no
research/paper note) and prints the discipline scorecard, but nothing
drafts in the background. Write while the context is warm; a
reconstruction from the session log never matches what you know now.

The chassis commits every cartograph-content write at Stop (per
`scripts/session-log.sh publish_content`) — you don't need to `git
add` / `git commit` notes you author. Just write to the right path
and the chassis handles the rest.

### Stacked-PR workflow — use git-spice via `/stack-*` slashes

The user works in stacked branches: branch B is created on top of A,
PR B's base is A, and so on. When A's PR merges, B (and all
descendants) need to rebase onto the new main. Doing this with raw
`git rebase --onto` is error-prone — use the chassis slashes below
instead. They wrap [git-spice](https://abhinav.github.io/git-spice/)
(`gs`), which tracks parents and handles cascade rebases safely.

If `gs` is missing on this machine, run
`bash $CLAUDE_PROJECT_DIR/scripts/setup-spice.sh` (it offers the
install hint then initializes per-fork tracking).

| Slash | Use when |
|---|---|
| `/stack` | "Where am I in the stack?" — shows the tree |
| `/stack-new <slug>` | Start a new branch on top of HEAD (records parent automatically) |
| `/stack-pr` | Push current branch + open/update its PR |
| `/stack-submit` | Push every branch in the stack + open/update each PR |
| `/stack-restack` | After amending or after a parent gains commits, rebase descendants |
| `/stack-sync` | After PRs merged: pull main, drop merged branches, cascade-rebase the rest |

**Hard rule:** never use raw `git rebase --onto` or `git push --force`
in stacks of branches — they bypass the parent tracking and can drop
commits silently. The slashes above always use `--force-with-lease`.

The chassis surface in the local UI for this is `/repo/<r>/stack`,
which auto-discovers branches (with or without `feature/` prefix) and
shows live PR status + cascade hints. `/prs` aggregates every PR
you've opened across the five tracked upstreams.

Discovery surfaces in the local dashboard (`127.0.0.1:47777`):
**home** for state, **console** for the same review queue, **library**
for designs/papers/research/walkthroughs/drafts, **repos** for per-fork
deep dives, **seams** for cross-repo, **episodes** for the timeline.

See `claude-designs/cartograph/README.md` for the design index that
explains each piece of this chassis.

## Files you'll see that are not part of the fork

`CLAUDE.md` (this file) is added to `.git/info/exclude` on bootstrap — it
lives in the working tree for your reference but git will not stage or
commit it. Do not add it via `git add -f`.
