---
description: Push every branch in the stack and open/update each PR (via git-spice)
allowed-tools: Bash
---

The user wants to submit the entire stack of PRs at once.

`gs stack submit` walks every branch in the current stack from trunk
upward, pushing each one (`--force-with-lease`) and opening or updating
its PR. Each PR's base ref points at the previous branch in the stack,
so reviewers see a clean chain.

!`GS="$(command -v gs 2>/dev/null || command -v git-spice 2>/dev/null)"; if [ -n "$GS" ]; then "$GS" stack submit; else echo "[install git-spice first] bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/setup-spice.sh"; fi`
