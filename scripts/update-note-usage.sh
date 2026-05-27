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

# Extract `path/to/file:NNN` style citations from each injected note (cheap:
# grep the citation pattern, take just the path). Compare against Reads.
used_count=0
while IFS= read -r note_rel; do
  [[ -z "$note_rel" ]] && continue
  note_abs="$CARTOGRAPH_ROOT/$note_rel"
  [[ -f "$note_abs" ]] || continue
  # Pull citation paths from the note (anchored `<word>/<path>:line` shape).
  citations="$(grep -oE '\b[a-zA-Z0-9_./-]+\.(py|go|ts|tsx|js|jsx|rs|c|cc|cpp|h|hpp|java|kt|swift|md|sh|astro|css|html|json|yaml|toml):[0-9]+' "$note_abs" 2>/dev/null \
    | sed -E 's/:[0-9]+$//' \
    | sort -u)"
  [[ -z "$citations" ]] && continue
  # If any citation path appears in any Read path, this note got "used".
  matched=0
  while IFS= read -r cit; do
    [[ -z "$cit" ]] && continue
    if printf '%s\n' "$reads" | grep -qF "$cit"; then
      matched=1
      break
    fi
  done <<<"$citations"
  if (( matched == 1 )); then
    note_usage_bump_used "$note_rel" >/dev/null 2>&1 || true
    used_count=$((used_count + 1))
  fi
done <<<"$injected_notes"

n_injected="$(printf '%s\n' "$injected_notes" | grep -c . || true)"
printf '[note-usage] %d notes injected · %d had a cited file Read\n' \
  "$n_injected" "$used_count" >&2

exit 0
