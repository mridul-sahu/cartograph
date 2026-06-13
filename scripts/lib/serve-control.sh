#!/usr/bin/env bash
# scripts/lib/serve-control.sh — supervision-aware control for the cartograph
# server. Sourced by every code path that starts/restarts/stops serve.py.
#
# THE INVARIANT THIS ENFORCES: when the launchd agent is installed, launchd
# is the ONLY thing allowed to own the listen port. Every restart routes
# through `launchctl kickstart`; nothing ever spawns a detached serve.py that
# could win the port race and lock launchd out (Errno 48 → KeepAlive backoff
# → "supervision drifted" — the exact failure this library exists to kill).
#
# When launchd is NOT installed (someone running raw from a clone), the
# control functions report "unmanaged" (rc 10) so the caller falls back to
# its own detached-launch behaviour.
#
# Functions:
#   cg_launchd_managed      → 0 if the serve agent plist is installed
#   cg_serve_port_listeners → pids LISTENing on the serve port (one per line)
#   cg_launchd_pid          → pid launchd currently reports for the agent (or empty)
#   cg_serve_restart        → managed: clear foreign holders + kickstart -k (rc 0);
#                             unmanaged: rc 10 (caller handles)
#   cg_serve_heal           → idempotent drift repair; prints a line + logs to
#                             errors.log only when it actually repairs something

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
CG_SERVE_LABEL="${CG_SERVE_LABEL:-com.cartograph.serve}"
CG_SERVE_PORT="${CARTOGRAPH_PORT:-47777}"
_CG_SERVE_PLIST="$HOME/Library/LaunchAgents/$CG_SERVE_LABEL.plist"

# errors.sh may already be sourced by the caller. Source it via CARTOGRAPH_ROOT
# (always set above) rather than ${BASH_SOURCE[0]} — the latter is empty when
# this file is sourced from a non-bash shell, which silently left cg_log_error
# as a no-op and dropped drift-repair records. Source unconditionally (it's
# idempotent), then guarantee the function exists.
# shellcheck source=errors.sh
source "$CARTOGRAPH_ROOT/scripts/lib/errors.sh" 2>/dev/null || true
if ! declare -f cg_log_error >/dev/null 2>&1; then
  cg_log_error() { :; }
fi

cg_launchd_managed() { [[ -f "$_CG_SERVE_PLIST" ]]; }

cg_serve_port_listeners() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -ti "tcp:${CG_SERVE_PORT}" -sTCP:LISTEN 2>/dev/null || true
}

cg_launchd_pid() {
  cg_launchd_managed || return 0
  launchctl print "gui/$(id -u)/$CG_SERVE_LABEL" 2>/dev/null \
    | awk -F'= ' '/^[[:space:]]*pid = /{gsub(/[^0-9]/,"",$2); print $2; exit}'
}

# Kill any LISTENer on the port that is NOT the launchd-managed pid. Returns
# the count of foreign holders it cleared (echoed).
_cg_kill_foreign_listeners() {
  local managed="$1" cleared=0 pid
  for pid in $(cg_serve_port_listeners); do
    [[ "$pid" == "$managed" ]] && continue
    kill "$pid" 2>/dev/null || true
    cleared=$((cleared + 1))
  done
  if (( cleared > 0 )); then
    local _ ; for _ in $(seq 1 20); do
      [[ -z "$(cg_serve_port_listeners)" ]] && break
      sleep 0.25
    done
    for pid in $(cg_serve_port_listeners); do
      [[ "$pid" == "$managed" ]] && continue
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
  echo "$cleared"
}

cg_serve_restart() {
  cg_launchd_managed || return 10
  local managed; managed="$(cg_launchd_pid)"
  _cg_kill_foreign_listeners "$managed" >/dev/null
  launchctl kickstart -k "gui/$(id -u)/$CG_SERVE_LABEL" 2>/dev/null
}

# Idempotent drift repair. Healthy → silent rc 0. Repaired → prints a one-line
# summary, logs to errors.log, rc 0. Only acts when launchd is the supervisor.
cg_serve_heal() {
  cg_launchd_managed || return 0
  local managed listeners foreign=""
  managed="$(cg_launchd_pid)"
  listeners="$(cg_serve_port_listeners)"

  local p
  for p in $listeners; do
    [[ "$p" == "$managed" ]] && continue
    foreign+="$p "
  done

  # Drift A: a non-launchd process holds the port (the classic orphan).
  # Drift B: nothing holds the port AND launchd isn't running it (down).
  if [[ -n "$foreign" ]]; then
    local n; n="$(_cg_kill_foreign_listeners "$managed")"
    # Log BEFORE the kickstart: the restarting server briefly disturbs the
    # tree on startup, and a log write racing that window can be lost.
    cg_log_error serve-control "supervision drift: cleared $n foreign listener(s) on :$CG_SERVE_PORT, kickstarting $CG_SERVE_LABEL"
    launchctl kickstart -k "gui/$(id -u)/$CG_SERVE_LABEL" 2>/dev/null
    echo "[serve-control] repaired supervision drift — cleared foreign holder(s), launchd re-owns :$CG_SERVE_PORT"
    return 0
  fi
  if [[ -z "$listeners" && -z "$managed" ]]; then
    cg_log_error serve-control "server down on :$CG_SERVE_PORT — kickstarting $CG_SERVE_LABEL"
    launchctl kickstart "gui/$(id -u)/$CG_SERVE_LABEL" 2>/dev/null
    echo "[serve-control] server was down — kickstarted $CG_SERVE_LABEL"
    return 0
  fi
  return 0
}
