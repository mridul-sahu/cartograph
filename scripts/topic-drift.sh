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

# Resolve a cited path to a repo-relative path in the fork. Notes often
# cite paths relative to a subtree (`fragments.py:164`,
# `orbax/checkpoint/_src/arrays/fragments.py:96`); a citation is only
# "deleted upstream" if no unique suffix match exists in the git index.
# Matches against LS_CACHE (one `git ls-files` listing per repo) instead
# of spawning git per citation — hundreds of citations per repo made the
# per-call form the scan's hotspot.
# Prints the resolved path on success; rc 1 = no match, rc 2 = ambiguous.
LS_CACHE=""
resolve_cited_path() {
  local fork_dir="$1" file="$2"
  if [[ -f "$fork_dir/$file" ]]; then
    printf '%s' "$file"
    return 0
  fi
  [[ -n "$LS_CACHE" && -f "$LS_CACHE" ]] || return 1
  local m hit="" count=0
  while IFS= read -r m; do
    if [[ "$m" == "$file" || "$m" == */"$file" ]]; then
      hit="$m"
      count=$((count + 1))
      (( count > 1 )) && break
    fi
  done < <(grep -F "$(basename "$file")" "$LS_CACHE" 2>/dev/null)
  if (( count == 1 )); then
    printf '%s' "$hit"
    return 0
  elif (( count == 0 )); then
    return 1
  fi
  return 2
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
  local file line probe resolved rrc
  while IFS=$'\t' read -r file line; do
    [[ -z "$file" ]] && continue
    resolved="$(resolve_cited_path "$fork_dir" "$file")"
    rrc=$?
    if (( rrc == 1 )); then
      # No suffix match anywhere in the index — genuinely gone.
      changed_lines+=("$file${line:+:$line}    file deleted/renamed upstream")
      continue
    elif (( rrc == 2 )); then
      # Multiple candidates; the note should cite an unambiguous path.
      changed_lines+=("$file${line:+:$line}    short citation is ambiguous; cite a fuller path")
      continue
    fi
    # Stages A/B run on the resolved path; report lines keep the citation
    # string as written in the note so /revise and reanchor can find it.
    # Stage A: did this file change since last_revised?
    probe="$(git -C "$fork_dir" log --oneline --since="$last_revised" -- "$resolved" 2>/dev/null | head -1)"
    if [[ -z "$probe" ]]; then
      stable_lines+=("$file${line:+:$line}")
      continue
    fi
    # Stage B: did the cited line region change? ±15 lines — wide enough
    # to catch the function body around the anchor, not just the line.
    if [[ -n "$line" ]]; then
      local file_len
      file_len="$(wc -l < "$fork_dir/$resolved" 2>/dev/null || echo 0)"
      if (( line > file_len )); then
        # git log -L would error (and read as "stable") past EOF.
        changed_lines+=("$file:$line    cited line beyond end of file (now $file_len lines)")
        continue
      fi
      local start_line=$((line - 15))
      (( start_line < 1 )) && start_line=1
      local end_line=$((line + 15))
      (( end_line > file_len )) && end_line=$file_len
      local line_probe
      line_probe="$(git -C "$fork_dir" log --since="$last_revised" -L"${start_line},${end_line}:${resolved}" 2>/dev/null | head -1)"
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
  LS_CACHE="$(mktemp "${TMPDIR:-/tmp}/cartograph-lsfiles.XXXXXX")"
  git -C "$WORKSPACE/$repo" ls-files > "$LS_CACHE" 2>/dev/null || true
  for topic_file in "$topics_dir"/*.md; do
    [[ -f "$topic_file" ]] || continue
    process_topic "$repo" "$topic_file"
  done
  rm -f "$LS_CACHE"
  LS_CACHE=""
done

exit 0
