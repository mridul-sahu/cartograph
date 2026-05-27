#!/usr/bin/env bash
# scripts/metrics.sh — compute Cartograph telemetry/metrics across the corpus.
#
# Outputs JSON on stdout. Can also emit a human-readable summary with --human.
# Used by /api/metrics and by `cartograph metrics` from the terminal.
#
# Metrics:
#   - per repo: bedrock_revised_at, backfilled_from_sha, topics_count,
#     topics_reviewed_count, walkthroughs_count, drift_present, drift_commits
#   - global: total_topics, total_reviewed, review_ratio,
#     total_walkthroughs, total_episodes, total_drafts, total_drift_reports,
#     bedrock_freshness_ratio (repos with bedrock == upstream / total)
#   - activity: episodes_in_last_7d, topics_revised_in_last_7d,
#     drift_reports_closed_in_last_7d (read from .auto-revise-log if present)

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
GUIDES="$CARTOGRAPH_ROOT/guides"
EPISODES="$CARTOGRAPH_ROOT/episodes"
WALKTHROUGHS="$CARTOGRAPH_ROOT/learn/walkthroughs"
DRAFTS="$CARTOGRAPH_ROOT/learn/drafts"
DRIFT_REPORTS="$CARTOGRAPH_ROOT/.drift-reports"
AUTO_REVISE_LOG="$CARTOGRAPH_ROOT/.auto-revise-log"
WORKSPACE="$CARTOGRAPH_ROOT/workspace"

human=0
[[ "${1:-}" == "--human" ]] && human=1

# Helper: read a frontmatter field from a markdown file (subset of fm_get).
fm_field() {
  local file="$1" field="$2"
  [[ -f "$file" ]] || return
  sed -n '/^---[[:space:]]*$/,/^---[[:space:]]*$/p' "$file" 2>/dev/null \
    | sed '1d;$d' \
    | grep -E "^[[:space:]]*${field}[[:space:]]*:" \
    | head -1 \
    | sed -E "s/^[[:space:]]*${field}[[:space:]]*:[[:space:]]*//; s/[[:space:]]*#.*$//; s/[[:space:]]+$//"
}

repos=()
while IFS= read -r -d '' d; do
  [[ -d "$d/.git" ]] && repos+=("$(basename "$d")")
done < <(find "$WORKSPACE" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)

# Per-repo metrics.
repo_blocks=()
total_topics=0
total_reviewed=0
total_walkthroughs=0
fresh_repos=0
total_repos=${#repos[@]}

for repo in "${repos[@]}"; do
  overview="$GUIDES/$repo/overview.md"
  bedrock_sha="$(fm_field "$overview" backfilled_from_sha)"
  bedrock_revised="$(fm_field "$overview" last_revised)"
  upstream_sha="$(git -C "$WORKSPACE/$repo" rev-parse --short upstream/main 2>/dev/null || echo '')"

  topics_count=0
  topics_reviewed=0
  if [[ -d "$GUIDES/$repo/topics" ]]; then
    while IFS= read -r -d '' t; do
      [[ "$(basename "$t")" == ".gitkeep" ]] && continue
      topics_count=$((topics_count + 1))
      reviewed="$(fm_field "$t" reviewed_by_human)"
      # YAML null `~` is not a real review; treat as empty.
      [[ "$reviewed" == "~" ]] && reviewed=""
      [[ -n "$reviewed" ]] && topics_reviewed=$((topics_reviewed + 1))
    done < <(find "$GUIDES/$repo/topics" -name '*.md' -print0 2>/dev/null)
  fi

  walks_count=0
  if [[ -d "$WALKTHROUGHS" ]]; then
    walks_count="$(grep -lE "^repo:[[:space:]]*$repo\$" "$WALKTHROUGHS"/*.md 2>/dev/null | wc -l | tr -d ' ')"
  fi

  drift_present=false
  drift_commits=0
  drift_files=0
  drift_file="$DRIFT_REPORTS/$repo.md"
  if [[ -f "$drift_file" ]]; then
    drift_present=true
    drift_commits="$(grep -oE '[0-9]+ commit' "$drift_file" | head -1 | grep -oE '[0-9]+' || echo 0)"
    drift_files="$(grep -oE '[0-9]+ file' "$drift_file" | head -1 | grep -oE '[0-9]+' || echo 0)"
  fi

  fresh=false
  if [[ -n "$bedrock_sha" && -n "$upstream_sha" && "$bedrock_sha" == "$upstream_sha" ]]; then
    fresh=true
    fresh_repos=$((fresh_repos + 1))
  fi

  total_topics=$((total_topics + topics_count))
  total_reviewed=$((total_reviewed + topics_reviewed))
  total_walkthroughs=$((total_walkthroughs + walks_count))

  repo_blocks+=("$(cat <<EOF
    "$repo": {
      "bedrock_sha": "$bedrock_sha",
      "bedrock_revised": "$bedrock_revised",
      "upstream_sha": "$upstream_sha",
      "fresh": $fresh,
      "topics_count": $topics_count,
      "topics_reviewed": $topics_reviewed,
      "walkthroughs_count": $walks_count,
      "drift_present": $drift_present,
      "drift_commits": $drift_commits,
      "drift_files": $drift_files
    }
EOF
)")
done

# Episode totals.
episodes_count=0
episodes_7d=0
if [[ -d "$EPISODES" ]]; then
  episodes_count="$(find "$EPISODES" -name '*.md' -not -name 'README.md' 2>/dev/null | wc -l | tr -d ' ')"
  episodes_7d="$(find "$EPISODES" -name '*.md' -not -name 'README.md' -mtime -7 2>/dev/null | wc -l | tr -d ' ')"
fi

# Draft + drift report totals.
drafts_count=0
[[ -d "$DRAFTS" ]] && drafts_count="$(find "$DRAFTS" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
drift_reports_count=0
[[ -d "$DRIFT_REPORTS" ]] && drift_reports_count="$(find "$DRIFT_REPORTS" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"

# Activity: topic notes revised in last 7d.
topics_revised_7d="$(find "$GUIDES" -path '*/topics/*.md' -mtime -7 2>/dev/null | wc -l | tr -d ' ')"

# Auto-resolved drift in last 7d.
drift_closed_7d=0
[[ -d "$AUTO_REVISE_LOG" ]] && drift_closed_7d="$(find "$AUTO_REVISE_LOG" -name '*.log' -mtime -7 2>/dev/null | wc -l | tr -d ' ')"

# Review ratio.
review_ratio="0.0"
if (( total_topics > 0 )); then
  review_ratio="$(awk "BEGIN { printf \"%.2f\", $total_reviewed / $total_topics }")"
fi

freshness_ratio="0.0"
if (( total_repos > 0 )); then
  freshness_ratio="$(awk "BEGIN { printf \"%.2f\", $fresh_repos / $total_repos }")"
fi

# Emit JSON (or human).
if [[ $human -eq 1 ]]; then
  echo "═══════════════════════════════════════════════════════"
  echo " Cartograph metrics — $(date +'%Y-%m-%d %H:%M:%S')"
  echo "═══════════════════════════════════════════════════════"
  echo
  printf " %-12s %-12s %-12s %-7s %-7s %-9s %-8s\n" "repo" "bedrock" "upstream" "topics" "review" "walkthru" "drift"
  printf " %-12s %-12s %-12s %-7s %-7s %-9s %-8s\n" "----" "-------" "--------" "------" "------" "--------" "-----"
  for repo in "${repos[@]}"; do
    bs="$(fm_field "$GUIDES/$repo/overview.md" backfilled_from_sha)"
    us="$(git -C "$WORKSPACE/$repo" rev-parse --short upstream/main 2>/dev/null || echo '')"
    tc=0; tr=0
    if [[ -d "$GUIDES/$repo/topics" ]]; then
      while IFS= read -r -d '' t; do
        [[ "$(basename "$t")" == ".gitkeep" ]] && continue
        tc=$((tc + 1))
        rv="$(fm_field "$t" reviewed_by_human)"
        [[ "$rv" == "~" ]] && rv=""
        [[ -n "$rv" ]] && tr=$((tr + 1))
      done < <(find "$GUIDES/$repo/topics" -name '*.md' -print0 2>/dev/null)
    fi
    wc_=0; [[ -d "$WALKTHROUGHS" ]] && wc_="$(grep -lE "^repo:[[:space:]]*$repo\$" "$WALKTHROUGHS"/*.md 2>/dev/null | wc -l | tr -d ' ')"
    drift="—"; [[ -f "$DRIFT_REPORTS/$repo.md" ]] && drift="$(grep -oE '[0-9]+ commit' "$DRIFT_REPORTS/$repo.md" | head -1)"
    printf " %-12s %-12s %-12s %-7d %-7d %-9d %-8s\n" "$repo" "$bs" "$us" "$tc" "$tr" "$wc_" "$drift"
  done
  echo
  echo " global:"
  echo "   topics_total:        $total_topics"
  echo "   topics_reviewed:     $total_reviewed (review_ratio $review_ratio)"
  echo "   walkthroughs_total:  $total_walkthroughs"
  echo "   episodes_total:      $episodes_count (last 7d: $episodes_7d)"
  echo "   drafts_total:        $drafts_count"
  echo "   drift_reports:       $drift_reports_count"
  echo "   bedrock_freshness:   $fresh_repos / $total_repos ($freshness_ratio)"
  echo "   topics_revised_7d:   $topics_revised_7d"
  echo "   auto_revise_runs_7d: $drift_closed_7d"
  exit 0
fi

# JSON output.
joined_repos="$(printf "%s,\n" "${repo_blocks[@]}" | sed '$s/,$//')"

cat <<EOF
{
  "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "repos": {
$joined_repos
  },
  "global": {
    "topics_total": $total_topics,
    "topics_reviewed": $total_reviewed,
    "review_ratio": $review_ratio,
    "walkthroughs_total": $total_walkthroughs,
    "episodes_total": $episodes_count,
    "episodes_in_last_7d": $episodes_7d,
    "drafts_total": $drafts_count,
    "drift_reports_count": $drift_reports_count,
    "bedrock_freshness_ratio": $freshness_ratio,
    "topics_revised_in_last_7d": $topics_revised_7d,
    "auto_revise_runs_in_last_7d": $drift_closed_7d
  }
}
EOF
