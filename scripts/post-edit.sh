#!/usr/bin/env bash
# scripts/post-edit.sh — the single PostToolUse:Edit|Write hook entry
# (dispatcher).
#
# Captures the hook payload once and fans it out to each step in a fixed
# order. All steps are warn-only (token-check deliberately never blocks);
# child failures are swallowed so an edit is never interrupted by hook
# plumbing.

set -uo pipefail

DIR="$(dirname "$0")"
payload="$(cat 2>/dev/null || true)"

run() { printf '%s' "$payload" | bash "$@" || true; }

run "$DIR/token-check.sh"                     # identity-token early warning
run "$DIR/session-log.sh" touch               # session worknote heartbeat
run "$DIR/post-edit-topic-mark.sh"            # flag topics whose cited files moved
run "$DIR/normalize-note-frontmatter.sh"      # backfill review-queue frontmatter
run "$DIR/distill-signal.sh"                  # binding distillation contract when a tag crosses threshold

exit 0
