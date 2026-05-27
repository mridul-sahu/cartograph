---
description: Run the Cartograph content lint and show quality-bar violations
allowed-tools: Bash
---

Run the lint:

!`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/lint-content.sh --human`

Summarize: how many hard fails, how many soft warns, which files need
the most attention. If anything is below the word-count floor, suggest
whether to revise in place or re-run a deeper backfill agent.

See `docs/quality-bar.md` for the rules being enforced.
