#!/usr/bin/env bash
# Detached relauncher for the cartograph server (scripts/serve.py).
#
# Invoked by `POST /api/server/restart`, which spawns this in a NEW SESSION
# (setsid) so it outlives the very process it is about to kill. It frees the
# listen port, then re-execs the server with the interpreter passed as $1.
#
# Kills by PORT, not PID: uvicorn's reload mode runs a reloader + a worker that
# both hold the listening socket, so `lsof -ti tcp:PORT` is the robust way to
# tear the whole tree down. Port 47777 is cartograph-specific, so this never
# touches unrelated processes.
#
# CAVEAT: this inherits the spawning process's network context. If the server
# is trapped in a network-restricted sandbox, the relaunched process is too —
# a restart cannot escape a sandbox. Restart from a real terminal in that case.
set -uo pipefail

PY="${1:-${CARTOGRAPH_PYTHON:-python3}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CARTOGRAPH_PORT:-47777}"

# Let the HTTP response flush before we touch the listener handling it.
sleep 1

# When launchd supervises the server, restart THROUGH launchd — never spawn a
# detached serve.py here, which would become an orphan that holds the port and
# locks launchd out (Errno 48 → KeepAlive backoff → supervision drift). Only
# fall through to the manual relaunch below when the agent isn't installed.
# shellcheck source=lib/serve-control.sh
source "$ROOT/scripts/lib/serve-control.sh"
if cg_launchd_managed; then
  echo "[restart-server] $(date -u +%FT%TZ) launchd-managed — kickstarting $CG_SERVE_LABEL" >&2
  cg_serve_restart
  exit 0
fi

listeners() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -ti "tcp:${PORT}" 2>/dev/null || true
}

pids="$(listeners)"
if [[ -n "${pids}" ]]; then
  # shellcheck disable=SC2086
  kill ${pids} 2>/dev/null || true
fi

# Wait up to ~10s for a graceful exit; force-kill stragglers.
for _ in $(seq 1 20); do
  [[ -z "$(listeners)" ]] && break
  sleep 0.5
done
pids="$(listeners)"
if [[ -n "${pids}" ]]; then
  # shellcheck disable=SC2086
  kill -9 ${pids} 2>/dev/null || true
  sleep 1
fi

cd "${ROOT}"
echo "[restart-server] $(date -u +%FT%TZ) relaunching via ${PY}" >&2
exec "${PY}" scripts/serve.py
