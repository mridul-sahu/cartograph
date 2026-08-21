#!/usr/bin/env bash
# scripts/session-start.sh — SessionStart dispatcher.
#
# Runs the lightweight session-log start ALWAYS, then a handful of cheap
# per-session steps for a real interactive session. The heavy work moved to
# the serve daemon (index rebuilds ride the content watcher, upstream fetch
# runs on a 6h loop, diary/anchor audits ride the daily maintenance pass),
# so a session starts in well under a second. A headless agent
# (CARTOGRAPH_HEADLESS=1, the eval harness) skips even the cheap steps.

set -uo pipefail

DIR="$(dirname "$0")"
CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$(cd "$DIR/.." && pwd)}"

# Lightweight, always: record this session so PostToolUse touches land in its
# own log (and not a concurrent interactive session's).
bash "$DIR/session-log.sh" start || true

# Heavy steps: skip inside a headless session (the eval harness sets the
# marker so its claude -p runs don't rebuild indexes or kick drift).
if [[ "${CARTOGRAPH_HEADLESS:-0}" == "1" ]]; then
  exit 0
fi

# Supervision self-heal: if launchd manages the server but an orphan won the
# port (or it's down), repair it. Cheap (one lsof + one launchctl print) and
# silent unless it actually fixes drift.
# shellcheck source=lib/serve-control.sh
source "$DIR/lib/serve-control.sh" 2>/dev/null && cg_serve_heal || true

# Surface a stale maintenance pass (serve daemon down for days, loop
# wedged) so a silently-not-running maintenance is visible in the error
# feed instead of invisible.
maint_log="$CARTOGRAPH_ROOT/.cartograph/maintenance.log"
if [[ -f "$maint_log" ]]; then
  age_h="$(python3 -c "import os,time;print(int((time.time()-os.path.getmtime('$maint_log'))/3600))" 2>/dev/null || echo 0)"
  if (( age_h > 36 )); then
    source "$DIR/lib/errors.sh" 2>/dev/null \
      && cg_log_error session-start "maintenance.log ${age_h}h stale — the serve daemon's daily pass may not be firing (check .cartograph/logs/serve.err.log)" \
      || true
  fi
fi

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

# Promotion-candidate digest: the daemon precomputes it on every content
# change; fall back to a live run only when the cache is missing.
cat "$CARTOGRAPH_ROOT/.cartograph/state/digest-cache" 2>/dev/null \
  || bash "$DIR/digest.sh" || true

exit 0
