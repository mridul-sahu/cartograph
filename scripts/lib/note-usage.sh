#!/usr/bin/env bash
# scripts/lib/note-usage.sh — read/update per-note injection + usage counters.
#
# State file: .cartograph/state/note-usage.json
#   {
#     "version": 1,
#     "notes": {
#       "<note-path-relative-to-cartograph-root>": {
#         "injected_count": N,
#         "used_count":     M,
#         "last_injected":  "YYYY-MM-DD",
#         "last_used":      "YYYY-MM-DD"
#       }
#     }
#   }
#
# Usage (sourced from other bash scripts):
#   source "$(dirname "$0")/lib/note-usage.sh"
#   note_usage_get_used <path>      # echoes used_count (0 if absent)
#   note_usage_score_boost <path>   # echoes additive boost for ranking
#   note_usage_bump_injected <path> # increments injected_count, updates last_injected
#   note_usage_bump_used <path>     # increments used_count, updates last_used
#
# All operations atomic via a single Python helper — bash JSON would be brittle.

NOTE_USAGE_FILE="${NOTE_USAGE_FILE:-$CARTOGRAPH_ROOT/.cartograph/state/note-usage.json}"

note_usage_get_used() {  # $1 = path relative to cartograph root
  python3 - "$NOTE_USAGE_FILE" "$1" <<'PY' 2>/dev/null
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
if not p.is_file():
    print(0); sys.exit(0)
data = json.loads(p.read_text())
entry = data.get("notes", {}).get(sys.argv[2], {})
print(entry.get("used_count", 0))
PY
}

# Additive ranking boost: 0 for unused/unknown notes, +1 if used at least
# once, +2 if used 6+ times. Bounded so keyword relevance still dominates.
note_usage_score_boost() {  # $1 = path
  local used; used="$(note_usage_get_used "$1")"
  if   (( used >= 6 )); then echo 2
  elif (( used >= 1 )); then echo 1
  else echo 0
  fi
}

_note_usage_bump() {  # $1 = path, $2 = field (injected_count|used_count), $3 = ts-field
  local path="$1" field="$2" ts_field="$3"
  mkdir -p "$(dirname "$NOTE_USAGE_FILE")"
  python3 - "$NOTE_USAGE_FILE" "$path" "$field" "$ts_field" <<'PY' 2>/dev/null
import json, sys, pathlib, datetime
p = pathlib.Path(sys.argv[1])
note, field, ts_field = sys.argv[2], sys.argv[3], sys.argv[4]
data = {"version": 1, "notes": {}}
if p.is_file():
    try: data = json.loads(p.read_text())
    except Exception: pass
data.setdefault("notes", {}).setdefault(note, {"injected_count": 0, "used_count": 0})
data["notes"][note][field] = data["notes"][note].get(field, 0) + 1
data["notes"][note][ts_field] = datetime.date.today().isoformat()
p.write_text(json.dumps(data, indent=2, sort_keys=True))
PY
}

note_usage_bump_injected() { _note_usage_bump "$1" injected_count last_injected; }
note_usage_bump_used()     { _note_usage_bump "$1" used_count     last_used; }
