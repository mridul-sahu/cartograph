---
description: Pull main + cascade-rebase the entire stack (post-merge recovery)
allowed-tools: Bash
---

The user wants to sync the local stack with upstream after one or more
PRs in the chain merged.

`gs repo sync` does this in one shot:
1. Fetches every remote
2. Detects branches whose PR merged (deletes them locally)
3. Updates trunk (main)
4. Restacks every remaining branch onto the new trunk

This is the post-merge cascade — the loop the user explicitly called
out in the stacked-PR write-up.

!`GS="$(command -v gs 2>/dev/null || command -v git-spice 2>/dev/null)"; if [ -n "$GS" ]; then "$GS" repo sync; else echo "[install git-spice first] bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/setup-spice.sh"; fi`

After sync: `/stack` to verify the new shape.
