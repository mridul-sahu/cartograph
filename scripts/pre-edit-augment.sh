#!/usr/bin/env bash
# scripts/pre-edit-augment.sh — PreToolUse:Edit|Write|NotebookEdit hook.
#
# The companion to pre-read-augment.sh. The Read hook catches the case
# where the agent is about to consume a workspace file; this one catches
# the case where the agent SKIPS Read and goes straight to Edit/Write.
#
# That's the structural gap a recent session demonstrated: the agent
# edited workspace/orbax/checkpoint/.../pytree_checkpoint_benchmark.py
# 11 times without ever Reading it (or any of the topic notes citing
# it). The Read-side gate is meaningless if the agent never reads.
#
# This hook:
#   1. Looks up the edit target in .cartograph/index/by-file.json
#   2. If matches exist AND the session log shows the agent hasn't Read
#      any of the citing notes yet, injects a prominent orientation
#      block flagging the §1a violation about to happen
#   3. Never blocks — Claude Code's PreToolUse on Edit shouldn't
#      gatekeep the agent's flow. The signal is the orientation;
#      enforcement is the visibility.
#
# Hook contract:
#   stdin  — JSON payload from Claude Code (tool_input.file_path)
#   stdout — text to inject as context for the edit
#   stderr — silent unless there's a real error
#   exit 0 — always; never block.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
INDEX="$CARTOGRAPH_ROOT/.cartograph/index/by-file.json"
SESSIONS_DIR="$CARTOGRAPH_ROOT/sessions"
WORKSPACE_REAL="$(cd "$CARTOGRAPH_ROOT/workspace" 2>/dev/null && pwd -P || echo "")"

payload="$(cat 2>/dev/null || true)"
[[ -z "$payload" ]] && exit 0

# Extract the target file path. Edit/Write tools use file_path; some
# wrappers use path. Be defensive.
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

# Only augment for workspace edits — cartograph's own files are noise.
if [[ -n "$WORKSPACE_REAL" ]]; then
  case "$path" in
    "$WORKSPACE_REAL"/*) : ;;
    */workspace/*) : ;;
    *) exit 0 ;;
  esac
fi

[[ -f "$INDEX" ]] || exit 0

# The current session log — we'll grep it to see which citing notes
# (if any) the agent has Read this session. session-log.sh maintains
# .current-session pointing to the active log.
session_log=""
if [[ -f "$SESSIONS_DIR/.current-session" ]]; then
  session_log="$(cat "$SESSIONS_DIR/.current-session" 2>/dev/null || true)"
fi
if [[ -z "$session_log" || ! -f "$session_log" ]]; then
  # Fallback: most-recent log in this month.
  month="$(date -u +%Y-%m)"
  session_log="$(ls -t "$SESSIONS_DIR/$month"/*.md 2>/dev/null | head -1 || true)"
fi

basename="$(basename "$path")"

python3 - "$INDEX" "$path" "$basename" "${session_log:-}" <<'PY'
import json
import os
import sys
from pathlib import Path

idx_path = sys.argv[1]
full_path = sys.argv[2]
basename = sys.argv[3]
session_log = sys.argv[4] if len(sys.argv) > 4 else ""

try:
    idx = json.loads(Path(idx_path).read_text(encoding="utf-8"))
except Exception:
    sys.exit(0)

by_file = idx.get("by_file", {})

# Bidirectional + basename match.
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

# Collect the citing-note paths. We'll check whether the agent has
# Read any of them this session.
citing_notes: list[tuple[str, str, list[int]]] = []  # (fp, note, layer)
for fp, entries in hits:
    for e in entries:
        note = e.get("note") or ""
        layer = e.get("layer") or "?"
        if note:
            citing_notes.append((fp, note, layer))

# Check session log for prior Reads of any citing note OR of the file
# itself. The session log writes lines like:
#   - HH:MM:SS  Read  /path/to/file
session_text = ""
if session_log and os.path.exists(session_log):
    try:
        session_text = Path(session_log).read_text(encoding="utf-8", errors="replace")
    except OSError:
        session_text = ""

def read_in_session(note_or_file: str) -> bool:
    if not session_text or not note_or_file:
        return False
    # Match either an absolute path containing the relative note path,
    # or an explicit Read line. Cheap substring is good enough.
    return note_or_file in session_text

# A "complied" edit is one where the agent has already Read either:
#   - the file being edited, or
#   - at least one of the topic notes citing it (bedrock/topic notes
#     are the relevant ones — episodes are too noisy a signal).
file_was_read = read_in_session(full_path) or read_in_session(basename)
critical_notes_read = [
    n for (_, n, layer) in citing_notes
    if layer in ("bedrock", "topic") and read_in_session(n)
]

# Layer ranking for display.
LAYER_ORDER = {"bedrock": 0, "topic": 1, "episode": 2, "research": 3, "paper": 4, "design": 5, "learn": 6}

# Emit ALWAYS when there are citations — the agent should see them
# every time they edit a cited file. But escalate the message when
# discipline was actually skipped.
discipline_gap = not (file_was_read or critical_notes_read)

print("<cartograph-pre-edit>")
if discipline_gap:
    print(f"⚠ CARTOGRAPH §1a + §4 GATE: about to edit {basename!r} without reading any citing note this session.")
    print()
    print("This file is cited by the following note(s). Read at least one BEFORE editing;")
    print("if your edit contradicts a topic note, revise that note in place (§4).")
else:
    print(f"Cartograph: {basename!r} is cited by these note(s). Your edit may require a revision in place (§4).")
print()

# Group entries by their containing note so the agent sees one row per note.
by_note: dict[str, list[tuple[str, str, list[int]]]] = {}
for fp, entries in hits:
    for e in entries:
        note = e.get("note") or ""
        layer = e.get("layer") or "?"
        anchors = e.get("anchors") or []
        if not note:
            continue
        by_note.setdefault(note, []).append((fp, layer, anchors))

ordered_notes = sorted(
    by_note.items(),
    key=lambda kv: (LAYER_ORDER.get(kv[1][0][1], 99), kv[0]),
)
for note, citings in ordered_notes[:6]:
    layer = citings[0][1]
    files = sorted({fp for fp, _, _ in citings})
    anchor_str = ""
    all_anchors = sorted({a for _, _, anchors in citings for a in anchors})
    if all_anchors:
        anchor_str = " · L" + ",".join(str(a) for a in all_anchors[:5])
    marker = " ✓ read this session" if read_in_session(note) else (
        "" if not discipline_gap else "  ← not yet read"
    )
    print(f"▸ [{layer:7}] {note}{anchor_str}{marker}")

print()
if discipline_gap:
    print("→ Stop. Read the topic note above (or the file itself), THEN edit.")
    print("  If the edit changes how the cited code behaves, the topic note must be revised in the same change set.")
print("</cartograph-pre-edit>")
PY

exit 0
