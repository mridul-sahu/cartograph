#!/usr/bin/env bash
# scripts/diary.sh — daily auto-committed digest of what the chassis did.
#
# Reads filesystem + git log; emits one markdown file per calendar day at
# diary/YYYY-MM/YYYY-MM-DD.md. Once-per-day guard via a state file so
# SessionStart hook can run it cheaply on every open.
#
# Modes:
#   diary.sh           — always run, overwrite today's entry
#   diary.sh --if-stale  — only run if today's entry doesn't already exist
#
# Design: claude-designs/cartograph/diary/README.md

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
DIARY_DIR="$CARTOGRAPH_ROOT/diary"
STATE_FILE="$CARTOGRAPH_ROOT/.cartograph/state/diary-last-run"

today="$(date +%Y-%m-%d)"
month="$(date +%Y-%m)"
out="$DIARY_DIR/$month/$today.md"

mode="full"
[[ "${1:-}" == "--if-stale" ]] && mode="if-stale"

if [[ "$mode" == "if-stale" && -f "$STATE_FILE" ]]; then
  last="$(cat "$STATE_FILE" 2>/dev/null || true)"
  if [[ "$last" == "$today" ]]; then
    exit 0
  fi
fi

mkdir -p "$DIARY_DIR/$month" "$(dirname "$STATE_FILE")"

QUERY="python3 $CARTOGRAPH_ROOT/scripts/cartograph_query.py"

count_paths() {
  local out="$1"
  printf '%s\n' "$out" | grep -c . || true
}

# 1. Episodes added today
new_episodes="$($QUERY layer=episode "date=$today" --format paths 2>/dev/null)"
new_ep_count="$(count_paths "$new_episodes")"
# split auto-drafted vs manual
auto_eps="$($QUERY layer=episode "date=$today" auto_drafted=true --format paths 2>/dev/null)"
auto_ep_count="$(count_paths "$auto_eps")"
manual_ep_count=$((new_ep_count - auto_ep_count))

# 2. Topics revised today
new_topics="$($QUERY layer=topic "last_revised=$today" --format paths 2>/dev/null)"
new_topic_count="$(count_paths "$new_topics")"

# 3. Research / paper notes added today
new_research="$($QUERY layer=research "date=$today" --format paths 2>/dev/null)"
new_papers="$($QUERY layer=paper "date=$today" --format paths 2>/dev/null)"

# 4. Drift reports state
open_drift=""
if [[ -d "$CARTOGRAPH_ROOT/.drift-reports" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    open_drift+="${f#$CARTOGRAPH_ROOT/}"$'\n'
  done < <(find "$CARTOGRAPH_ROOT/.drift-reports" -maxdepth 1 -name '*.md' -type f 2>/dev/null)
fi
open_topic_drift=""
if [[ -d "$CARTOGRAPH_ROOT/.drift-reports/topics" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    open_topic_drift+="${f#$CARTOGRAPH_ROOT/}"$'\n'
  done < <(find "$CARTOGRAPH_ROOT/.drift-reports/topics" -name '*.md' -type f 2>/dev/null)
fi
open_topic_drift_count="$(count_paths "$open_topic_drift")"
open_drift_count="$(count_paths "$open_drift")"

# 5. End-of-day review queue (delegated to queue.sh's logic via cartograph_query)
auto_drafted_unreviewed="$($QUERY layer=episode auto_drafted=true '!reviewed_by_human' '!rejected' --format paths 2>/dev/null)"
unblessed_topics="$($QUERY layer=topic '!reviewed_by_human' '!rejected' --format paths 2>/dev/null)"

# 6. Recent auto-commits (only if cartograph itself is a git repo)
auto_commits=""
if [[ -d "$CARTOGRAPH_ROOT/.git" ]]; then
  auto_commits="$(git -C "$CARTOGRAPH_ROOT" log --since='1 day ago' --format='%h %s' \
    --grep='^content(' --grep='^chore(bedrock)' --grep='^content(design)' --all 2>/dev/null || true)"
fi

# Render
{
  cat <<EOF
---
layer: diary
date: $today
---

# Cartograph — $today

EOF

  if (( new_ep_count > 0 )) || [[ -n "$new_topics" ]] || [[ -n "$new_research" ]] || [[ -n "$new_papers" ]]; then
    echo "## What got added"
    echo
    if (( new_ep_count > 0 )); then
      echo "- $new_ep_count new episode(s) ($manual_ep_count manual, $auto_ep_count auto-drafted):"
      while IFS= read -r e; do
        [[ -z "$e" ]] && continue
        echo "    - \`$e\`"
      done <<<"$new_episodes"
    fi
    if [[ -n "$new_topics" ]]; then
      echo "- $new_topic_count topic(s) revised:"
      while IFS= read -r t; do
        [[ -z "$t" ]] && continue
        echo "    - \`$t\`"
      done <<<"$new_topics"
    fi
    if [[ -n "$new_research" ]]; then
      echo "- new research note(s):"
      while IFS= read -r r; do
        [[ -z "$r" ]] && continue
        echo "    - \`$r\`"
      done <<<"$new_research"
    fi
    if [[ -n "$new_papers" ]]; then
      echo "- new paper note(s):"
      while IFS= read -r p; do
        [[ -z "$p" ]] && continue
        echo "    - \`$p\`"
      done <<<"$new_papers"
    fi
    echo
  fi

  if [[ -n "$open_drift" || -n "$open_topic_drift" ]]; then
    echo "## Drift"
    echo
    echo "- $open_drift_count per-repo drift report(s) open"
    echo "- $open_topic_drift_count per-topic drift report(s) open"
    echo
  fi

  echo "## Review queue at end of day"
  echo
  echo "- $(count_paths "$auto_drafted_unreviewed") auto-drafted episode(s) awaiting review"
  echo "- $(count_paths "$unblessed_topics") topic(s) without \`reviewed_by_human:\`"
  echo
  echo "Run \`/queue\` for the full breakdown."
  echo

  if [[ -n "$auto_commits" ]]; then
    echo "## Auto-commits in the last 24h"
    echo
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      echo "- \`$line\`"
    done <<<"$auto_commits"
    echo
  fi

  echo "_Generated by \`scripts/diary.sh\` — see claude-designs/cartograph/diary/._"
} > "$out"

echo "$today" > "$STATE_FILE"
echo "[diary] $out"
