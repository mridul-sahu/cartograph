#!/usr/bin/env bash
# scripts/pre-read-augment.sh — PreToolUse:Read hook.
#
# When the agent is about to Read a file inside workspace/<repo>/, look up
# the file in .cartograph/index/by-file.json and surface every Cartograph
# note that cites it. The hook output appears as context attached to the
# Read tool call, so the agent sees orientation BEFORE consuming the file
# itself.
#
# This is the single biggest forcing function for chassis utilization:
# turns the orientation question ("what do we know about this file?")
# from an agent decision into a chassis default.
#
# Design: claude-designs/cartograph/agent-utilization/README.md
#
# Hook contract:
#   stdin  — JSON payload from Claude Code (tool_input.file_path is what we want)
#   stdout — text to inject; printed lines become context for the agent
#   stderr — silent unless there's a real error
#   exit 0 — always; never block a Read.

set -uo pipefail

# Same kill switch as inject-context.sh — the eval harness's off arm must
# disable EVERY injection surface, not just UserPromptSubmit.
[[ "${CARTOGRAPH_INJECT_DISABLE:-0}" == "1" ]] && exit 0

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
INDEX="$CARTOGRAPH_ROOT/.cartograph/index/by-file.json"
WORKSPACE_REAL="$(cd "$CARTOGRAPH_ROOT/workspace" 2>/dev/null && pwd -P || echo "")"

# Parse the tool input. jq optional — fall back to a small Python one-liner
# if jq is missing (PyYAML+json are already required by other scripts).
payload="$(cat 2>/dev/null || true)"
[[ -z "$payload" ]] && exit 0

path=""
if command -v jq >/dev/null 2>&1; then
  path="$(echo "$payload" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)"
else
  path="$(python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    ti = data.get('tool_input', {})
    print(ti.get('file_path') or ti.get('path') or '')
except Exception:
    pass
" <<<"$payload" 2>/dev/null)"
fi

[[ -z "$path" ]] && exit 0

# Only augment for workspace reads — Cartograph's own files are uninteresting
# and the noise floor would suppress the signal.
if [[ -n "$WORKSPACE_REAL" ]]; then
  case "$path" in
    "$WORKSPACE_REAL"/*) : ;;
    */workspace/*) : ;;  # also fire on relative paths
    *) exit 0 ;;
  esac
fi

[[ -f "$INDEX" ]] || exit 0

# Strip everything up to the workspace prefix so the basename match works
# against the indexed paths (which are upstream-relative, not absolute).
basename="$(basename "$path")"

# Python lookup — JSON parsing + substring match. Small, no jq dep.
python3 - "$INDEX" "$path" "$basename" <<'PY'
import json
import sys
from pathlib import Path

idx_path = sys.argv[1]
full_path = sys.argv[2]
basename = sys.argv[3]

try:
    idx = json.loads(Path(idx_path).read_text(encoding="utf-8"))
except Exception:
    sys.exit(0)

by_file = idx.get("by_file", {})

# Bidirectional match — see scripts/build-file-index.py:lookup_paths.
# Any of: needle in indexed_path, indexed_path in needle, or basename match.
hits = []
seen = set()
for fp, entries in by_file.items():
    if fp in seen:
        continue
    fp_base = fp.rsplit("/", 1)[-1]
    if full_path in fp or fp in full_path or (basename and fp_base == basename):
        seen.add(fp)
        hits.append((fp, entries))

if not hits:
    sys.exit(0)

# Dedupe by indexed path, prefer most-specific matches first.
seen = set()
unique = []
for fp, entries in hits:
    if fp in seen:
        continue
    seen.add(fp)
    unique.append((fp, entries))

# Cap output — the agent doesn't need 20 hits, just the top few across layers.
LAYER_ORDER = {"bedrock": 0, "topic": 1, "episode": 2, "research": 3, "paper": 4, "design": 5, "learn": 6}

print("<cartograph-pre-read>")
print(f"Cartograph already documents {basename!r}. Read these BEFORE the file:")
print()
for fp, entries in unique[:3]:
    print(f"▸ {fp}")
    entries_sorted = sorted(entries, key=lambda e: LAYER_ORDER.get(e.get("layer") or "", 99))
    for e in entries_sorted[:5]:
        layer = (e.get("layer") or "?")[:7]
        anchors = e.get("anchors") or []
        anchor_str = ":" + ",".join(str(a) for a in anchors) if anchors else ""
        print(f"    [{layer:7}] {e['note']}{anchor_str}")
    print()

print("If any of the above contradicts the code you're about to read, revise it in place (CLAUDE.md §4).")
print("</cartograph-pre-read>")
PY

exit 0
