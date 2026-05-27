# Getting started with cartograph

A walkthrough of the first three sessions — from fresh clone to a
working compounding loop. By the end you'll have a tracked repo with
bedrock, a first episode, and a first topic note distilled from
episodes.

If you haven't installed cartograph yet, the README's
[Setup](../README.md#setup) section covers `git clone` →
`cartograph.env` → `just deps` → `just doctor`. This doc picks up from
"`doctor` is green; what now?"

---

## Session 1 — add your first tracked repo

A fresh clone has no tracked repos. You give cartograph one to track,
then let it build bedrock. While bedrock builds, you can either wait
(20–60 min for a non-trivial repo) or kick off another repo.

### Pick a repo

Cartograph shines on **stable codebases you spend real time in** —
your day-job's primary service, an OSS framework you contribute to, an
internal monorepo you ramp into. Avoid one-off scripts or repos you
touch quarterly: the compounding loop needs sessions to compound from.

The repo can be anything you have GitHub access to (you'll fork it).
For this walkthrough, use any non-trivial Python or Go repo as the
upstream — for example, `gohugoio/hugo` or `psf/requests`.

### Run `just add-repo`

```bash
just add-repo gohugoio/hugo
```

What you'll see:

```
→ fork-setup for gohugoio/hugo
fork-setup: forking gohugoio/hugo → <your-github-user>/hugo
fork-setup: cloning to <cartograph-root>/workspace/hugo
fork-setup: configured hugo
  user.name       = <your-github-user>
  user.email      = <your-email>
  origin          = git@github.com:<your-github-user>/hugo.git
  upstream        = git@github.com:gohugoio/hugo.git
  hooks           = commit-msg pre-push
  bedrock         = overview.md architecture.md conventions.md
  topics dir      = guides/hugo/topics/

→ kicking off bedrock backfill in background
  backfill pid=98765
  log: .backfill-log/20260527T180000Z-hugo.log
  watch progress: visit http://localhost:47777/repo/hugo/
```

What just happened, in order:

1. `gh repo fork gohugoio/hugo` — forked to your account (no-op if
   already exists).
2. Cloned into `workspace/hugo/` via the configured SSH alias.
3. Wrote `user.name` / `user.email` / `core.sshCommand` into the
   fork's `.git/config` from `cartograph.env`.
4. Added the `upstream` remote pointing at `gohugoio/hugo`.
5. Installed the per-fork `commit-msg` + `pre-push` hooks with your
   `CARTOGRAPH_FORBIDDEN_EXTRAS` regex baked in.
6. Dropped stub bedrock files at `guides/hugo/{overview,architecture,
   conventions}.md` (placeholders Claude will rewrite during backfill).
7. Created an empty `guides/hugo/topics/` directory.
8. Started `scripts/backfill-bedrock.sh hugo` in the background — it
   invokes `claude -p` headlessly against the
   [quality bar](quality-bar.md).

### Watch backfill progress

Open the local UI:

```bash
just serve   # if not already running
# then visit http://localhost:47777/repo/hugo/
```

The repo page shows a "bedrock building…" badge and the live log.
You can do other work in another terminal while it runs.

For very large repos (XLA-scale, 500k+ LOC), the backfill is
deliberately incomplete in one pass — `scripts/backfill-bedrock.sh`
uses a subsystem-first approach. You'll typically run
`just backfill <repo>` 3–5 times over a week to cover everything.

### When backfill finishes

You'll have:

- `guides/hugo/overview.md` — what hugo is, who uses it, major
  subsystems, surprises, gotchas, cross-repo seams
- `guides/hugo/architecture.md` — top-level layout, where to find
  things, build artefacts, files Claude should rarely need to read
- `guides/hugo/conventions.md` — build + test commands, PR norms,
  code-style specifics, things that look broken but aren't

All three reference real file:line anchors. Frontmatter records the
upstream sha they were built against (`backfilled_from_sha:`).

Run `just doctor` — should still be green.

You're ready for the first real session.

---

## Session 2 — your first session inside the fork

Open Claude Code with the working directory set to
`workspace/hugo/`. That's the scope cartograph cares about.

### What you'll see on your first prompt

When you send your first prompt — say *"how does hugo's content
pipeline resolve a page bundle?"* — cartograph injects:

```
<cartograph-context>

[identity] You are in workspace/hugo operating as <your-github-user>.
No Co-Authored-By: Claude trailers. No mention of Cartograph / Claude /
Anthropic (or any CARTOGRAPH_FORBIDDEN_EXTRAS) in commits, branches, PRs,
or code comments.

[DISCIPLINE — read this on every turn]
Cartograph compounds AUTOMATICALLY...

[guides/hugo/overview.md]    ← full file
[guides/hugo/architecture.md] ← full file
[guides/hugo/conventions.md]  ← full file
[guides/seams.md]            ← full file (empty on day 1)

[top-3 topic notes by keyword overlap]
  (none yet — topics promote from episodes)

[top-3 episodes by keyword overlap]
  (none yet)

[top-3 research notes by keyword overlap]
  (none yet)

[reminder] If a topic note contradicts the code you read, revise it
in place (plan §7). Write an episode at session end if anything was
learned.

</cartograph-context>
```

The bedrock you just built is the floor. On day 1 there are no
topics, episodes, or research notes — those grow from your sessions.

### Work as you normally would

Claude answers using the bedrock as context. Read files, edit code,
ask follow-ups. The model has a much better starting point than
"read every file from scratch."

If at any point you find a file the bedrock didn't mention or a
behaviour the bedrock got wrong, that's a signal — but you don't
have a topic note to revise yet. **Save the insight for the episode
at the end.**

### Write an episode at session end

When you're wrapping up — say you spent the session debugging how
hugo's `page.Resources` lazy-loads — write an episode:

```
/episode page-resources-lazy-load
```

Claude scaffolds `episodes/2026-05/2026-05-27-page-resources-lazy-load.md`
with frontmatter:

```markdown
---
layer: episode
date: 2026-05-27
repo: hugo
files_touched:
  - hugo/resources/page/page.go
  - hugo/resources/resource_factories/bundler/bundler.go
tags: [page-resources, lazy-load]
superseded_by: ~
distilled_into: ~
auto_drafted: false
reviewed_by_human: ~
rejected: false
---

# page.Resources lazy-loads via sync.Once

(200–600 words. Task, files that mattered, the surprise, what you'd
tell a future session.)
```

Fill in the body — what was the task, what files mattered, what was
the surprise, what would help a future you. **Bar is low** — if you
wished you'd known something at the start, write it.

**If you forget the `/episode`** — that's fine. The Stop hook
detects ≥3 edits with no episode written and auto-drafts one in the
background via `claude -p`. The auto-drafted episode has
`auto_drafted: true` and shows up in the inbox at
`http://localhost:47777/console/inbox/` for your review.

When you close the session, the chassis commits + pushes the new
episode automatically (via `session-log.sh publish_content`). You
don't `git add` cartograph content yourself.

---

## Session 3 — the loop starts to compound

Over the next few sessions, you keep working on hugo. Each session
that produces an insight, you write an episode (or the auto-drafter
catches one). After three or four sessions, you'll have a handful of
episodes — some about `page.Resources`, some about templates, some
about config inheritance.

### Tags drive promotion

Tag your episodes consistently. If you wrote three episodes that all
touch `page.Resources` behavior, tag all of them with
`page-resources`. The promotion system watches for ≥3 same-tag
episodes that aren't yet distilled.

### When promotion fires

Next time you open a Claude session (any cwd under cartograph), the
`SessionStart` hook runs `scripts/digest.sh`, which counts tags and
surfaces:

```
[digest] promotion candidates:
  • 3 episodes tagged `page-resources` not yet distilled
    → run `/promote page-resources`
```

You run:

```
/promote page-resources
```

Claude reads all three episodes, drafts
`guides/hugo/topics/page-resources.md` with a `distilled_from:` list
pointing at the source episodes, and marks each source episode's
`distilled_into:` field.

### Review the topic

Open the local UI, navigate to `/console/review/` (or
`http://localhost:47777/repo/hugo/topics/page-resources/`). You see
the auto-drafted topic with a thumbs-up / thumbs-down. Read it; if
it's accurate, click bless (sets `reviewed_by_human:` to today's
date). If it needs edits, edit in place.

### What happens next

Now that `guides/hugo/topics/page-resources.md` exists, every
future prompt that mentions `page.Resources` or related concepts
will surface this topic in the orientation injection. The
understanding you accumulated across three sessions is now carried
forward into every future session.

If you ever edit code that the topic note cites, the
`post-edit-topic-mark.sh` hook flags the topic for re-validation in
the review queue. If upstream changes a cited file,
`topic-drift.sh` writes a per-citation drift report at
`.drift-reports/topics/hugo/page-resources.md`. Next time you run
`/revise page-resources`, the drift report is pre-staged with the
diff already in front of you.

---

## What to do next

You now have the loop. From here:

- **Keep writing episodes.** The Stop hook nudges; respond.
- **Run `/freshness` weekly** to see which forks have upstream drift.
- **Run `/queue` daily** to see auto-drafts awaiting your review.
- **Use `/find <natural query>`** when the orientation injection
  doesn't surface something obvious — BM25 catches semantic matches
  keyword overlap misses.
- **Add more repos** with `just add-repo` as you take on new
  surfaces. Each one gets its own bedrock, its own topic notes,
  its own drift detection.
- **Browse `http://localhost:47777`** when you want the human-shaped
  view — recent activity, all your PRs, the seams graph, the inbox.

### When to revise (the load-bearing rule)

The single discipline that makes cartograph compound rather than
just accumulate: **when you find a topic note that contradicts the
code you just read, revise it in place right then, in that session.**
Don't ask permission. Edit the note, bump `last_revised:`, write a
small episode noting what changed. The fix is a short detour, not a
hand-off.

This is the difference between a notebook that gets *better* and a
notebook that just gets *bigger*. The framework gives you all the
mechanism — promotion, drift detection, auto-revise — but the
single human discipline is **fix what you find, in the moment**.

---

## Common confusions

**"Do I commit cartograph content myself?"** No. The
`session-log.sh publish_content` step at session end stages, commits,
and pushes any new notes you authored under `guides/`, `episodes/`,
`research/`, `papers/`, `learn/`, `diary/`. You only `git commit`
yourself if you want a non-default commit message or you're
publishing the framework itself (`just publish`).

**"What's the difference between `/research` and `/episode`?"** An
episode is *task-driven, from this session* — what you learned. A
research note is *external context worth keeping* — a blog post, an
RFC, a comparison with another project. Different audiences.

**"What if I disagree with an auto-drafted episode?"** Edit it in
place, or set `rejected: true` in frontmatter to opt it out of
future promotion. The framework default-approves; you opt out.

**"Can I have a topic note without going through episodes first?"**
Yes — `/topic <repo> <slug>` scaffolds one from scratch. Use this
when you have a stable mental model worth recording but haven't
generated three episodes yet.

**"What if my fork is behind upstream?"** Either the
`upstream-sync.sh` hook hasn't run (it runs at SessionStart from
inside the fork), or it ran but couldn't fast-forward (uncommitted
changes, not on the tracked branch). Run `bash scripts/upstream-sync.sh hugo`
manually to see what's blocking.

---

## Where to go next

- [`CLAUDE.md`](../CLAUDE.md) — the operator protocol Claude reads
  at the start of every session
- [`integration.md`](integration.md) — the full hook flow + forbidden-token
  enforcement
- [`quality-bar.md`](quality-bar.md) — bedrock quality contract
