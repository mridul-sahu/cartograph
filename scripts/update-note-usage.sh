#!/usr/bin/env bash
# scripts/update-note-usage.sh — Stop hook: feed the injection-feedback loop.
#
# At Stop, scan the current session log for:
#   1. Notes injected this session (logged by inject-context.sh as
#      `<!-- injected: <relpath> -->` lines)
#   2. Files Read'd this session (logged by session-log.sh as
#      `- HH:MM:SS  Read  <abspath>` lines)
#
# For each injected note, check if any file path it cites appears in the
# session's Reads. If yes, bump that note's used_count via
# scripts/lib/note-usage.sh — the boost gets applied in future
# orientation rankings (inject-context.sh).
#
# Observational; never blocks the session.
#
# Design: complements usage-audit.sh — that audits chassis utilization
# overall; this attributes utilization back to specific injected notes.

set -uo pipefail

source "$(dirname "$0")/lib/load-config.sh"
source "$(dirname "$0")/lib/note-usage.sh"

SESSIONS_DIR="$CARTOGRAPH_ROOT/sessions"
log="$(cat "$SESSIONS_DIR/.current-session" 2>/dev/null || echo "")"
if [[ -z "$log" || ! -f "$log" ]]; then
  log="$(find "$SESSIONS_DIR" -name '*.md' -type f -mtime -1 2>/dev/null | sort | tail -1)"
fi
[[ -z "$log" || ! -f "$log" ]] && exit 0

# Pull the injected-notes list from the session log.
injected_notes="$(grep -oE '<!-- injected: [^ ]+ -->' "$log" 2>/dev/null | sed -E 's|<!-- injected: ||; s| -->||' | sort -u)"
[[ -z "$injected_notes" ]] && exit 0

# Pull every Read entry's path from the tool-use log.
reads="$(grep -E '^- [0-9:]+  Read  ' "$log" 2>/dev/null | sed -E 's/^- [0-9:]+  Read  //' | sort -u)"
[[ -z "$reads" ]] && exit 0

# A note counts as "used" if either:
#   a. the note itself was Read this session (menu mode surfaces title +
#      path; following the menu IS the success signal), or
#   b. any file the note cites (`path/to/file:NNN`) was Read this session.
used_count=0
used_notes=""
while IFS= read -r note_rel; do
  [[ -z "$note_rel" ]] && continue
  note_abs="$CARTOGRAPH_ROOT/$note_rel"
  [[ -f "$note_abs" ]] || continue
  matched=0
  if printf '%s\n' "$reads" | grep -qF "$note_rel"; then
    matched=1
  else
    # Pull citation paths from the note (anchored `<word>/<path>:line` shape).
    citations="$(grep -oE '\b[a-zA-Z0-9_./-]+\.(py|go|ts|tsx|js|jsx|rs|c|cc|cpp|h|hpp|java|kt|swift|md|sh|astro|css|html|json|yaml|toml):[0-9]+' "$note_abs" 2>/dev/null \
      | sed -E 's/:[0-9]+$//' \
      | sort -u)"
    while IFS= read -r cit; do
      [[ -z "$cit" ]] && continue
      if printf '%s\n' "$reads" | grep -qF "$cit"; then
        matched=1
        break
      fi
    done <<<"$citations"
  fi
  if (( matched == 1 )); then
    note_usage_bump_used "$note_rel" >/dev/null 2>&1 || true
    used_count=$((used_count + 1))
    used_notes+="$note_rel"$'\n'
  fi
done <<<"$injected_notes"

n_injected="$(printf '%s\n' "$injected_notes" | grep -c . || true)"
printf '[note-usage] %d notes injected · %d used (note or cited file Read)\n' \
  "$n_injected" "$used_count" >&2

# Structured per-session record — the time series behind injection-quality
# analysis (which notes get surfaced but never used, per-session hit rate).
usage_log="$CARTOGRAPH_ROOT/.cartograph/state/usage-log.jsonl"
mkdir -p "$(dirname "$usage_log")"
INJECTED="$injected_notes" USED="$used_notes" SESSION="$log" python3 - "$usage_log" <<'PY' 2>/dev/null || true
import json, os, sys, datetime
rec = {
    "date": datetime.date.today().isoformat(),
    "session": os.path.basename(os.environ.get("SESSION", "")),
    "injected": [l for l in os.environ.get("INJECTED", "").split("\n") if l.strip()],
    "used": [l for l in os.environ.get("USED", "").split("\n") if l.strip()],
}
with open(sys.argv[1], "a") as fh:
    fh.write(json.dumps(rec) + "\n")
PY

exit 0
