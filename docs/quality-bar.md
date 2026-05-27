# Cartograph quality bar

The bar each layer of content must clear. Enforced by `scripts/lint-content.sh`
and surfaced in the UI dashboard.

## Bedrock (`guides/<repo>/{overview,architecture,conventions}.md`)

Bedrock is *not* an exhaustive reference — that's what topic notes and
walkthroughs are for. Bedrock is the **brief, dense, authoritative orientation
that every Claude session sees on every turn**. Quality matters because it's
loaded on every turn.

### Required floor

| File | Min words | Required sections | Citation density |
|---|---|---|---|
| `overview.md` | 800 | "What this codebase does" · "Major subsystems" · "Non-obvious design decisions" · "Surprises and gotchas" · "Seams to other repos" | ≥1 file:line per 250 words |
| `architecture.md` | 1000 | "Top-level layout" · "Where to find things" (must be a table) · "Build artifacts to ignore" · "Files Claude should rarely need to read" | ≥1 file:line per 200 words |
| `conventions.md` | 600 | "Build & test" · "PR norms" · "Code-style specifics" · "Things that look broken but aren't" | ≥1 concrete command per 200 words |

### Required frontmatter

- `layer: bedrock`
- `repo: <name>` (consistent across the three files)
- `last_revised: YYYY-MM-DD` (within 30 days OR no upstream drift)
- `backfilled_from_sha: <sha>` (matches current upstream within 30 days)

### Forbidden content

- Any `TODO`, `FIXME`, `XXX` literal
- Any "(fill in)" / "TBD" / placeholder boilerplate
- "Lorem ipsum"-style generic prose
- Any forbidden identity token (framework defaults: `cartograph`, `claude code/opus/sonnet/haiku`, `anthropic`; plus anything in `CARTOGRAPH_FORBIDDEN_EXTRAS`)
- More than 2 paragraphs of pure prose without a citation or list

### Quality signals worth tracking

- **Citation density**: `file:line` references per 100 words. Higher = more grounded.
- **Concept-naming density**: distinct nouns drawn from the codebase per 100 words. Higher = less generic.
- **Question density**: bedrock should not be a question-driven explainer. Aim for ≤1 rhetorical question per 500 words.
- **Cross-references**: at least one link to `seams.md` or to a topic note per bedrock file.

## Topic notes (`guides/<repo>/topics/<name>.md`)

Layer 2. Revised in place when contradicted.

### Required floor

- 1000–1500 words (hard floor 800)
- Required frontmatter: `layer: topic`, `repo`, `topic`, `last_revised`, `synthesized_from_exploration` (bool), `reviewed_by_human` (date or `~`), `distilled_from` (list of episode paths or `[]`)
- ≥3 file:line citations
- ≥1 paragraph naming what's non-obvious about the subsystem (not just describing it)
- For synthesized notes: must carry `synthesized_from_exploration: true` (honest provenance)

### Forbidden

- Restating what bedrock already says
- TODO/FIXME placeholders
- Generic prose with no citations

## Episodes (`episodes/YYYY-MM/*.md`)

Layer 3. Append-only.

### Required floor

- 200–600 words (hard ceiling 800)
- Required frontmatter: `layer: episode`, `date`, `repo`, `files_touched`, `tags`, `superseded_by` (defaults `~`), `distilled_into` (defaults `~`)
- ≥2 tags
- ≥1 file from `files_touched` must actually exist in the relevant workspace fork

### Forbidden

- Episodes without a clear "what I learned" — if the session was trivial, skip the episode
- Tags that are too generic (e.g., `bug`, `feature` alone). Tags should be subsystem-specific.

## Walkthroughs (`learn/walkthroughs/*.md`)

Pedagogical narrative.

### Required floor

- 2000–3000 words (soft ceiling 4000)
- Required frontmatter: `kind: walkthrough`, `repo` (or `repos` for cross-repo), `topic`, `last_revised`
- ≥1 Mermaid diagram (sequence, flow, or graph)
- ≥5 file:line citations
- Clear narrative arc — start, middle, end

### Forbidden

- Walkthroughs that just enumerate features without a story
- Diagrams without a payoff (every Mermaid block must explain something the prose alone can't)

## Ramp-ups (`learn/ramp-up/<repo>.md`)

5-day onboarding sequences.

### Required floor

- 1500–2000 words
- Required frontmatter: `kind: ramp-up`, `repo`, `estimated_days`, `last_revised`
- Day-by-day structure (Day 1, Day 2, …) with **Goal · Read · Do · Outcome** per day
- Each "Read" item must cite a specific file

## Enforcement

- `scripts/lint-content.sh` runs all checks and emits JSON (or `--human`).
- Hard failures: missing required sections, missing frontmatter, forbidden tokens.
- Soft warnings: below word-count floor, low citation density, generic prose detection.
- UI panel on `/status` surfaces per-repo quality scores.
- Pre-commit hook (future): block commits that introduce hard-fail content under `guides/` or `learn/`.

## Why the bar exists

Cartograph orientation injects ~16K tokens of context every turn. If that
context is thin or generic, we're paying token budget for noise. The bar
ensures the per-turn injection is dense, specific, and grounded. Every
sentence has to earn its place in the injection.
