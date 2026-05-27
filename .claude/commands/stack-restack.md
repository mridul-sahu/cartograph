---
description: Rebase descendants after a parent moved (via git-spice)
allowed-tools: Bash
---

The user wants to cascade-rebase descendants of the current branch.

Use this when:
- The current branch's parent gained new commits (e.g. you amended)
- A PR upstream of you in the stack merged into main

`gs upstack restack` walks every descendant of the current branch and
rebases each one onto its (new) parent in turn. Conflicts surface
inline — resolve with the usual `git add` + `git rebase --continue`,
then re-run.

!`GS="$(command -v gs 2>/dev/null || command -v git-spice 2>/dev/null)"; if [ -n "$GS" ]; then "$GS" upstack restack; else echo "[install git-spice first] bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/setup-spice.sh"; fi`

After a clean restack: `/stack-submit` to push everything.
