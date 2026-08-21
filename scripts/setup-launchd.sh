#!/usr/bin/env bash
# scripts/setup-launchd.sh — install the cartograph launchd user agents:
#
#   com.cartograph.serve        — serve.py under KeepAlive supervision
#                                         (serve-cartograph.sh --foreground);
#                                         also runs the daily maintenance pass
#   com.cartograph.code-server  — embedded VS Code under KeepAlive supervision
#                                         (serve-code-server.sh --foreground);
#                                         skipped if code-server isn't installed
#
# Templates live in scripts/launchd/*.plist with __CARTOGRAPH_ROOT__ /
# __HOME__ placeholders; this installer substitutes them, copies the result
# to ~/Library/LaunchAgents/, and (re)loads via launchctl. Idempotent: each
# agent is booted out first (tolerating not-loaded), then bootstrapped.
#
# Usage:
#   scripts/setup-launchd.sh             # install + load both agents
#   scripts/setup-launchd.sh --uninstall # bootout + remove both agents

set -uo pipefail

source "$(dirname "$0")/lib/load-config.sh"

TEMPLATE_DIR="$CARTOGRAPH_ROOT/scripts/launchd"
DEST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$CARTOGRAPH_ROOT/.cartograph/logs"
AGENTS=(com.cartograph.serve com.cartograph.code-server)
# Retired labels — boot these out on every run so existing machines
# migrate cleanly (pre-rename 2026-06-10 names, and the standalone
# maintenance timer folded into serve.py on 2026-08-21).
LEGACY_AGENTS=(com.cartograph.serve com.cartograph.maintenance com.cartograph.maintenance)

uid="$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  for name in "${AGENTS[@]}"; do
    launchctl bootout "gui/$uid/$name" 2>/dev/null || true
    rm -f "$DEST_DIR/$name.plist"
    echo "setup-launchd: removed $name"
  done
  exit 0
fi

mkdir -p "$DEST_DIR" "$LOG_DIR"

for name in "${LEGACY_AGENTS[@]}"; do
  if [[ -f "$DEST_DIR/$name.plist" ]]; then
    launchctl bootout "gui/$uid/$name" 2>/dev/null || true
    rm -f "$DEST_DIR/$name.plist"
    echo "setup-launchd: migrated away legacy agent $name"
  fi
done

# Resolve a python that can actually run serve.py. launchd agents get a
# bare PATH with no pyenv shims, so a plain `python3` lands on the system
# interpreter without fastapi and the serve agent crash-loops. Probe:
# explicit override → installer's python3 → every pyenv version.
resolve_python() {
  local candidates=()
  [[ -n "${CARTOGRAPH_PYTHON:-}" ]] && candidates+=("$CARTOGRAPH_PYTHON")
  command -v python3 >/dev/null 2>&1 && candidates+=("$(command -v python3)")
  local p
  for p in "$HOME"/.pyenv/versions/*/bin/python3; do
    [[ -x "$p" ]] && candidates+=("$p")
  done
  for p in "${candidates[@]}"; do
    if "$p" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then
      printf '%s' "$p"
      return 0
    fi
  done
  return 1
}

PYTHON_BIN="$(resolve_python)" || {
  echo "setup-launchd: no python3 with fastapi+uvicorn found." >&2
  echo "  set CARTOGRAPH_PYTHON=/path/to/python3 and re-run." >&2
  exit 1
}
echo "setup-launchd: serve python = $PYTHON_BIN"

# code-server is optional (`brew install code-server`). Probe the same paths
# serve-code-server.sh does; without a binary the agent would just crash-loop
# under KeepAlive, so skip it with a hint instead of failing the install.
have_code_server=0
if command -v code-server >/dev/null 2>&1; then
  have_code_server=1
else
  for candidate in \
    /usr/local/opt/code-server/bin/code-server \
    /opt/homebrew/opt/code-server/bin/code-server \
    "$HOME/.local/bin/code-server"
  do
    [[ -x "$candidate" ]] && { have_code_server=1; break; }
  done
fi
if (( have_code_server == 0 )); then
  echo "setup-launchd: code-server not found — skipping com.cartograph.code-server (brew install code-server, then re-run)"
fi

failed=0
for name in "${AGENTS[@]}"; do
  if [[ "$name" == "com.cartograph.code-server" ]] && (( have_code_server == 0 )); then
    continue
  fi
  tmpl="$TEMPLATE_DIR/$name.plist"
  dest="$DEST_DIR/$name.plist"
  if [[ ! -f "$tmpl" ]]; then
    echo "setup-launchd: template missing: $tmpl" >&2
    failed=1
    continue
  fi
  sed -e "s|__CARTOGRAPH_ROOT__|$CARTOGRAPH_ROOT|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__CARTOGRAPH_PYTHON__|$PYTHON_BIN|g" \
      "$tmpl" > "$dest"
  # Idempotent reload: bootout tolerates "not loaded"; bootstrap then loads
  # the freshly templated plist. Bootstrap can transiently fail while the
  # previous instance is still tearing down — retry briefly.
  launchctl bootout "gui/$uid/$name" 2>/dev/null || true
  loaded=0
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$uid" "$dest" 2>/dev/null; then
      loaded=1
      break
    fi
    sleep 2
  done
  if (( loaded == 1 )); then
    echo "setup-launchd: loaded $name"
  else
    echo "setup-launchd: bootstrap failed for $name — inspect with:" >&2
    echo "  launchctl bootstrap gui/$uid $dest" >&2
    failed=1
  fi
done

if (( failed == 0 )); then
  echo "setup-launchd: done. check status with:"
  echo "  launchctl print gui/$uid/com.cartograph.serve | head -20"
  if (( have_code_server == 1 )); then
    echo "  launchctl print gui/$uid/com.cartograph.code-server | head -20"
  fi
fi
exit "$failed"
