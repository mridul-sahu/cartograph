#!/usr/bin/env bash
# scripts/drift-drain.sh — one deterministic pass over open drift reports.
#
#   drift-drain.sh [drain] [<repo>]  re-detect per-topic drift, then
#                                    mechanically re-anchor line-shift
#                                    citations (reanchor.py) and close the
#                                    reports that were pure bookkeeping.
#                                    With <repo>, only that fork.
#   drift-drain.sh count [<repo>]    number of open drift reports (cheap)
#
# NO tokens are spent here: since the token-diet rework
# (claude-designs/cartograph/token-diet), the drain is git + python only.
# Reports that survive the pass need judgment and are surfaced to the
# ACTIVE session via the orientation injection (fix per CLAUDE.md §4).
# Repo-level bedrock reports (.drift-reports/<repo>.md) are likewise
# active-session work per §3b; the drain re-anchors bedrock citations but
# never closes those reports itself. For a rare deliberate bulk LLM pass,
# run scripts/auto-revise.sh / scripts/drift-fix.sh by hand.
# Callers: serve.py's drift loop, session-start.sh, repo-refresh.sh,
# maintenance.sh.

set -uo pipefail

# shellcheck source=lib/load-config.sh
source "$(dirname "$0")/lib/load-config.sh"
# shellcheck source=lib/errors.sh
source "$(dirname "$0")/lib/errors.sh"

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
DRIFT_DIR="$CARTOGRAPH_ROOT/.drift-reports"
WORKSPACE="$CARTOGRAPH_ROOT/workspace"

cg_drift_count() {
  local only="${1:-}" n=0
  if [[ -n "$only" ]]; then
    [[ -f "$DRIFT_DIR/$only.md" ]] && n=1
    n=$(( n + $(find "$DRIFT_DIR/topics/$only" -mindepth 1 -maxdepth 1 -name '*.md' -type f 2>/dev/null | wc -l) ))
  else
    n=$(( $(find "$DRIFT_DIR" -maxdepth 1 -name '*.md' -type f 2>/dev/null | wc -l) ))
    n=$(( n + $(find "$DRIFT_DIR/topics" -mindepth 2 -maxdepth 2 -name '*.md' -type f 2>/dev/null | wc -l) ))
  fi
  printf '%s\n' "$n"
}

cg_drift_drain() {
  local only="${1:-}" rc=0
  local repos=()
  if [[ -n "$only" ]]; then
    repos=("$only")
  else
    while IFS= read -r -d '' d; do
      [[ -d "$d/.git" ]] && repos+=("$(basename "$d")")
    done < <(find "$WORKSPACE" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
  fi

  local repo before after
  for repo in "${repos[@]}"; do
    before="$(cg_drift_count "$repo")"
    # Detection first (broad, git-only), then the mechanical resolver
    # (narrow): reports left afterwards genuinely need a human read.
    bash "$SCRIPTS/topic-drift.sh" "$repo" >/dev/null 2>&1 || rc=$?
    python3 "$SCRIPTS/reanchor.py" "$repo" 2>&1 | tail -1 || rc=$?
    after="$(cg_drift_count "$repo")"
    echo "drift-drain: $repo: reports $before -> $after (deterministic pass)"
    if (( rc != 0 )); then
      cg_log_error drift-drain "deterministic pass for $repo exited rc=$rc"
      rc=0
    fi
  done

  echo "drift-drain: remaining=$(cg_drift_count "$only") — survivors need an active-session read (§4)"
}

cmd="${1:-drain}"
case "$cmd" in
  drain) cg_drift_drain "${2:-}" ;;
  count) cg_drift_count "${2:-}" ;;
  *) echo "usage: drift-drain.sh [drain|count] [<repo>]" >&2; exit 2 ;;
esac
