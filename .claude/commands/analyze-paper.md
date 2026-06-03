---
description: Deep-analyze a paper end-to-end and land an implementable-concept topic note for a target lib
allowed-tools: Skill, Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
---

Run the full paper → implementation pipeline in one shot. The goal is NOT a
summary — it is to turn an external paper into a concrete, implementable
concept note tied to a specific library we ship, with the seam to upstream
code made explicit. A run that ends without an implementable topic note has
failed.

## Arguments

Parse `$ARGUMENTS`:

- **First token** — `<repo>`: the bookshelf the *paper* belongs to (its
  subject-matter home, e.g. `sglang` for a RadixAttention paper).
- **`--into <target>`** (optional) — the library we intend to *implement
  into* (e.g. `tunix`). If omitted, the target is the same as `<repo>`.
  The paper note is filed under `<repo>`; the implementable topic note is
  filed under `<target>`. These differ for ported concepts
  (SGLang → Tunix, an XLA paper → a JAX partitioning change, …).
- **Second token** — `<slug>`: kebab-case identifier for the paper
  (e.g. `radix-attention`).
- **Remainder** — the paper URL, arXiv id, or title, plus an optional
  focus ("the prefix-sharing cache specifically").

Validate `<repo>` and `<target>` are tracked: each must have a
`${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/guides/<name>/` directory.
If one doesn't exist, stop and tell the user to run
`just add-repo <org>/<name>` first — do not invent a repo.

Today's date:
!`date +%Y-%m-%d`

## Phase 0 — Cartograph first (mandatory, do not skip)

Per the workspace protocol, you check what we already know before touching
upstream code or the open web. Search, in this order, for the concept and
the slug:

1. `papers/<repo>/<slug>/` and other `papers/<repo>/*` — is this paper
   already on the shelf? If so, you UPDATE it, not duplicate it.
2. `guides/<target>/topics/*.md` — does a topic note already cover this
   concept for the target lib? If ≥60% overlap, you revise in place (§4
   revision discipline) rather than writing a new one.
3. `research/<repo>/*` and `research/<target>/*` — prior comparisons.
4. `episodes/**` — has a past session already hit this?
5. `guides/seams.md` — is the cross-repo edge already recorded?

Use `Grep`/`Glob` (or `cartograph_search` if available). Report in one line
what already existed before you proceed.

## Phase 1 — Deep analysis (the understanding)

Invoke the **`deep-research`** skill on the paper. Frame the research
question as implementation-oriented, not survey-oriented:

> "How does <concept> actually work — its mechanism, the invariants it
> relies on, and its assumptions — and what would it take to implement it
> in <target>? Where does it diverge from how <target> does this today?"

deep-research will fan out sources, fetch them, and adversarially verify
claims. While it runs / after it returns, ground the answer in OUR code —
this is what separates an implementable note from a book report:

- Read the relevant current implementation in `workspace/<target>/` (and
  `workspace/<repo>/` for the source, if it's a port). Find the file(s)
  the concept would touch.
- Use **context7** (`resolve-library-id` → `query-docs`) for the target
  lib's current public API so the sketch doesn't cite stale signatures.
- Identify the **delta**: what `<target>` does now vs what the paper
  prescribes. That delta IS the implementation.

Capture, with citations (external URLs for the paper; `workspace/<repo>/
<path>:<line>` for code):

- The mechanism in plain English, then precise terms.
- The math / invariants that must hold (the things a test would assert).
- The assumptions (hardware, batching, memory model) — note where ours
  differ.

## Phase 2 — Paper note

Write/update `${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/papers/<repo>/<slug>/notes.md`
using the paper template (see `papers/README.md`). Frontmatter:

```yaml
---
layer: paper
repo: <repo>
slug: <slug>
last_revised: <today>
auto_drafted: false
reviewed_by_human: ~
rejected: false
url: <paper-url>
authors: [<authors>]
year: <year>
tags: [<concept>, <target>, ...]
---
```

Fill `## How it relates to our work in <target>` and `## What to do with
this` *concretely* — name the seam, point at the topic note you're about
to write, state implement/cite/ignore with a reason. No hedging.

## Phase 3 — Implementable-concept topic note (LOAD-BEARING)

This is the output that justifies the whole run. Write or revise
`${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/guides/<target>/topics/<concept-slug>.md`.

The `<concept-slug>` names the concept as we'd build it, not the paper
(`prefix-sharing-kv-cache`, not `sglang-paper`). Frontmatter:

```yaml
---
layer: topic
repo: <target>
last_revised: <today>
auto_drafted: false
reviewed_by_human: ~
rejected: false
distilled_from: [papers/<repo>/<slug>/notes.md]
tags: [<concept>, <target>, ...]
---
```

The body must answer "how would we build this in `<target>`?", not "what
does the paper say?". Required sections:

- **The concept, and why it matters for `<target>`** — the user-facing win.
- **How `<target>` does it today** — cite `workspace/<target>/<path>:<line>`.
- **The delta / implementation sketch** — the specific files that change,
  the new data structures, the API surface. Concrete enough that a future
  session can open the files and start.
- **Invariants & the test that proves it** — what must stay true; the
  failing test you'd write first (goal-driven execution).
- **Open questions / risks** — what's still unverified.

If the topic note already existed (Phase 0), Edit it in place and bump
`last_revised`; do not fork a second note.

## Phase 4 — Seam (only if `<repo>` ≠ `<target>`)

A ported concept is a cross-repo edge. Append it to `guides/seams.md`
(the `/seam` discipline): "`<repo>`'s `<concept>` → implemented in
`<target>` as `<concept-slug>`; see the topic note and
`papers/<repo>/<slug>`."

## Phase 5 — Episode

Write `episodes/<YYYY-MM>/<today>-<slug>-into-<target>.md` with the standard
episode frontmatter (include the load-bearing `auto_drafted: false`,
`reviewed_by_human: ~`, `rejected: false`). Record: what the paper claims,
the single biggest surprise from grounding it in our code, and the concrete
next step — which is almost always "open `/stack-new <concept-slug>` in
`workspace/<target>` and write the failing test from the topic note."

## Phase 6 — Report

In a short summary give the user:

- One line on what already existed (Phase 0) vs what you created/revised.
- The browser URLs:
  `http://127.0.0.1:47777/library/` (paper) and
  `http://127.0.0.1:47777/repo/<target>/` (topic).
- The single concrete next action to start implementation.

Do not `git add`/commit the content dirs yourself — the serve.py watch loop
auto-commits `papers/`, `guides/`, `research/`, `episodes/` after its quiet
window (per §3a). Just write to the right paths.
