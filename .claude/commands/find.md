---
description: BM25 search across all Cartograph notes (semantic alternative to /cite)
allowed-tools: Bash
---

The user wants to find relevant Cartograph notes for: $ARGUMENTS

`/cite` does fixed-string grep. `/find` does BM25 retrieval — ranked
across all layers by token frequency × inverse-document-frequency. Use
it when the surface words probably don't match the note's wording
("checkpoint hangs on multi-host" vs the note titled
`async-checkpoint-flow`).

The BM25 index lives at `.cartograph/index/bm25.json`, rebuilt at every
SessionStart by `scripts/build-search-index.py`.

!`python3 ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/build-search-index.py --query "$ARGUMENTS" --k 10`

Quick filters: pass `--repo <r>` or `--layer <topic|episode|...>` to
narrow.

Use `/find` to discover where a *concept* lives, `/whatknows <path>` to
discover what we know about a *file*, `/cite <symbol>` for an exact
identifier match.
