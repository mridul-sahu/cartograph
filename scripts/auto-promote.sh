#!/usr/bin/env bash
# scripts/auto-promote.sh — SessionStart hook: ENQUEUE eligible curation work.
#
# This used to spawn one `claude -p` per eligible topic/tag. Because each
# spawned agent cd's into the repo and re-fires this very hook, that recursed
# into a 50+ agent swarm (the per-firing max_per_run=2 cap is powerless against
# recursion). Now this hook only ENQUEUES work — cheap, no spawn — and a single
# batched agent drains the queue later (serve.py's debounced loop, or
# `curate.sh drain` / the /curate command). The recursion guard makes a firing
# from *inside* an agent a clean no-op, so the cascade can never start.
#
#   1. EPISODE → TOPIC: a tag with ≥threshold non-distilled, non-rejected
#      episodes → enqueue `promote <repo> <tag>`.
#   2. TOPIC → BEDROCK: a non-rejected, not-yet-folded topic → enqueue
#      `fold <repo> <topic>` (default-approve: reject the topic to stop it).
#
# Opt-out: CARTOGRAPH_AUTO_PROMOTE=0
# Tunable: CARTOGRAPH_AUTO_PROMOTE_EPISODES=3 (min episodes per tag)

# Not using `set -u`: bash 3.2 (macOS) treats empty-array derefs as unbound.
# Not using `pipefail`: greps over frontmatter legitimately no-match (e.g. an
# episode with no `repo:` line), and pipefail would propagate that exit through
# `var=$(grep | … )` command substitutions and trip `set -e`.
set -e

# shellcheck source=lib/headless.sh
source "$(dirname "$0")/lib/headless.sh"   # sets CARTOGRAPH_ROOT
cg_autospawn_guard                          # no-op inside an agent / kill switch

if [[ "${CARTOGRAPH_AUTO_PROMOTE:-1}" == "0" ]]; then
  exit 0
fi

threshold="${CARTOGRAPH_AUTO_PROMOTE_EPISODES:-3}"
CURATE="$CARTOGRAPH_ROOT/scripts/curate.sh"
EPISODES="$CARTOGRAPH_ROOT/episodes"
GUIDES="$CARTOGRAPH_ROOT/guides"

# ────────────────────────────────────────────────────────────────────
# Cascade 1: episode → topic
# (bash 3.2-compatible — uses a sort/uniq tempfile instead of assoc arrays)
# ────────────────────────────────────────────────────────────────────
tmp_pairs="$(mktemp -t cartograph-ap-pairs.XXXXXX)"
trap 'rm -f "$tmp_pairs"' EXIT

while IFS= read -r ep; do
  if grep -qE '^distilled_into:[[:space:]]*[^~[:space:]]' "$ep" 2>/dev/null; then continue; fi
  if grep -qE '^rejected:[[:space:]]*true' "$ep" 2>/dev/null; then continue; fi

  repo="$(grep -E '^repo:' "$ep" 2>/dev/null | head -1 | sed -E 's/^repo:[[:space:]]*//')"
  [[ -z "$repo" ]] && continue

  inline_tags="$(grep -E '^tags:' "$ep" 2>/dev/null | head -1 | sed -E 's/^tags:[[:space:]]*//' | tr -d '[],' | tr ' ' '\n' | sed '/^$/d')"
  block_tags="$(awk '/^tags:[[:space:]]*$/{flag=1; next} /^[a-zA-Z_]+:/{flag=0} flag && /^[[:space:]]*-/{sub(/^[[:space:]]*-[[:space:]]*/,""); print}' "$ep")"
  all_tags="$(printf '%s\n%s\n' "$inline_tags" "$block_tags" | sed '/^$/d' | sort -u)"

  while IFS= read -r tag; do
    [[ -z "$tag" ]] && continue
    printf '%s\t%s\n' "$repo" "$tag" >> "$tmp_pairs"
  done <<<"$all_tags"
done < <(find "$EPISODES" -type f -name '*.md' 2>/dev/null)

# Group by (repo, tag); keep those at/above threshold. Output: <count>\t<repo>\t<tag>
candidates="$(sort "$tmp_pairs" | uniq -c | awk -v t="$threshold" '$1 >= t { print $1 "\t" $2 "\t" $3 }')"

while IFS=$'\t' read -r count repo tag; do
  [[ -z "$tag" ]] && continue
  # If the topic exists and most source episodes are already distilled, skip.
  topic_path="$GUIDES/$repo/topics/${tag}.md"
  if [[ -f "$topic_path" ]]; then
    distilled_count=$(grep -lE "distilled_into:.*/topics/${tag}\.md" "$EPISODES"/*/*.md 2>/dev/null | wc -l | tr -d ' ')
    if (( distilled_count >= count - 1 )); then continue; fi
  fi
  bash "$CURATE" enqueue promote "$repo" "$tag" || true
done <<<"$candidates"

# ────────────────────────────────────────────────────────────────────
# Cascade 2: topic → bedrock (default-approve — reject to halt)
# ────────────────────────────────────────────────────────────────────
for repo_dir in "$GUIDES"/*/; do
  [[ -d "$repo_dir" ]] || continue
  repo="$(basename "$repo_dir")"
  topics_dir="$repo_dir/topics"
  [[ -d "$topics_dir" ]] || continue

  for topic in "$topics_dir"/*.md; do
    [[ -f "$topic" ]] || continue
    name="$(basename "$topic" .md)"
    if grep -qE '^rejected:[[:space:]]*true' "$topic" 2>/dev/null; then continue; fi
    if grep -qE '^folded_into_bedrock:[[:space:]]*[^~[:space:]]' "$topic" 2>/dev/null; then continue; fi
    bash "$CURATE" enqueue fold "$repo" "$name" || true
  done
done

exit 0
