#!/usr/bin/env bash
# scripts/lib/headless.sh — the single chokepoint for spawning headless
# `claude -p` agents. Every spawn in cartograph routes through here.
#
# Why this exists: autonomous curation used to spawn one `claude -p` agent
# *per item* from SessionStart/Stop hooks. Each agent cd's into
# CARTOGRAPH_ROOT, so it is itself a cartograph session and re-fires the same
# hooks → spawns more agents. A per-firing cap (max 2) is powerless against
# that recursion; it breadth-walked every topic into a 50+ agent swarm. This
# layer closes three holes at once:
#   (1) cg_autospawn_guard — a hook called from inside a headless agent exits
#       immediately, so the cascade can never start.
#   (2) cg_headless_run — total concurrent agents never exceeds
#       CARTOGRAPH_HEADLESS_MAX (default 1), enforced by a PID registry.
#   (3) one kill switch (CARTOGRAPH_HEADLESS_DISABLE) and one binary resolver.
#
# Source it from a script:
#   source "$(dirname "$0")/lib/headless.sh"

if [[ -z "${CARTOGRAPH_ROOT:-}" ]]; then
  # This lib lives at scripts/lib/headless.sh — root is two levels up.
  CARTOGRAPH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

CG_HEADLESS_MAX="${CARTOGRAPH_HEADLESS_MAX:-1}"
CG_HEADLESS_REGISTRY="$CARTOGRAPH_ROOT/.cartograph/headless"

# True when we are already running inside a spawned headless agent. The
# CARTOGRAPH_HEADLESS=1 marker is set on the child env by cg_headless_run and
# inherited by everything the agent runs — including the hooks it fires.
cg_in_headless() { [[ "${CARTOGRAPH_HEADLESS:-0}" == "1" ]]; }

# True when the hard kill switch is set — no autonomous spawn happens at all.
cg_headless_disabled() { [[ "${CARTOGRAPH_HEADLESS_DISABLE:-0}" == "1" ]]; }

# cg_autospawn_guard — call at the TOP of any autonomous (hook-driven) script.
# Exits 0 (so the hook is a clean no-op) when we are inside a headless agent or
# the kill switch is on. This is the recursion-breaker: a spawned agent's
# SessionStart/Stop hooks find the marker and refuse to fan out.
cg_autospawn_guard() {
  if cg_in_headless || cg_headless_disabled; then
    exit 0
  fi
  return 0   # must not return the false test status — callers run under `set -e`
}

# cg_resolve_claude_bin — the single place that locates the claude CLI.
# Prints the path on stdout; returns 1 if not found.
cg_resolve_claude_bin() {
  local bin c
  bin="$(command -v claude 2>/dev/null || true)"
  if [[ -z "$bin" ]]; then
    for c in "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/claude" \
             /usr/local/bin/claude /opt/homebrew/bin/claude; do
      if [[ -x "$c" ]]; then bin="$c"; break; fi
    done
  fi
  [[ -n "$bin" ]] || return 1
  printf '%s\n' "$bin"
}

# cg_headless_count — number of live registered agents (reaps dead entries).
# Safe to call without the lock for a read-only estimate.
cg_headless_count() {
  local f pid live=0
  [[ -d "$CG_HEADLESS_REGISTRY" ]] || { printf '0\n'; return 0; }
  for f in "$CG_HEADLESS_REGISTRY"/*.pid; do
    [[ -e "$f" ]] || continue
    pid="$(basename "$f" .pid)"
    if kill -0 "$pid" 2>/dev/null; then
      live=$((live + 1))
    else
      rm -f "$f"
    fi
  done
  printf '%s\n' "$live"
}

# cg_headless_run <label> [--] <claude args...> [< prompt-file]
# The ONLY way to exec a headless claude agent. Enforces the cap, sets the
# recursion marker, runs from CARTOGRAPH_ROOT, and cleans up its registry
# entry on exit. stdin is passed through to claude (leaf scripts feed the
# prompt via redirection). Returns claude's exit code, or:
#   75 — deferred (cap reached), 77 — refused (nested/disabled), 78 — no CLI.
cg_headless_run() {
  local label="$1"; shift
  [[ "${1:-}" == "--" ]] && shift

  if cg_in_headless; then
    echo "[headless] refusing nested spawn ('$label') — already inside an agent" >&2
    return 77
  fi
  if cg_headless_disabled; then
    echo "[headless] refusing spawn ('$label') — CARTOGRAPH_HEADLESS_DISABLE=1" >&2
    return 77
  fi

  local bin
  bin="$(cg_resolve_claude_bin)" || { echo "[headless] claude CLI not found" >&2; return 78; }

  mkdir -p "$CG_HEADLESS_REGISTRY"
  local lock="$CG_HEADLESS_REGISTRY/.lock" i acquired=0
  for ((i = 0; i < 50; i++)); do
    if mkdir "$lock" 2>/dev/null; then acquired=1; break; fi
    # Break a stale lock left by a crashed run (older than 15s).
    if [[ -d "$lock" ]]; then
      local age
      age=$(( $(date +%s) - $(stat -f %m "$lock" 2>/dev/null || echo 0) ))
      if (( age > 15 )); then rmdir "$lock" 2>/dev/null || true; fi
    fi
    sleep 0.1
  done

  # CARTOGRAPH_HEADLESS_FORCE=1 bypasses the cap for a synchronous, user-blocking
  # request (e.g. an interactive question) — it still sets the recursion marker
  # and registers, it just isn't held back by the autonomous-spawn cap.
  local live
  live="$(cg_headless_count)"
  if [[ "${CARTOGRAPH_HEADLESS_FORCE:-0}" != "1" ]] && (( live >= CG_HEADLESS_MAX )); then
    [[ "$acquired" == 1 ]] && rmdir "$lock" 2>/dev/null || true
    echo "[headless] deferred ('$label') — $live/$CG_HEADLESS_MAX agents already running" >&2
    return 75
  fi

  local me="$$"
  printf '%s\n' "$label" > "$CG_HEADLESS_REGISTRY/$me.pid"
  [[ "$acquired" == 1 ]] && rmdir "$lock" 2>/dev/null || true

  local rc=0
  ( cd "$CARTOGRAPH_ROOT" && exec env CARTOGRAPH_HEADLESS=1 "$bin" "$@" ) || rc=$?
  rm -f "$CG_HEADLESS_REGISTRY/$me.pid"
  return "$rc"
}
