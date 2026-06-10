#!/usr/bin/env bash
# scripts/lib/errors.sh — the central error log for chassis scripts.
#
# Hooks and background scripts swallow failures by design (a broken hook
# must never break the user's session) — which makes those failures
# invisible. This lib gives every swallow-point one line to call so the
# failure is at least *recorded*:
#
#   source "$(dirname "$0")/lib/errors.sh"
#   some_command || cg_log_error my-script "some_command failed (rc=$?)"
#
# Format: ISO8601<TAB>script<TAB>message, appended to
# $CARTOGRAPH_ROOT/.cartograph/errors.log. Never fails — every internal
# step is best-effort, so wiring it into a failure path can't introduce
# a new failure. Self-rotating: past 2000 lines, the last 1000 are kept.

if [[ -z "${CARTOGRAPH_ROOT:-}" ]]; then
  # This lib lives at scripts/lib/errors.sh — root is two levels up.
  CARTOGRAPH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

CG_ERRORS_LOG="$CARTOGRAPH_ROOT/.cartograph/errors.log"

# cg_log_error <script-name> <message...> — append one record. Newlines and
# tabs in the message are flattened to spaces so the log stays one-per-line.
cg_log_error() {
  {
    local script="${1:-unknown}"
    shift 2>/dev/null || true
    local msg="${*:-}"
    msg="${msg//$'\n'/ }"
    msg="${msg//$'\t'/ }"
    mkdir -p "${CG_ERRORS_LOG%/*}"
    printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$script" "$msg" \
      >> "$CG_ERRORS_LOG"
    local lines
    lines="$(wc -l < "$CG_ERRORS_LOG" 2>/dev/null || echo 0)"
    lines="${lines//[!0-9]/}"
    if (( ${lines:-0} > 2000 )); then
      tail -n 1000 "$CG_ERRORS_LOG" > "$CG_ERRORS_LOG.tmp" \
        && mv "$CG_ERRORS_LOG.tmp" "$CG_ERRORS_LOG"
    fi
  } 2>/dev/null || true
  return 0
}

# cg_errors_tail [n] — print the last n records (default 20).
cg_errors_tail() {
  local n="${1:-20}"
  [[ -f "$CG_ERRORS_LOG" ]] || return 0
  tail -n "$n" "$CG_ERRORS_LOG" 2>/dev/null || true
  return 0
}
