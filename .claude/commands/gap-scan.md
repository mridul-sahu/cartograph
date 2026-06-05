---
description: Landscape gap-analysis — survey an external ecosystem, ground it against one of our libs, produce a prioritized build backlog
allowed-tools: Skill, Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
---

Answer an open-ended "what does the rest of the world have that we don't?"
question with a **prioritized, grounded build backlog** — not a survey dump.
This is the inverse of `/analyze-paper`: that starts from one paper and goes
deep; this starts from a question, scans the landscape, and comes back with a
ranked list of capabilities worth building, each tied to a concrete entry point
in our code.

Use it for questions like:
- "recent RL developments frontier labs use that Tunix lacks"
- "capabilities PyTorch post-training frameworks have that JAX should build"
- "checkpoint/serialization features other ecosystems have that Orbax doesn't"

## Arguments

Parse `$ARGUMENTS`:
- **First token** — `<repo>`: the lib we're measuring against
  (`jax`/`xla`/`orbax`/`tunix`/`tokamax`/`sglang`). Validate a
  `${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/guides/<repo>/` dir exists; if
  not, stop and say `just add-repo <org>/<repo>` first.
- **Second token** — `<slug>`: kebab-case for the research note
  (e.g. `rl-developments-vs-frontier`, `pytorch-posttrain-parity`).
- **Remainder** — the question / comparison framing.

Today's date:
!`date +%Y-%m-%d`

## Phase 0 — Cartograph first (mandatory)

Before any web search, check what we already know — and use it for **both**
sides of the comparison:

1. `research/<repo>/*` — a prior scan may already cover this; if so you UPDATE
   it (anti-bloat rule, `research/README.md`), not duplicate. Specifically read
   `research/<repo>/posttraining-frameworks-landscape.md` if it exists — that's
   the standing map of external players; start from it.
2. `guides/<repo>/topics/*` and the bedrock — **this is your "what we have
   today" baseline.** We maintain detailed topic notes precisely so you don't
   re-derive our own capabilities or invent false gaps. Read them.
3. `episodes/**`, `papers/<repo>/*`, `guides/seams.md` — prior findings and
   cross-ecosystem edges.

Report in one line what already existed.

## Phase 1 — Decompose the question into capability dimensions

A rigorous gap analysis compares on explicit axes, not vibes. Before
researching, write down the capability taxonomy you'll score against. Start
from this checklist for RL / post-training and **adapt it to the actual
question** (drop what's irrelevant, add what's missing):

- **Algorithms** — PPO, GRPO and variants (DAPO, Dr.GRPO, GSPO), DPO/ORPO/
  KTO/SimPO, RLOO, REINFORCE++, online vs offline.
- **Reward modeling** — scalar RM, generative/LLM-as-judge RM, process reward
  models (PRM), RLVR / verifiable rewards, rubric/tool-checked rewards.
- **Advantage & credit assignment** — GAE, group-relative baselines,
  token-level vs sequence-level, length normalization.
- **Off-policy correction** — importance sampling (truncated/clipped),
  staleness budgets, replay.
- **Rollout infrastructure** — async generation, disaggregated train/infer
  meshes, server-mode inference, continuous batching, prefix/KV-cache reuse.
- **Multi-turn / agentic** — tool use, environments, trajectory collection,
  multi-step credit assignment.
- **Context & sequence handling** — long context, packing, dynamic length,
  truncation policy.
- **Stability & throughput** — KL control schedules, clip ranges, loss masking,
  MFU, memory offload, multi-host scaling.
- **Data & eval** — curriculum/curation, on-policy eval, contamination control.
- **Ergonomics** — recipe/config surface, checkpoint/resume, observability.

List the dimensions you'll actually use, explicitly, before Phase 2.

## Phase 2 — External landscape (adversarially verified)

Survey the external state of the art for each dimension. Two ways to drive it —
pick per the question:
- **`deep-research` skill** when you want broad fan-out + synthesis across a
  fuzzy area.
- **Targeted `WebSearch`/`WebFetch` per capability dimension** when you want
  tight comparative control (one focused query per axis: "DAPO dynamic sampling
  token-level loss", "async RL partial rollout staleness", …). In practice this
  is often faster and sharper than one big deep-research call — the POC run used
  it and it surfaced current (even post-knowledge-cutoff) arXiv sources cleanly.

Identify the real players (PyTorch: TRL, verl, OpenRLHF, NeMo-Aligner,
torchtune, SkyRL, AReaL, slime, OpenInstruct — see the Phase-0 landscape index)
and read primary sources.

**Verification discipline — this is where the skill earns its keep:**
- Comparative claims are exactly where hype creeps in. Verify each "framework X
  does Y" against the **paper or the source code**, not a blog headline. For the
  *cited* source, prefer arXiv / OpenReview / the repo over a secondary blog
  (a blog is fine for orientation, not as the citation).
- This scan compares against the **published literature and open frameworks**,
  not any lab's private stack. State that in the note. For "what do frontier
  labs use" framings, most internals are **not public** — mark every such claim
  **documented** (cited) or **inferred/speculative**, and never assert "lab X
  uses Y internally." The user is making build decisions off this note.

## Phase 3 — Internal grounding (no false gaps)

**This phase is where most of the effort goes** — the external survey is fast;
the slow, valuable work is confirming each "we don't have this" against the
actual code. Budget accordingly.

For each dimension, establish what `<repo>` has **today**, grounded on the
Cartograph topic notes (Phase 0) and confirmed against `workspace/<repo>` code
with `file:line` citations. Classify precisely:

- **Absent** — genuinely missing.
- **Stubbed / declared-but-unimplemented** — a config flag, field, or API
  exists but the body is a no-op / `TODO`. Often the **highest-ROI gap**: cheap
  to finish, and *currently misleading* (the config claims a capability the run
  doesn't deliver). Flag these loudly.
- **Partial / experimental** — exists but limited or behind a flag.
- **Present-but-different** — exists in another shape (don't call it a gap).

**Grep finds the symbol; you must read the body.** This is the load-bearing
rule of the whole skill — the POC flipped *two* cells on a re-read:
- A present-looking flag was a stub (`dynamic_sampling: bool = True  # TODO: add
  dynamic sampling`) → it's **stubbed**, not present.
- A symbol that grep "didn't find" was a filtered false-negative — the feature
  (DAPO overlong reward shaping) was right there in the function body → it's
  **present**, not a gap.
So: open the file and read the implementation before writing any cell. Never
classify from a grep hit (or miss) alone.

Be ruthless about false negatives. Example: Tunix already ships agentic RL,
truncated importance-sampling correction, GRPO/DPO/PPO + DAPO/Dr.GRPO/GSPO, and
an SGLang-JAX rollout backend — none of those are gaps. Read before you claim.

## Phase 4 — Gap matrix + prioritization

Build the matrix (one row per capability dimension):

| Capability | External SOTA (cited) | `<repo>` today (cited) | Gap | Effort | Leverage |
|---|---|---|---|---|---|

- **Gap**: none / stubbed / partial / absent (a **stubbed** row — declared but
  no-op — usually ranks near the top of the backlog: low effort, high leverage,
  and it's silently misleading today).
- **Effort**: rough S/M/L to build in our stack.
- **Leverage**: why it matters (training quality, throughput, capability unlock).

Then a **prioritized shortlist** of the top opportunities (high leverage ÷
effort, real gap). For each opportunity give:
- the capability and the concrete gap,
- the **entry point** in our code where it'd be built (subsystem / file),
- rough effort,
- the **next action** — usually `/analyze-paper <repo> <technique-slug> --into
  <repo> <url>` to go deep on the specific technique, or `/stack-new` if it's
  already well understood.

## Phase 5 — Research note (the deliverable)

Write/update
`${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/research/<repo>/<slug>.md`.
Anti-bloat: if an existing note covers ≥60%, Edit it and add a dated section.
Frontmatter:

```yaml
---
layer: research
repo: <repo>
slug: <slug>
last_revised: <today>
auto_drafted: false
reviewed_by_human: ~
rejected: false
tags: [gap-scan, <topic>, comparison, ...]
sources:
  - <primary-source-urls>
  - workspace/<repo>/<paths-cited>
---
```

Body: the question; the capability dimensions used; the gap matrix; the
prioritized opportunities with entry points + next actions; **what's verified vs
speculative**; open questions for a future scan.

**This roadmap is scaffolding, not a standing artifact.** Once `/propose` turns
its backlog into actual proposals, the consolidated roadmap is folded into them
and **removed** — the gaps then live inside the proposals (each proposal is a
gap→build), and a proposal never carries a separate "Gap analysis" section. See
`proposals/README.md` → *Anti-bloat & firewall*. The per-concept dossiers this
roadmap was synthesized from stay as evidence; only the consolidated roadmap
folds.

## Phase 6 — Episode + seam

- Episode (`episodes/<YYYY-MM>/<today>-<slug>.md`, standard frontmatter incl.
  `auto_drafted: false`, `reviewed_by_human: ~`, `rejected: false`): the scan,
  the top 3 opportunities, and the single highest-leverage next step.
- If the comparison crosses ecosystems (e.g. PyTorch → JAX), record the edge in
  `guides/seams.md` (`/seam` discipline).

## Phase 7 — Report

Give the user: the top 3 opportunities (one line each), the research-note URL
(`http://127.0.0.1:47777/research/<repo>/<slug>/`), and the single next action
to start building. Don't `git add`/commit — the watch loop handles `research/`,
`episodes/`, and `guides/` (§3a).

## The bar

A good gap-scan is **decision-grade**: every claimed gap is grounded on both
sides, every external claim is verified or flagged speculative, and every
opportunity names where it would be built and what to do next. A survey that
just lists "cool things other frameworks have" has failed.
