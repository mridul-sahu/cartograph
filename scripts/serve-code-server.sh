#!/usr/bin/env bash
# scripts/serve-code-server.sh — run code-server pointing at workspace/.
#
# code-server is open-source VS Code that runs in the browser. We embed
# it as an iframe on /browse/<repo>/ so users get real syntax highlighting,
# go-to-definition (when an LSP extension is installed), file tree, etc.
#
# Default: localhost:47780, no auth (LOCAL-ONLY), user-data-dir kept inside
# the cartograph repo so extensions persist with the project.
#
# Usage:
#   scripts/serve-code-server.sh                # run
#   scripts/serve-code-server.sh --foreground   # don't background
#   scripts/serve-code-server.sh --stop         # kill any running instance
#
# Install: `brew install code-server`

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
PORT="${CARTOGRAPH_CODE_SERVER_PORT:-47780}"
USER_DATA="$CARTOGRAPH_ROOT/.code-server-data"

case "${1:-}" in
  --stop)
    # Match only the LISTEN process — Chrome may hold stale CLOSED entries
    # for the same port which lsof would also report; we don't want to kill
    # the browser.
    pids=$(lsof -ti:$PORT -sTCP:LISTEN 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      # pids can be newline-separated; xargs splits them correctly.
      echo "$pids" | xargs kill -9
      echo "code-server stopped (pids: $(echo "$pids" | tr '\n' ' '))."
    else
      echo "no code-server LISTEN on :$PORT."
    fi
    exit 0
    ;;
esac

# Locate code-server binary.
CODE_SERVER_BIN="$(command -v code-server 2>/dev/null || true)"
if [[ -z "$CODE_SERVER_BIN" ]]; then
  for candidate in \
    /usr/local/opt/code-server/bin/code-server \
    /opt/homebrew/opt/code-server/bin/code-server \
    "$HOME/.local/bin/code-server"
  do
    if [[ -x "$candidate" ]]; then
      CODE_SERVER_BIN="$candidate"
      break
    fi
  done
fi
if [[ -z "$CODE_SERVER_BIN" ]]; then
  echo "code-server not found." >&2
  echo "install with: brew install code-server" >&2
  exit 1
fi

mkdir -p "$USER_DATA"

# Check if already LISTENING (filter out stale CLOSED connections from the
# browser holding pages from a previous run).
existing=$(lsof -ti:$PORT -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$existing" ]]; then
  echo "code-server already running on :$PORT (pid $(echo $existing | tr '\n' ' '))."
  exit 0
fi

CMD=(
  "$CODE_SERVER_BIN"
  --bind-addr "127.0.0.1:$PORT"
  --auth none
  --disable-telemetry
  # Without this, code-server opens every fork in "Restricted Mode" behind
  # a "do you trust the authors?" dialog — and extensions DO NOT RUN in
  # restricted mode, so the Cartograph extension stays dormant until the
  # dialog is dismissed. The embedded IDE is always our own local forks;
  # the trust gate is pure friction here.
  --disable-workspace-trust
  --user-data-dir "$USER_DATA"
  "$CARTOGRAPH_ROOT/workspace"
)

if [[ "${1:-}" == "--foreground" ]]; then
  exec "${CMD[@]}"
fi

LOG="${TMPDIR:-/tmp}/cartograph-code-server.log"
nohup "${CMD[@]}" > "$LOG" 2>&1 &
pid=$!
disown "$pid" 2>/dev/null || true
echo "code-server started — pid $pid, log $LOG"
echo "open: http://localhost:$PORT/?folder=$CARTOGRAPH_ROOT/workspace/jax"
