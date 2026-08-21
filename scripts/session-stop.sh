#!/usr/bin/env bash
# scripts/session-stop.sh — the single Stop hook entry (dispatcher).
#
# Captures the hook payload once and fans it out to each step in a fixed
# order. Every step is best-effort and warn-only: a Stop hook must never
# block the session, so child failures are swallowed (each child logs its
# own errors via lib/errors.sh where it matters).

set -uo pipefail

DIR="$(dirname "$0")"
payload="$(cat 2>/dev/null || true)"

run() { printf '%s' "$payload" | bash "$@" || true; }

run "$DIR/episode-prompt.sh"          # discipline scorecard + write-it-now reminders
run "$DIR/usage-audit.sh"             # chassis-utilization audit for this session
run "$DIR/update-note-usage.sh"       # attribute note usage back to the ranking
run "$DIR/session-log.sh" stop        # close the session worknote

exit 0
