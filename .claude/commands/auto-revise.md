---
description: Headless drift-resolution via `claude -p` — manual trigger for the same drain the serve.py drift loop runs on an interval
allowed-tools: Bash
---

Invoke the auto-revise loop for: $ARGUMENTS

This runs `claude -p` non-interactively against the drift report(s), letting
Claude revise bedrock in place where contradictions exist, bump frontmatter,
and delete the drift report. The user reviews via `git diff` before pushing.

If $ARGUMENTS is empty, run for all repos with open drift reports:
!`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/auto-revise.sh --all`

Otherwise resolve just that repo:
!`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/auto-revise.sh "$ARGUMENTS"`

After the script finishes, show the user the resulting `git diff --stat` for
guides/ so they can audit what changed:
!`git -C ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR} diff --stat guides/`
