#!/usr/bin/env bash
# scripts/drift-drain.sh — one best-effort pass over every open drift report.
#
#   drift-drain.sh [drain]   resolve all open drift, one headless agent at a
#                            time (repo-level via auto-revise.sh, per-topic
#                            via drift-fix.sh)
#   drift-drain.sh count     number of open drift reports (cheap, no claude)
#
# Every claude spawn underneath routes through lib/headless.sh, so the global
# CARTOGRAPH_HEADLESS_MAX cap, the recursion guard, and the kill switch all
# apply. When a spawn defers (cap occupied) the pass stops early — the
# remaining reports are untouched and retry on the next pass. Callers:
# serve.py's drift loop (interval-driven) and maintenance.sh (nightly).

set -uo pipefail

# shellcheck source=lib/headless.sh
source "$(dirname "$0")/lib/headless.sh"   # also sets CARTOGRAPH_ROOT
# shellcheck source=lib/errors.sh
source "$(dirname "$0")/lib/errors.sh"

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
DRIFT_DIR="$CARTOGRAPH_ROOT/.drift-reports"

cg_drift_count() {
  local n=0
  n=$(( $(find "$DRIFT_DIR" -maxdepth 1 -name '*.md' -type f 2>/dev/null | wc -l) ))
  n=$(( n + $(find "$DRIFT_DIR/topics" -mindepth 2 -maxdepth 2 -name '*.md' -type f 2>/dev/null | wc -l) ))
  printf '%s\n' "$n"
}

cg_drift_drain() {
  cg_autospawn_guard           # no-op inside a headless agent / kill switch on

  local repos=0 topics=0 deferred=0 rc

  # Repo-level reports (.drift-reports/<repo>.md) → auto-revise.sh.
  local report repo
  for report in "$DRIFT_DIR"/*.md; do
    [[ -f "$report" ]] || continue
    repo="$(basename "${report%.md}")"
    echo "drift-drain: auto-revise '$repo'"
    rc=0
    bash "$SCRIPTS/auto-revise.sh" "$repo" || rc=$?
    if (( rc == 75 || rc == 77 )); then
      deferred=1
      break
    fi
    if (( rc != 0 )); then
      cg_log_error drift-drain "auto-revise $repo failed (rc=$rc)"
    fi
    repos=$((repos + 1))
  done

  # Per-topic reports (.drift-reports/topics/<repo>/<slug>.md) → drift-fix.sh.
  local slug
  if (( deferred == 0 )) && [[ -d "$DRIFT_DIR/topics" ]]; then
    while IFS= read -r report; do
      repo="$(basename "$(dirname "$report")")"
      slug="$(basename "${report%.md}")"
      echo "drift-drain: drift-fix '$repo/$slug'"
      rc=0
      bash "$SCRIPTS/drift-fix.sh" "$repo" "$slug" || rc=$?
      if (( rc == 75 || rc == 77 )); then
        deferred=1
        break
      fi
      if (( rc != 0 )); then
        cg_log_error drift-drain "drift-fix $repo/$slug failed (rc=$rc)"
      fi
      topics=$((topics + 1))
    done < <(find "$DRIFT_DIR/topics" -mindepth 2 -maxdepth 2 -name '*.md' -type f 2>/dev/null | sort)
  fi

  echo "drift-drain: repos=$repos topics=$topics deferred=$deferred remaining=$(cg_drift_count)"
}

cmd="${1:-drain}"
case "$cmd" in
  drain) cg_drift_drain ;;
  count) cg_drift_count ;;
  *) echo "usage: drift-drain.sh [drain|count]" >&2; exit 2 ;;
esac
