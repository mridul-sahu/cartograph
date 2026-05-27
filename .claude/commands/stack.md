---
description: Show the current branch stack (uses git-spice if available)
allowed-tools: Bash
---

The user wants to see the branch stack for the current fork.

If `gs` (git-spice) is installed, it knows the parent tracking precisely:

!`GS="$(command -v gs 2>/dev/null || command -v git-spice 2>/dev/null)"; [ -n "$GS" ] && "$GS" ls 2>&1 || echo "(git-spice not installed — falling back to ancestry-based discovery)"`

If git-spice isn't installed, fall back to cartograph's ancestry-based stack
discovery via the chassis API. If the API is also unreachable, fall back
again to a basic git log of branches:

!`GS="$(command -v gs 2>/dev/null || command -v git-spice 2>/dev/null)";
if [ -z "$GS" ]; then
  if curl -sf --connect-timeout 1 -o /dev/null "http://127.0.0.1:47777/api/healthz" 2>/dev/null; then
    curl -fsS "http://127.0.0.1:47777/api/stack/$(basename "$(pwd)")" 2>&1 | python3 -m json.tool 2>&1 | head -50
  else
    echo "(server not running at :47777 — falling back to git-only view)"
    echo
    echo "Local branches sorted by committer date:"
    git for-each-ref --sort=-committerdate --format='  %(refname:short) (%(committerdate:relative))' refs/heads/ | head -20
    echo
    echo "Start the server with 'just serve' to see PR state, cascade hints,"
    echo "and the per-branch diff/PR links at http://localhost:47777/repo/<repo>/stack/"
  fi
fi`

For the rendered UI view: `/repo/<repo>/stack` in the local web UI.

To install git-spice: `bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/setup-spice.sh`.
See `claude-designs/cartograph/stack-workflow/` for the design rationale.
