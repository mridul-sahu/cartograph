---
description: Capture or UPDATE a per-repo research note (external context, comparisons, design rationale)
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Capture or update a research note. Use this when you've been comparing tools,
reading external code/papers, or capturing design rationale that **isn't** yet
ready to be a topic note (too speculative or too cross-cutting) but is worth
preserving so a future Claude session can pick it up.

## Anti-bloat rule — read this first

**Do NOT create a new note if an existing one covers the topic.** Cartograph
research is a *layered* knowledge base, not an append-only log. Before writing:

1. List existing notes for the repo:
   ```
   !ls -la ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/research/<repo>/
   ```
2. Read the most-relevant existing note(s). The `UserPromptSubmit` hook
   (`scripts/inject-context.sh`) will have surfaced the top-3 matches by
   keyword — read those before doing anything.
3. **If an existing note covers ≥60% of what you'd write**: `Edit` it in
   place. Bump `last_revised:` to today. Add a new section heading (e.g.,
   `## 2026-05-22 update: <what changed>`) so the diff is auditable.
4. **Only if no existing note overlaps**: create a new one.

Cartograph metrics surface bloat — if `loadResearch(repo).length` keeps
climbing without `last_revised` ever updating, that's the smell of
"created instead of revised."

## Arguments

Parse `$ARGUMENTS` as:
- First word: the repo (any tracked fork)
- Second word: a kebab-case slug (e.g., `format-vs-baseline`)
- Rest: the seed body or context for the note

## Write / update flow

1. Resolve the path: `${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/research/<repo>/<slug>.md`.
2. If the file exists:
   - Read it. Decide if this is an update (preferred) or a different topic
     that genuinely needs its own slug. If different, suggest a new slug
     to the user before writing.
   - For updates: `Edit` the file. Append a `## YYYY-MM-DD update` section
     OR revise the relevant section in place. Bump `last_revised:`.
3. If the file does NOT exist:
   - `Write` it with frontmatter:
     ```yaml
     ---
     layer: research
     repo: <repo>
     slug: <slug>
     last_revised: <today>
     tags: [<tag>, ...]
     sources:
       - <url-or-workspace-path>
     ---
     ```
   - Body sections to consider:
     * What this note answers (single sentence)
     * The comparison / claim being made
     * Sources verified
     * What's stable vs speculative
     * Open questions for a future session
4. Cite specific anchors: external URLs for outside material,
   `workspace/<repo>/<path>:<line>` for upstream code.
5. After saving, in 1–2 sentences:
   - What changed
   - The browser URL: `http://cartograph.localhost:47777/research/<repo>/<slug>/`

## When NOT to use /research

- For task-specific worknotes from a session in a fork → use `/episode`.
- For durable mental models of OUR repos → revise a topic note (`/revise`).
- For pre-publication essay shape → use `learn/drafts/` directly.
- For a one-off observation that's worth a single sentence → a code comment
  in the fork (if it explains a non-obvious *why*).
