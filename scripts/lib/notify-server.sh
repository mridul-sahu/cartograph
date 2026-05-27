#!/usr/bin/env bash
# scripts/lib/notify-server.sh — source from other bash scripts.
#
# Helpers for talking to the local FastAPI server on :47777 that degrade
# gracefully (with an observable one-line message) when the server is down.
#
# Usage:
#   source "$(dirname "$0")/lib/notify-server.sh"
#   server_post /api/rebuild               # silent on success; warns on fail
#   server_get  /api/queue                 # echoes body on success; warns on fail
#
# The "warns on fail" is the point — without this, scripts that quietly
# fail when the server is down leave the user wondering why their UI
# isn't reflecting the new content.

CARTOGRAPH_SERVER_URL="${CARTOGRAPH_SERVER_URL:-http://127.0.0.1:47777}"

_server_reachable() {
  curl -sf -o /dev/null --connect-timeout 1 --max-time 2 "$CARTOGRAPH_SERVER_URL/api/healthz" 2>/dev/null
}

server_post() {  # $1 = path, $2... = additional curl args (e.g., -d '{...}')
  local path="$1"; shift
  if curl -fsS -X POST --connect-timeout 1 --max-time 5 "$@" "$CARTOGRAPH_SERVER_URL$path" >/dev/null 2>&1; then
    return 0
  fi
  if ! _server_reachable; then
    printf "  (skipped POST %s — server not running at %s; start with 'just serve')\n" \
      "$path" "$CARTOGRAPH_SERVER_URL" >&2
  else
    printf "  (POST %s failed — server up but request errored)\n" "$path" >&2
  fi
  return 1
}

server_get() {  # $1 = path
  local path="$1"
  if curl -fsS --connect-timeout 1 --max-time 5 "$CARTOGRAPH_SERVER_URL$path" 2>/dev/null; then
    return 0
  fi
  if ! _server_reachable; then
    printf "  (skipped GET %s — server not running at %s; start with 'just serve')\n" \
      "$path" "$CARTOGRAPH_SERVER_URL" >&2
  else
    printf "  (GET %s failed — server up but request errored)\n" "$path" >&2
  fi
  return 1
}
