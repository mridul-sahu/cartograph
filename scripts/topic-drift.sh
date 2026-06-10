#!/usr/bin/env bash
# scripts/topic-drift.sh — per-topic, per-citation drift detection.
#
# For each topic note in <repo>, extracts `path:NNN`-shaped citation
# anchors from the body, then for each cited file checks whether
# upstream has touched it since the topic's `last_revised`. If so, the
# topic is flagged with a per-citation report at
# .drift-reports/topics/<repo>/<slug>.md.
#
# Two stages:
#   A) cheap: `git log -- <file>` since last_revised → file flagged
#   B) line-aware: `git log -L<NNN-15>,<NNN+15>:<file>` → citation flagged
#
# Stage B only runs on files flagged by stage A.
#
# Usage: topic-drift.sh [<repo>]  (default: all forks)
#
# Design: claude-designs/cartograph/per-citation-drift/README.md

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
WORKSPACE="$CARTOGRAPH_ROOT/workspace"
GUIDES="$CARTOGRAPH_ROOT/guides"
OUT_BASE="$CARTOGRAPH_ROOT/.drift-reports/topics"

# shellcheck disable=SC1091
source "$CARTOGRAPH_ROOT/scripts/lib/frontmatter.sh"

mkdir -p "$OUT_BASE"

repos=()
if [[ $# -ge 1 ]]; then
  repos=("$1")
else
  while IFS= read -r -d '' d; do
    [[ -d "$d/.git" ]] && repos+=("$(basename "$d")")
  done < <(find "$WORKSPACE" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
fi

# Extract path:NNN and bare-path citations from a topic note's body.
# Outputs lines: "<path>\t<line_or_empty>".
extract_anchors() {
  local file="$1"
  awk '/^---[[:space:]]*$/{c++; next} c>=2' "$file" 2>/dev/null \
    | grep -oE '[a-zA-Z0-9_./-]+\.(py|pyi|cc|cpp|h|hh|hpp|c|ts|tsx|js|go|rs|bzl)(:[0-9]+)?' \
    | sort -u \
    | awk -F: 'NF==2 { print $1 "\t" $2 } NF==1 { print $1 "\t" }'
}

# For one topic note, compute drift; write the report if drift found.
process_topic() {
  local repo="$1" topic_file="$2"
  local fork_dir="$WORKSPACE/$repo"
  local slug
  slug="$(basename "$topic_file" .md)"
  local report="$OUT_BASE/$repo/$slug.md"
  mkdir -p "$OUT_BASE/$repo"

  local last_revised
  last_revised="$(fm_get "$topic_file" last_revised)"
  if [[ -z "$last_revised" ]]; then
    rm -f "$report"
    return 0
  fi

  local anchors
  anchors="$(extract_anchors "$topic_file")"
  [[ -z "$anchors" ]] && { rm -f "$report"; return 0; }

  local changed_lines=()
  local stable_lines=()
  local file line probe
  while IFS=$'\t' read -r file line; do
    [[ -z "$file" ]] && continue
    # Only check files that exist in the fork.
    if [[ ! -f "$fork_dir/$file" ]]; then
      # File no longer exists upstream — that's a strong drift signal.
      changed_lines+=("$file${line:+:$line}    file deleted/renamed upstream")
      continue
    fi
    # Stage A: did this file change since last_revised?
    probe="$(git -C "$fork_dir" log --oneline --since="$last_revised" -- "$file" 2>/dev/null | head -1)"
    if [[ -z "$probe" ]]; then
      stable_lines+=("$file${line:+:$line}")
      continue
    fi
    # Stage B: did the cited line region change? ±15 lines — wide enough
    # to catch the function body around the anchor, not just the line.
    if [[ -n "$line" ]]; then
      local start_line=$((line - 15))
      (( start_line < 1 )) && start_line=1
      local end_line=$((line + 15))
      local line_probe
      line_probe="$(git -C "$fork_dir" log --since="$last_revised" -L"${start_line},${end_line}:${file}" 2>/dev/null | head -1)"
      if [[ -n "$line_probe" ]]; then
        changed_lines+=("$file:$line    line region touched ($probe)")
      else
        stable_lines+=("$file:$line    (file changed elsewhere; cited region unchanged)")
      fi
    else
      changed_lines+=("$file    file changed ($probe)")
    fi
  done <<<"$anchors"

  if [[ ${#changed_lines[@]} -eq 0 ]]; then
    rm -f "$report"
    return 0
  fi

  {
    echo "# Drift: $repo/topics/$slug.md"
    echo
    echo "Last revised $last_revised. Per-citation drift below."
    echo
    echo "## Citations changed since last_revised (${#changed_lines[@]})"
    echo
    for c in "${changed_lines[@]}"; do
      echo "- \`$c\`"
    done
    echo
    if [[ ${#stable_lines[@]} -gt 0 ]]; then
      echo "## Citations stable since last_revised (${#stable_lines[@]})"
      echo
      for s in "${stable_lines[@]}"; do
        echo "- \`$s\`"
      done
      echo
    fi
    echo "## What to do"
    echo
    echo "Re-read the cited line regions for the changed citations. If the"
    echo "topic note's claims are contradicted, revise per CLAUDE.md §4. When"
    echo "done, bump \`last_revised: <today>\` in the topic's frontmatter."
    echo
    echo "Use \`/revise $slug\` — it reads this report and pre-stages diffs."
  } > "$report"
  echo "[topic-drift] $repo/$slug: ${#changed_lines[@]} citation(s) drifted — $report"
}

for repo in "${repos[@]}"; do
  topics_dir="$GUIDES/$repo/topics"
  [[ -d "$topics_dir" ]] || continue
  if [[ ! -d "$WORKSPACE/$repo/.git" ]]; then
    continue
  fi
  for topic_file in "$topics_dir"/*.md; do
    [[ -f "$topic_file" ]] || continue
    process_topic "$repo" "$topic_file"
  done
done

exit 0
