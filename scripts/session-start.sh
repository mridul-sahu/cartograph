#!/usr/bin/env bash
# scripts/session-start.sh — SessionStart dispatcher.
#
# Runs the lightweight session-log start ALWAYS, then the heavy orientation /
# index / curation steps ONLY for a real interactive session. A headless agent
# (CARTOGRAPH_HEADLESS=1) skips all the heavy work — it needs no orientation and
# must not re-run the file/search index builds. Those re-runs, fired by every
# spawned agent's own SessionStart, were a big part of why the old swarm pegged
# the CPU. Consolidating the eight separate SessionStart hooks behind one guard
# is the "fewest builds" half of the rebuild.

set -uo pipefail

# shellcheck source=lib/headless.sh
source "$(dirname "$0")/lib/headless.sh"   # sets CARTOGRAPH_ROOT; cg_in_headless
DIR="$(dirname "$0")"

# Lightweight, always: record this session so PostToolUse touches land in its
# own log (and not a concurrent interactive session's).
bash "$DIR/session-log.sh" start || true

# Heavy steps: skip inside a headless agent or when spawns are disabled.
if cg_in_headless || cg_headless_disabled; then
  exit 0
fi

"$DIR/upstream-sync.sh" || true
bash "$DIR/digest.sh" || true
bash "$DIR/auto-promote.sh" || true
python3 "$DIR/build-file-index.py" --quiet || true
python3 "$DIR/build-search-index.py" --quiet || true
python3 "$DIR/anchor-coverage.py" >/dev/null || true
bash "$DIR/diary.sh" --if-stale || true

exit 0
