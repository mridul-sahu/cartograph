#!/usr/bin/env bash
# scripts/post-edit-topic-mark.sh — PostToolUse:Edit|Write|NotebookEdit.
#
# When the agent edits a workspace file, find every TOPIC note that
# cites it and write a "this topic needs revision" entry to
# .cartograph/state/topic-revisions-pending.json.
#
# The /api/queue endpoint surfaces these as a 4th queue kind alongside
# bless / anchor / drift, and the orientation injection flags them for
# the active session to re-validate the cited claim: read the diff
# between last_revised and now, decide whether the topic still holds,
# revise or bump-only.
#
# This closes the §4 (revision discipline) feedback loop: today a topic
# can drift silently when its cited file is edited mid-session and the
# agent doesn't think to bump it. Now that drift becomes a queue item
# the next session sees.
#
# Hook contract:
#   stdin  — JSON payload (tool_input.file_path)
#   stdout — silent (we don't need to emit context here; the queue card
#            is where this surfaces)
#   exit 0 — always.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
INDEX="$CARTOGRAPH_ROOT/.cartograph/index/by-file.json"
STATE_DIR="$CARTOGRAPH_ROOT/.cartograph/state"
STATE="$STATE_DIR/topic-revisions-pending.json"
WORKSPACE_REAL="$(cd "$CARTOGRAPH_ROOT/workspace" 2>/dev/null && pwd -P || echo "")"

mkdir -p "$STATE_DIR"

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

# Only fire for workspace edits. Cartograph's own files (notes, scripts,
# UI, etc.) shouldn't trigger topic-revision flags.
if [[ -n "$WORKSPACE_REAL" ]]; then
  case "$path" in
    "$WORKSPACE_REAL"/*) : ;;
    */workspace/*) : ;;
    *) exit 0 ;;
  esac
fi

[[ -f "$INDEX" ]] || exit 0

# Resolve current session slug if available so the queue item can link
# back to the edit context.
session_slug=""
if [[ -f "$CARTOGRAPH_ROOT/sessions/.current-session" ]]; then
  session_path="$(cat "$CARTOGRAPH_ROOT/sessions/.current-session" 2>/dev/null || true)"
  if [[ -n "$session_path" ]]; then
    session_slug="$(basename "$session_path" .md)"
  fi
fi

basename="$(basename "$path")"

python3 - "$INDEX" "$STATE" "$path" "$basename" "$session_slug" "$CARTOGRAPH_ROOT" <<'PY'
import json
import sys
import time
from pathlib import Path

idx_path = Path(sys.argv[1])
state_path = Path(sys.argv[2])
full_path = sys.argv[3]
basename = sys.argv[4]
session = sys.argv[5]
root = Path(sys.argv[6])

try:
    idx = json.loads(idx_path.read_text(encoding="utf-8"))
except Exception:
    sys.exit(0)

by_file = idx.get("by_file", {})

# Bidirectional + basename match — same logic as pre-read-augment.
citing_topics: list[tuple[str, str]] = []  # (citing topic note, cited file path)
seen = set()
for fp, entries in by_file.items():
    if fp in seen:
        continue
    fp_base = fp.rsplit("/", 1)[-1]
    if not (full_path in fp or fp in full_path or (basename and fp_base == basename)):
        continue
    seen.add(fp)
    for e in entries:
        if (e.get("layer") or "") != "topic":
            continue
        note = e.get("note") or ""
        if note:
            citing_topics.append((note, fp))

if not citing_topics:
    sys.exit(0)

# Workspace-relative form of the edited file for the queue entry. We
# strip CARTOGRAPH_ROOT/workspace/ if present, else fall back to the
# basename — readable on the queue surface either way.
ws = root / "workspace"
try:
    rel = str(Path(full_path).resolve().relative_to(ws.resolve()))
except (ValueError, OSError):
    rel = basename

# Load existing state. Merge into a dict keyed by topic path so
# multiple edits to the same cited file in the same session don't
# create duplicate entries — we just refresh the timestamp + bump the
# edit count.
state: dict[str, dict] = {}
if state_path.is_file():
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        state = {}

now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
for topic, cited_fp in citing_topics:
    entry = state.get(topic) or {
        "cited_files": [],
        "first_edited_at": now,
        "edits_in_session": 0,
        "session": session or None,
    }
    if rel not in entry["cited_files"]:
        entry["cited_files"].append(rel)
    entry["last_edited_at"] = now
    entry["edits_in_session"] = int(entry.get("edits_in_session") or 0) + 1
    # If the session changed, reset the counter. The marker is meant
    # to read as "this many edits since you last revised."
    if session and entry.get("session") != session:
        entry["session"] = session
        entry["edits_in_session"] = 1
        entry["first_edited_at"] = now
    state[topic] = entry

# Atomic write.
tmp = state_path.with_suffix(state_path.suffix + ".tmp")
tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
tmp.replace(state_path)
PY

exit 0
