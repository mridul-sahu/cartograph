---
description: Propose an ambitious, trend-justified build for a repo (or a new repo), with an explicit investment thesis
allowed-tools: Skill, Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
---

Turn gap research + paper analysis + ecosystem trends into an **ambitious,
justified proposal** for something people would actually want to use — and
decide where it should live, including proposing a **new repo** when the idea
doesn't fit an existing one. This is the strategic layer above `/analyze-paper`
(one technique) and `/gap-scan` (a parity backlog): it asks *what should we
build, why now, and is it worth investing in*.

The output is a proposal in `proposals/`, not a survey and not a design. A
proposal that lists features without a falsifiable investment case has failed.

## Arguments

Parse `$ARGUMENTS`:
- **First token** — `<repo>`: the repo to propose for
  (`jax`/`xla`/`orbax`/`tunix`/`tokamax`/`sglang`), **or** the literal `new` to
  hunt for something worth a brand-new repo. (Even with a repo given, Phase 5
  may still conclude a new repo is the right home.)
- **Second token** — `<slug>`: kebab-case for the proposal file.
- **Remainder** — the theme / seed ("make Tunix the go-to async-RL JAX
  framework", "what should we build next for JAX post-training", …).

Validate: for a repo, `guides/<repo>/` must exist. For `new`, skip that check.
Today's date:
!`date +%Y-%m-%d`

## Phase 0 — Cartograph first (mandatory)

Build on what we already know; don't re-derive it.
1. `proposals/<repo>/*` and `proposals/_new/*` — anti-duplication. If a related
   proposal exists, extend/supersede it (`status:`), don't fork.
2. `research/<repo>/*` — **the gap-scan notes are your primary evidence base.**
   If none exists for this theme, say so and either run `/gap-scan` first or do
   a lightweight inline scan; a proposal with no gap grounding is a guess.
3. `guides/<repo>/topics/*` + bedrock — our current capabilities and our stack's
   unique position (this is the "feasibility / our strengths" input).
4. `papers/<repo>/*` and any `/analyze-paper` topic notes — the techniques that
   make the proposal buildable.
Report in one line what evidence already existed.

## Phase 1 — Assemble the evidence base

Three grounded inputs, each cited:
- **Gaps / demand** — what's missing or wanted (from the gap-scan notes).
- **Techniques** — what's now possible (from papers + topic notes).
- **Our strengths** — what we can uniquely do (JAX/TPU-native, integration with
  the rest of the stack, existing subsystems we'd build on).
If the base is thin, widen it before proposing — an ungrounded proposal is the
main failure mode of this skill.

## Phase 2 — Trend analysis (the forward-looking layer)

Survey where AI/LLM frameworks are **heading** (WebSearch / `deep-research`),
adversarially verified:
- **Adoption signals** — what frameworks people are switching to, GitHub
  momentum, what frontier labs publish/open-source, what's getting attention.
- **Direction of travel** — the structural shifts (e.g. RL post-training going
  mainstream, agentic RL rising, inference-time scaling, JAX RL tooling thin).
- **Tailwinds vs headwinds** — trends that make a proposal timely vs ones that
  work against it.

Discipline: **distinguish a durable structural shift from a hype cycle**, and
cite the signal. "Everyone's excited about X" is not a trend; "three frameworks
and two labs converged on X in 6 months, here are the links" is. Prefer
primary/quantifiable signals over vibes.

## Phase 3 — Synthesize candidate proposals

From **gaps ∩ trends ∩ our strengths**, generate 2–4 *ambitious* candidates —
not "close gap X" but "become the X for Y," a coherent thing people adopt. For
each: the one-line pitch, the user and their pain, the core capability, and the
single reason it would be chosen over alternatives.

**Let the trend analysis reshape the candidate — don't lock its shape or home
before Phase 2.** A "feature in an existing repo" framing (straight from a
gap-scan) routinely upgrades into a "standalone product, new repo" once the
trend context lands (e.g. the layer is crystallizing into its own category
across multiple players). That re-framing is the skill working, not scope creep.

## Phase 4 — Investment thesis (the WHY — the heart of the skill)

Score each candidate on explicit, falsifiable criteria:
- **Demand** — who wants it, how badly, what's the evidence.
- **Trend tailwind** — which durable trend it rides; the "why now" timing case.
- **Differentiation / moat** — why ours gets chosen (JAX/TPU-native, integration,
  performance, the thing only we can do).
- **Feasibility** — can we build it given our capabilities and gaps; rough effort;
  dependencies; the hardest unsolved part.
- **Strategic fit** — does it serve the repo's mission, or warrant a new repo.
- **Adoption path** — how people discover it and get to first value.

Then **rank**, and state the **assumptions that, if false, kill the thesis**
(e.g. "assumes JAX-side RL demand keeps growing; if the ecosystem consolidates
on PyTorch-only, the moat evaporates"). An investment case you can't falsify is
hype, not analysis.

**Name the single load-bearing assumption and design the first step to test
it.** When a proposal's risk concentrates in one crux (e.g. "model-based
verifiers matter enough that TPU-native serving is a real edge"), the MVP /
first action should *validate that crux* before over-investing — risk-first, not
feature-first. A proposal that defers its biggest unknown to "later" is a weaker
proposal.

## Phase 5 — Repo fit / new-repo decision

For the recommended proposal, decide its home. **Spawning a new repo is a high
bar** — warrant it only if it clearly passes the checklist:
- different audience/domain than any existing repo,
- different dependency footprint,
- would bloat an existing repo's mission/scope if bolted on,
- has standalone product identity + an independent release cadence.

Otherwise, name the existing repo **and the subsystem** it extends. If a new
repo is warranted, propose: name, one-line mission, scope (explicitly in / out),
initial module layout, key dependencies, and the **seams** to existing repos
(what it consumes / is consumed by).

## Phase 6 — The proposal doc

Write `${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/proposals/<repo|_new>/<slug>.md`
(see `proposals/README.md` for frontmatter). Sections:

- **Pitch** — 1–2 sentences: what it is, who it's for.
- **The problem / who wants this** — user + pain, with evidence.
- **Why now — the trend thesis** — tailwinds, cited; the timing argument.
- **What it is** — HLD-level: the capability, the shape, key APIs / data flows.
  Enough technical substance to assess soundness (per the design-doc grounding
  rule in CLAUDE.md §3c) — but outcome-framed, future tense.
- **Why invest — the case** — demand, differentiation/moat, feasibility,
  strategic fit, and the **falsifiable assumptions**.
- **Repo home** — existing repo + subsystem, OR the new-repo recommendation with
  the checklist result + mission/scope/structure/seams.
- **Roadmap** — MVP → v1 → ambitious vision, phased.
- **Risks & non-goals** — what could kill it; what we explicitly won't do.
- **Evidence base** — the gaps / papers / topics it's grounded on + trend sources.
  Firewall-safe citation: reference internal analyses by their **note name/slug**
  (like a topic-note cross-link, e.g. "the rl-developments-vs-frontier gap
  analysis"), cite upstream code by its **public repo-relative path**
  (`tunix/rl/...` is public), external sources by URL — **never** a private
  `~/`/`cartograph/` absolute path.
- **Next action** — driven by the proposal's `status` (the *Lifecycle* table in
  `proposals/README.md`). A freshly written proposal is `gap-analysis` → its next
  action is to **deep-dive the load-bearing technique** (`/analyze-paper <repo>
  <slug> <url>`) and name the first failing test. If *this* `/propose` run
  already de-risked the crux against real code and named the failing test, set
  `deep-dive` → next action is the **human's `final` / `discarded` decision**.
  **Never point a non-final proposal at `designs/` or `/stack-new`** — the
  proposal docx and design docx are earned only after a human marks it `final`,
  and an agent never self-promotes past `deep-dive`. **Write any slash command
  inside a single backtick span** (e.g. `` `/analyze-paper tunix foo --into tunix
  <url>` ``) — the proposals UI renders each backticked `/command` as a copy
  button and each URL as a link.

Set `status:` to where the proposal actually landed: `gap-analysis` (the case is
made but the crux isn't de-risked yet) or `deep-dive` (this run de-risked the
load-bearing assumption against real code and named the first failing test).
Anti-bloat: if a related proposal exists, revise it, or supersede it — set
`status: superseded` + `superseded_by:`, then **remove the file** (git history is
the archive) — rather than forking a near-duplicate.

**Proposal trees (umbrellas & sub-proposals).** Proposals form a tree. If this
proposal is a component of a larger north-star, set `parent: <umbrella-slug>` so
it nests under that umbrella. If *this* is an umbrella that organizes several
component builds, write it as a normal proposal and set `parent:` on each
component — **don't fold them in, link them** (the umbrella owns the thesis +
sequencing; each child owns its code-grounded build). Speculative components you
might or might not build live as sub-proposals at `status: gap-analysis` under
their umbrella — they cost nothing if dropped (`status: discarded`). Full
convention: `proposals/README.md` → *Proposal trees*.

## Phase 7 — Episode + report

- Episode (`episodes/<YYYY-MM>/<today>-<slug>.md`, standard frontmatter incl.
  `auto_drafted: false`, `reviewed_by_human: ~`, `rejected: false`): the
  recommended proposal, the investment verdict, the repo-home call, the next step.
- Report to the user: the recommended proposal (one line), the investment verdict
  (build / validate-first / park, with the load-bearing assumption), the repo-home
  decision, and the single next action. Proposal-note URL:
  `http://127.0.0.1:47777/proposals/<repo|_new>/<slug>/`.

Don't `git add`/commit — `proposals/` is a bundled watch-loop dir (§3a). Write to
the path and the chassis lands it.

**After a human marks it `final`** — the build deliverables follow, in order,
each finalized before the next begins (the *Lifecycle* table in
`proposals/README.md` is the source of truth):

1. **Proposal docx** (`final` → `proposal-docx`). Run `/proposal-final-draft
   <repo> <slug>` — a formal, well-researched docx in the standing structure
   (Introduction / Background / Ecosystem+Impact / HLD / Feasibility & Risk /
   References), with `d2` diagrams in the HLD; the UI surfaces a **download docx**
   button. Not a thin render of the markdown — see `proposals/README.md` → *The
   proposal docx*.
2. **Design docx** (`proposal-docx` → `design-docx`). The formal HLD at
   `designs/<repo>/<slug>/` via the docx flow (CLAUDE.md §3c).
3. **Implementation** (`design-docx` → `implementing`). `/stack-new <slug>`,
   built against the finalized design.

This skill's job ends at `deep-dive`. Promoting to `final` and producing the
build deliverables is a separate, human-gated track — never auto-advance into it.

## The bar

A good proposal is **investable**: ambitious enough to be worth doing, grounded
enough to be real (every claim traces to a gap, a technique, a trend, and our
actual feasibility), with an explicit thesis someone could argue against. The
new-repo decision is earned, not casual. "Cool things we could build" is a
failure; "this specific thing, for these users, because this trend, which we can
build on this subsystem, and here's what would have to be true" is the bar.
