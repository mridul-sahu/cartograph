#!/usr/bin/env bash
# scripts/setup-spice.sh — bootstrap git-spice (gs) for the workspace forks.
#
# Idempotent. Two phases:
#   1. Verify `gs` is installed. If not, print the brew hint and exit
#      non-zero so the caller knows.
#   2. For each fork under workspace/, run `gs repo init` if the fork
#      hasn't been initialized yet. Safe to re-run.
#
# Design: claude-designs/cartograph/stack-workflow/README.md

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
WORKSPACE="$CARTOGRAPH_ROOT/workspace"

# Homebrew installs the binary as `git-spice`; `gs` is the canonical alias
# (intentionally not symlinked by brew to avoid clobbering other `gs` tools).
# Resolve whichever is on PATH.
GS_BIN="$(command -v gs 2>/dev/null || command -v git-spice 2>/dev/null || true)"
if [[ -z "$GS_BIN" ]]; then
  cat >&2 <<'EOF'
[setup-spice] git-spice not found on PATH.

Install with one of:
  brew install git-spice                       # macOS
  go install go.abhg.dev/gs@latest             # via Go toolchain

Then re-run: bash scripts/setup-spice.sh

git-spice is the underlying stacked-branch tool; cartograph's
/stack-* slash commands wrap it. See:
  claude-designs/cartograph/stack-workflow/README.md
EOF
  exit 1
fi

echo "[setup-spice] $GS_BIN $("$GS_BIN" --version 2>&1 | head -1)"

[[ -d "$WORKSPACE" ]] || { echo "[setup-spice] no workspace/ — nothing to init"; exit 0; }

initialized=0
skipped=0
for d in "$WORKSPACE"/*/; do
  [[ -d "$d/.git" ]] || continue
  repo="$(basename "$d")"
  # gs tracks state in .git/spice/ (or a similar subdir depending on version);
  # use `gs repo init --trunk main` which is idempotent.
  trunk="$(git -C "$d" symbolic-ref --short refs/remotes/upstream/HEAD 2>/dev/null | sed 's#^upstream/##')"
  [[ -z "$trunk" ]] && trunk="main"
  if (cd "$d" && "$GS_BIN" repo init --trunk "$trunk" --remote upstream </dev/null >/dev/null 2>&1); then
    echo "  ✓ initialized $repo (trunk=$trunk)"
    initialized=$((initialized + 1))
  else
    # init failures are usually "already initialized" — verify with a status probe.
    if (cd "$d" && "$GS_BIN" ls </dev/null >/dev/null 2>&1); then
      echo "  · $repo already initialized"
      skipped=$((skipped + 1))
    else
      echo "  ⚠ $repo — $GS_BIN repo init failed; run manually inside the fork"
    fi
  fi
done

echo "[setup-spice] $initialized initialized, $skipped already in good shape"
