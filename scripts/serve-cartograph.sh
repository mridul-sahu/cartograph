#!/usr/bin/env bash
# scripts/serve-cartograph.sh — run the cartograph FastAPI server (scripts/serve.py)
# detached by default, mirroring serve-code-server.sh.
#
# Default: background on 127.0.0.1:47777, logging to $TMPDIR/cartograph-serve.log,
# surviving terminal close (nohup + disown). Idempotent: if something already
# LISTENs on the port it reports and exits 0 instead of double-binding.
#
# Usage:
#   scripts/serve-cartograph.sh              # start detached (default)
#   scripts/serve-cartograph.sh --foreground # run in the foreground (old behaviour)
#   scripts/serve-cartograph.sh --stop       # kill the running server
#   scripts/serve-cartograph.sh --restart    # stop (if any) then start detached
#
# Honours CARTOGRAPH_PYTHON (interpreter) and CARTOGRAPH_RELOAD (serve.py reads it).

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
PORT="${CARTOGRAPH_PORT:-47777}"
PY="${CARTOGRAPH_PYTHON:-python3}"
LOG="${TMPDIR:-/tmp}/cartograph-serve.log"

# Supervision-aware control. When the launchd agent is installed, start/stop/
# restart route through launchd so this script never spawns a detached server
# that competes with the supervisor for the port. --foreground is exempt: it
# IS launchd's entrypoint (routing it through launchd would recurse).
# shellcheck source=lib/serve-control.sh
source "$CARTOGRAPH_ROOT/scripts/lib/serve-control.sh"

listeners() {
  lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

stop() {
  local pids
  pids="$(listeners)"
  if [[ -z "$pids" ]]; then
    echo "no cartograph server LISTEN on :$PORT."
    return 0
  fi
  echo "$pids" | xargs kill 2>/dev/null || true
  # Wait up to ~5s for graceful uvicorn shutdown, then force-kill stragglers.
  for _ in $(seq 1 20); do
    [[ -z "$(listeners)" ]] && break
    sleep 0.25
  done
  pids="$(listeners)"
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
  echo "cartograph server stopped."
}

start() {
  local existing
  existing="$(listeners)"
  if [[ -n "$existing" ]]; then
    echo "cartograph already running on :$PORT (pid $(echo "$existing" | tr '\n' ' '))."
    echo "  restart with: $0 --restart"
    return 0
  fi
  cd "$CARTOGRAPH_ROOT" || exit 1
  nohup "$PY" scripts/serve.py < /dev/null > "$LOG" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "cartograph started — pid $pid, log $LOG"
  echo "open: http://localhost:$PORT/"
}

case "${1:-}" in
  --stop)
    if cg_launchd_managed; then
      echo "launchd supervises this server (KeepAlive) — a plain stop would just respawn."
      echo "  to stop for real: bash scripts/setup-launchd.sh --uninstall"
      echo "  to restart:       $0 --restart"
      exit 0
    fi
    stop ;;
  --restart)
    if cg_serve_restart; then
      echo "restarted via launchd ($CG_SERVE_LABEL)."
      exit 0
    fi
    stop; start ;;
  --foreground|--fg)  cd "$CARTOGRAPH_ROOT" || exit 1; exec "$PY" scripts/serve.py ;;
  ""|--start|--detach)
    if cg_launchd_managed; then
      # Don't double-spawn under the supervisor: heal repairs drift, else no-op.
      cg_serve_heal || true
      echo "launchd supervises this server — ensured up via $CG_SERVE_LABEL."
      exit 0
    fi
    start ;;
  *) echo "usage: $0 [--start|--stop|--restart|--foreground]" >&2; exit 2 ;;
esac
