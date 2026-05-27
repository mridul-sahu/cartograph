---
description: Create a new branch on top of HEAD via git-spice (tracks parent automatically)
allowed-tools: Bash
---

The user wants to create a new branch in the current stack. Slug: $ARGUMENTS

`gs branch create` creates the branch AND records the current branch as
its parent — so subsequent `/stack-restack` and `/stack-submit` know
the topology without any extra config.

!`GS="$(command -v gs 2>/dev/null || command -v git-spice 2>/dev/null)"; if [ -n "$GS" ]; then "$GS" branch create "$ARGUMENTS"; else echo "[install git-spice first] bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/setup-spice.sh"; fi`

After creating: make your edits, `git commit`, then `/stack-pr` to push
+ open the PR with the parent already set correctly.
