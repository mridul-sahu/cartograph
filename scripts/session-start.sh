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

# Supervision self-heal: if launchd manages the server but an orphan won the
# port (or it's down), repair it. Cheap (one lsof + one launchctl print) and
# silent unless it actually fixes drift.
# shellcheck source=lib/serve-control.sh
source "$DIR/lib/serve-control.sh" 2>/dev/null && cg_serve_heal || true

# Surface a stale nightly maintenance pass (machine asleep through the 03:30
# slot, launchd agent unloaded, etc.) so a silently-not-running maintenance
# is visible in the error feed instead of invisible.
maint_log="$CARTOGRAPH_ROOT/.cartograph/maintenance.log"
if [[ -f "$maint_log" ]]; then
  age_h="$(python3 -c "import os,time;print(int((time.time()-os.path.getmtime('$maint_log'))/3600))" 2>/dev/null || echo 0)"
  if (( age_h > 36 )); then
    source "$DIR/lib/errors.sh" 2>/dev/null \
      && cg_log_error session-start "maintenance.log ${age_h}h stale — nightly pass may not be firing (launchctl print gui/\$(id -u)/com.cartograph.maintenance)" \
      || true
  fi
fi

"$DIR/upstream-sync.sh" || true

# Stale-repo pass: starting a session inside a fork kicks the deterministic
# drift pass (topic-drift re-detection + reanchor.py) detached in the
# background. Costs git + python only — no tokens (token-diet rework).
# Reports that survive it are surfaced by the orientation injection as
# work items for THIS session.
if [[ "${CARTOGRAPH_DRIFT_AUTOFIX:-1}" != "0" ]]; then
  _cwd="$(pwd -P)"
  _ws="$(cd "$CARTOGRAPH_ROOT/workspace" 2>/dev/null && pwd -P || true)"
  if [[ -n "$_ws" && "$_cwd" == "$_ws"/* ]]; then
    _repo="${_cwd#"$_ws"/}"
    _repo="${_repo%%/*}"
    nohup bash "$DIR/drift-drain.sh" drain "$_repo" \
      > /dev/null 2>&1 < /dev/null &
    disown 2>/dev/null || true
    echo "session-start: deterministic drift pass for $_repo running in background (no tokens)"
    # Snapshot the open reports so the Stop scorecard can grade this
    # session (resolved vs carried) and the turn-1 contract can mark
    # items carried over from the previous session.
    _snap_dir="$CARTOGRAPH_ROOT/.cartograph/state"
    mkdir -p "$_snap_dir"
    _snap="$_snap_dir/drift-snapshot-$_repo"
    [[ -f "$_snap" ]] && mv "$_snap" "$_snap.prev"
    {
      [[ -f "$CARTOGRAPH_ROOT/.drift-reports/$_repo.md" ]] && echo "__bedrock__"
      ls "$CARTOGRAPH_ROOT/.drift-reports/topics/$_repo" 2>/dev/null
    } > "$_snap" || true
  fi
fi

bash "$DIR/digest.sh" || true
bash "$DIR/auto-promote.sh" || true
bash "$DIR/auto-review-scan.sh" || true
# Validate frontmatter BEFORE the index builds — a malformed block makes a
# note silently unretrievable; surface it instead.
python3 "$DIR/validate-frontmatter.py" --root "$CARTOGRAPH_ROOT" \
  --errors-log "$CARTOGRAPH_ROOT/.cartograph/errors.log" || true
python3 "$DIR/build-file-index.py" --quiet || true
python3 "$DIR/build-search-index.py" --quiet || true
python3 "$DIR/anchor-coverage.py" >/dev/null || true
bash "$DIR/diary.sh" --if-stale || true

exit 0
