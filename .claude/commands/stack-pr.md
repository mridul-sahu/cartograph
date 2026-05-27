---
description: Push current branch and open/update its PR (via git-spice)
allowed-tools: Bash
---

The user wants to open or update the PR for the current branch.

`gs branch submit` pushes the branch (with `--force-with-lease`) and
opens a PR whose base ref is the tracked parent — no manual `--base`
needed. If a PR already exists for this branch, it updates it.

Per the identity rule (workspace/<repo>/CLAUDE.md): commit author is
`[your-github-user]`, no Cartograph/Claude tokens reach the PR title
or body. git-spice respects this — the PR body comes from your commit
messages.

!`GS="$(command -v gs 2>/dev/null || command -v git-spice 2>/dev/null)"; if [ -n "$GS" ]; then "$GS" branch submit; else echo "[install git-spice first] bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/setup-spice.sh"; fi`
