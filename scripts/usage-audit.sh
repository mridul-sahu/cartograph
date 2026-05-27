#!/usr/bin/env bash
# scripts/usage-audit.sh — Stop hook: chassis-utilization audit.
#
# Reads the current session log, extracts every Read'd file path, and
# cross-references against .cartograph/index/by-file.json. Emits:
#   - count of Reads inside workspace/
#   - count of those that had indexed notes (pre-read-augment fired)
#   - any UNindexed workspace files (candidates for /episode write-up)
#
# Observational, never blocking. Adds a "## chassis utilization" section
# to the session log so the Stop-time audit is preserved alongside the
# rest of the worknote.
#
# Design: claude-designs/cartograph/agent-utilization/README.md

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
SESSIONS_DIR="$CARTOGRAPH_ROOT/sessions"
INDEX="$CARTOGRAPH_ROOT/.cartograph/index/by-file.json"

log="$(cat "$SESSIONS_DIR/.current-session" 2>/dev/null || echo "")"
# .current-session is consumed by session-log.sh stop, which runs BEFORE us
# in the Stop chain. Fallback: find the most recent session log.
if [[ -z "$log" || ! -f "$log" ]]; then
  log="$(find "$SESSIONS_DIR" -name '*.md' -type f -mtime -1 2>/dev/null | sort | tail -1)"
fi
[[ -z "$log" || ! -f "$log" ]] && exit 0

# Pull every Read entry's path from the tool-use log.
reads="$(grep -E '^- [0-9:]+  Read  ' "$log" 2>/dev/null | sed -E 's/^- [0-9:]+  Read  //' | sort -u)"
read_count="$(printf '%s\n' "$reads" | grep -c . || true)"
[[ "$read_count" -eq 0 ]] && exit 0

# Filter to workspace reads.
workspace_reads=""
if [[ -n "$reads" ]]; then
  workspace_reads="$(printf '%s\n' "$reads" | grep -E "$CARTOGRAPH_ROOT/workspace/|/workspace/" || true)"
fi
workspace_count="$(printf '%s\n' "$workspace_reads" | grep -c . || true)"
[[ "$workspace_count" -eq 0 ]] && exit 0

indexed_count=0
unindexed_paths=""

if [[ -f "$INDEX" ]]; then
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    base="$(basename "$p")"
    if python3 - "$INDEX" "$p" "$base" >/dev/null 2>&1 <<'PY'
import json, sys
idx = json.loads(open(sys.argv[1]).read())
full, base = sys.argv[2], sys.argv[3]
by = idx.get("by_file", {})
for fp in by:
    if fp == full or full.endswith("/" + fp) or fp.endswith(base) or base in fp:
        sys.exit(0)
sys.exit(1)
PY
    then
      indexed_count=$((indexed_count + 1))
    else
      unindexed_paths+="$p"$'\n'
    fi
  done <<<"$workspace_reads"
fi

# Append the audit section to the session log.
{
  echo
  echo "## chassis utilization"
  echo
  echo "- $read_count files Read this session ($workspace_count inside workspace/)"
  echo "- $indexed_count of the workspace reads had Cartograph notes (PreToolUse hook surfaced them)"
  if [[ -n "$unindexed_paths" ]]; then
    local_n="$(printf '%s' "$unindexed_paths" | grep -c . || true)"
    echo "- $local_n unindexed workspace files — candidates for episode write-up if anything was learned:"
    printf '%s' "$unindexed_paths" | head -10 | sed 's/^/    - /'
  fi
} >> "$log"

# Also echo a short summary to stdout — the Stop hook surfaces it briefly
# in the terminal so the user sees the utilization tally.
printf '[chassis-audit] %d Read · %d in workspace · %d indexed\n' \
  "$read_count" "$workspace_count" "$indexed_count" >&2

exit 0
