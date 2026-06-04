---
description: Author a formal, well-researched proposal docx (the standing final-draft structure) for a finalized proposal or umbrella
allowed-tools: Skill, Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
---

Turn a `final` proposal (or an umbrella + its children) into a **formal,
well-researched, well-detailed proposal docx** — the deliverable that travels to
reviewers and external eyes. This is the lifecycle's `final` → `proposal-docx`
step, but with a **fixed, non-negotiable section structure** and a real research
bar. A thin render of the proposal markdown is *not* a final draft.

## Arguments

Parse `$ARGUMENTS`: `<repo> <slug> [--umbrella]`.
- `<repo> <slug>` — the proposal to formalize.
- `--umbrella` — `<slug>` is an umbrella; fold its `parent:`-nested children +
  any referenced cross-cutting proposals into ONE document. (Auto-detected if the
  proposal has children, but pass it to be explicit.)

Today's date: !`date +%Y-%m-%d`

## The standing structure (THE RULE — every final draft, in this order)

This is the load-bearing contract. Do not reorder, drop, or rename sections.

1. **Introduction** — *short.* In a page or less: what we propose and why it
   matters. The elevator pitch + the one-paragraph case. A reader who stops here
   should know what we want to build and why it's worth it.
2. **Background** — *deep, detailed, grounded.* What is **already implemented in
   Tunix today**, in real detail (subsystems, the actual code seams, what works
   and what's missing), and **why our proposed work helps** given that reality.
   This is where we prove we understand the system we're extending. Ground every
   claim in the topic notes + the upstream code (cite repo-relative paths). Be
   concrete — a reviewer must trust we know the codebase cold.
3. **Ecosystem** — *the grounded sales pitch.* Who has **already built something
   similar** (frameworks, labs, products) and the **papers** around it. This is a
   disguised but honest sales pitch: "the serious players all built this; here is
   the evidence." Name real systems (verl, OpenRLHF, TRL, NeMo-Aligner, AReaL,
   SkyRL, …) and cite real papers. Distinguish a durable shift from hype.
   - **3a. Impact (sub-section)** — the **impact this class of infra has already
     had on the ecosystem** (the capability/quality/cost wins others got from
     it), and therefore **why JAX/TPU should have it too**. Quantify where the
     literature does (the deltas, the adoption, the model results).
4. **High-Level Design (HLD)** — *roughly how we build it.* The architecture,
   data flow, the pillars/components, the public surfaces, the MVP and the
   sequencing. Enough technical substance to assess soundness; outcome-framed.
   Diagrams here (see toolchain). Not a line-by-line impl plan — the shape.
5. **Feasibility & Risk analysis** — can we build it (effort, dependencies, the
   hardest unsolved part), and the **falsifiable risks** that would kill or
   change it, each with a mitigation. Honest, not a victory lap.
6. **References** — every cited paper, system, repo-relative code path, and topic
   note. Numbered or bulleted, complete enough to verify the doc.

## Phase 0 — Cartograph first

Read the proposal(s) you're formalizing + everything grounding them:
- `proposals/<repo>/<slug>.md` (+ each child if `--umbrella`).
- The `research/<repo>/*.md` dossiers they cite (the Ecosystem + Impact raw
  material) and the `guides/<repo>/topics/*.md` they cite (the Background raw
  material).
- The upstream code under `workspace/<repo>/` for the Background's code seams and
  the HLD's entry points — **verify against HEAD**, don't trust stale citations.

## Phase 1 — Research (fill the gaps, well)

The bar is "well researched." Where the existing notes are thin for a section:
- **Background:** widen into the topic notes + read the actual code. A reviewer
  must believe we know exactly what Tunix does today.
- **Ecosystem + Impact:** WebSearch/WebFetch primary sources (papers, framework
  docs, model cards, eng blogs). Adversarially verify load-bearing claims and the
  quantified impact numbers before stating them. Prefer 2023–2026 primary work.

## Phase 2 — Author the final-draft markdown

Write `proposals/<repo>/<slug>.final-draft.md` (the docx *source*; the builder
renders it). Frontmatter: `layer: proposal-final-draft / repo / slug /
last_revised / auto_drafted: true / reviewed_by_human: ~ / rejected: false /
sources: [...]`. Body = the six structured sections above, future-tense,
outcome-framed, plain-English-first. Author **`d2` diagram blocks** in the HLD
(architecture / data flow / pillar map) — the builder renders + embeds them.
Use blockquote callouts (`> **Impact:** …`) for the green/red rail emphases.

## Phase 3 — Build + validate the docx

```
just proposal-final-draft <repo> <slug>     # renders <slug>.final-draft.md → <slug>.docx (d2 → PNG)
```

Then validate (must report `All validations PASSED!`):
`python3 <document-skills>/skills/docx/scripts/office/validate.py proposals/<repo>/<slug>.docx`

Toolchain is the design-doc one (CLAUDE.md §3c): docx-js engine, Roboto / Roboto
Serif / Roboto Mono, charcoal `#111827` + indigo `#4338CA`, US Letter, 1-inch
margins, `d2` diagrams.

## Firewall

This docx travels to reviewers. **NEVER** write "Cartograph", "Rudrite", "Claude",
or "Anthropic", and use **no** private absolute filesystem paths (repo-relative
only) — *unless* the user has explicitly relaxed this for a specific proposal
(e.g. a capability proposal authorized to cite Anthropic/Claude work). Public
systems/labs/papers are always fine — they're the evidence base.

## The bar

A final draft is **investable and trustworthy**: the Introduction sells it in a
page, the Background proves we know the system, the Ecosystem + Impact prove the
world already validated the bet, the HLD proves it's buildable, and Feasibility &
Risk proves we're honest about what could go wrong. Every number cited, every
code seam real, every section in the fixed order above.
