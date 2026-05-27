#!/usr/bin/env bash
# scripts/checkpoint.sh — backing for /checkpoint (the /loop-fired
# mid-session publish prompt).
#
# Read-only audit of the current session. Prints a structured snapshot
# the agent then introspects against — was anything learned in this
# interval that should become an episode?
#
# The slash command (.claude/commands/checkpoint.md) wraps this output
# with the decision prompt: "if learned → /episode <slug>; if not → say
# why and continue".
#
# Designed to be called by `/loop 20m /checkpoint`. Each fire shows what
# changed since the last fire so the agent isn't re-evaluating the
# entire session each time.

set -uo pipefail

source "$(dirname "$0")/lib/load-config.sh"

SESSIONS_DIR="$CARTOGRAPH_ROOT/sessions"
log="$(cat "$SESSIONS_DIR/.current-session" 2>/dev/null || echo "")"
if [[ -z "$log" || ! -f "$log" ]]; then
  log="$(find "$SESSIONS_DIR" -name '*.md' -type f -mtime -1 2>/dev/null | sort | tail -1)"
fi
if [[ -z "$log" || ! -f "$log" ]]; then
  echo "[checkpoint] no session log — nothing to checkpoint (skipping)."
  exit 0
fi

# Where the last checkpoint left off — written below at the end of this
# script. State file is per-session, keyed by the session log's basename.
state_dir="$CARTOGRAPH_ROOT/.cartograph/state/checkpoints"
state_file="$state_dir/$(basename "$log" .md).last"
mkdir -p "$state_dir"

last_offset=0
last_ts="(session start)"
if [[ -f "$state_file" ]]; then
  last_offset="$(awk -F= '/^offset=/{print $2}' "$state_file" 2>/dev/null || echo 0)"
  last_ts="$(awk -F= '/^ts=/{print $2}' "$state_file" 2>/dev/null || echo "(session start)")"
fi

now_offset="$(wc -l < "$log" | tr -d ' ')"

# Activity since last fire.
since_tail="$(tail -n "+$((last_offset + 1))" "$log" 2>/dev/null || tail -n +1 "$log")"
since_edits="$(echo "$since_tail" | grep -cE '^- [0-9:]+  (Edit|Write|NotebookEdit)  ' || true)"
since_reads="$(echo "$since_tail" | grep -cE '^- [0-9:]+  Read  ' || true)"
since_bash="$(echo "$since_tail" | grep -cE '^- [0-9:]+  Bash  ' || true)"

# Episodes / topic notes / research notes written this session.
all_tail="$(tail -n +2 "$log")"
ep_written="$(echo "$all_tail" | grep -cE '^- [0-9:]+  (Edit|Write)  .*/episodes/' || true)"
topic_written="$(echo "$all_tail" | grep -cE '^- [0-9:]+  (Edit|Write)  .*/topics/' || true)"
research_written="$(echo "$all_tail" | grep -cE '^- [0-9:]+  (Edit|Write)  .*/research/' || true)"
total_edits="$(echo "$all_tail" | grep -cE '^- [0-9:]+  (Edit|Write|NotebookEdit)  ' || true)"

# A list of distinct workspace files touched since last checkpoint.
since_workspace_files="$(echo "$since_tail" \
  | grep -E '^- [0-9:]+  (Edit|Write|Read)  .*workspace/' \
  | sed -E 's|^- [0-9:]+  [A-Za-z]+  ||' \
  | awk -F'workspace/' '{print "workspace/" $2}' \
  | sort -u | head -10)"

now_ts="$(date -u +%H:%M:%SZ)"

# ── Output ───────────────────────────────────────────────────────────────

cat <<EOF
[checkpoint] interval audit — last fire: $last_ts, now: $now_ts

session totals:
  edits  total  $total_edits
  episodes written  $ep_written
  topics edited     $topic_written
  research written  $research_written

since last checkpoint:
  edits   $since_edits
  reads   $since_reads
  bash    $since_bash
EOF

if [[ -n "$since_workspace_files" ]]; then
  echo
  echo "workspace files touched since last checkpoint:"
  echo "$since_workspace_files" | sed 's/^/  /'
fi

# Decision input — the slash command's prompt body uses this to drive
# the agent's introspection.
echo
echo "decision:"
if (( since_edits == 0 && since_reads == 0 && since_bash == 0 )); then
  echo "  no activity since last fire → SKIP (no introspection needed)"
elif (( since_edits == 0 )); then
  echo "  $since_reads reads, $since_bash bash, 0 edits since last fire"
  echo "  → if you LEARNED something (gotcha, surprise, bedrock contradiction), write it"
  echo "  → else SKIP"
else
  echo "  $since_edits workspace edits since last checkpoint"
  echo "  → review the files above. Did any expose a non-obvious insight worth keeping?"
  echo "     • Yes → /episode <slug> NOW (the session has the context; a later session won't)"
  echo "     • No  → SKIP and continue (\"made the mechanical change X, nothing durable\")"
fi

# Persist for the next fire.
cat > "$state_file" <<EOF
offset=$now_offset
ts=$now_ts
EOF

exit 0
