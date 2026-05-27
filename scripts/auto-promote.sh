#!/usr/bin/env bash
# scripts/auto-promote.sh — the load-bearing "cartograph compounds with
# each usage" loop.
#
# Two cascades, fired in the BACKGROUND from a SessionStart hook so the
# user's interactive session isn't blocked:
#
#   1. EPISODE → TOPIC
#      For every tag with ≥CARTOGRAPH_AUTO_PROMOTE_EPISODES (default 3)
#      non-distilled, non-rejected episodes that share it, spawn
#      `scripts/promote-tag.sh <tag>` in the background. The drafted
#      topic note gets `auto_promoted: true` in frontmatter so the UI
#      can show "review me."
#
#   2. TOPIC → BEDROCK
#      For every topic note that is eligible to fold — no `rejected: true`
#      and no `folded_into_bedrock:` yet — spawn
#      `scripts/fold-topic-to-bedrock.sh` in the background. This is
#      default-approve: it does NOT wait for `reviewed_by_human:`; you
#      reject to stop it, you don't approve to start it.
#
# Default-approve semantic:
#   - Episodes/topics WITHOUT `rejected: true` are eligible.
#   - Episodes already `distilled_into:` are skipped.
#   - Topics already `folded_into_bedrock:` are skipped.
#
# Opt-out: CARTOGRAPH_AUTO_PROMOTE=0
# Tunables:
#   CARTOGRAPH_AUTO_PROMOTE_EPISODES=3   (min episodes per tag)
#   CARTOGRAPH_AUTO_PROMOTE_MAX_PER_RUN=2 (max promotions per run, cost cap)

# Note: not using `set -u` because we use array dereferences that bash 3.2
# (macOS default) treats as unbound when empty. Use `set -e` only.
set -eo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"

if [[ "${CARTOGRAPH_AUTO_PROMOTE:-1}" == "0" ]]; then
  exit 0
fi

threshold="${CARTOGRAPH_AUTO_PROMOTE_EPISODES:-3}"
max_per_run="${CARTOGRAPH_AUTO_PROMOTE_MAX_PER_RUN:-2}"

EPISODES="$CARTOGRAPH_ROOT/episodes"
GUIDES="$CARTOGRAPH_ROOT/guides"
LOCK_DIR="$CARTOGRAPH_ROOT/.auto-promote-locks"
mkdir -p "$LOCK_DIR"

# Reap stale locks (>1h old) so a crashed promotion doesn't block forever.
find "$LOCK_DIR" -type f -mmin +60 -delete 2>/dev/null || true

# ────────────────────────────────────────────────────────────────────
# Cascade 1: episode → topic
# (bash 3.2-compatible — uses a sort/uniq tempfile instead of assoc arrays)
# ────────────────────────────────────────────────────────────────────

tmp_pairs="$(mktemp -t cartograph-ap-pairs.XXXXXX)"
trap 'rm -f "$tmp_pairs"' EXIT

# Each line: <repo>\t<tag>
# (counted later via sort | uniq -c)
while IFS= read -r ep; do
  # Skip distilled or rejected
  if grep -qE '^distilled_into:[[:space:]]*[^~[:space:]]' "$ep" 2>/dev/null; then continue; fi
  if grep -qE '^rejected:[[:space:]]*true' "$ep" 2>/dev/null; then continue; fi

  repo="$(grep -E '^repo:' "$ep" 2>/dev/null | head -1 | sed -E 's/^repo:[[:space:]]*//')"
  [[ -z "$repo" ]] && continue

  # Inline tags ([a, b, c])
  inline_tags="$(grep -E '^tags:' "$ep" 2>/dev/null | head -1 | sed -E 's/^tags:[[:space:]]*//' | tr -d '[],' | tr ' ' '\n' | sed '/^$/d')"
  # Block tags (one per line under tags:)
  block_tags="$(awk '/^tags:[[:space:]]*$/{flag=1; next} /^[a-zA-Z_]+:/{flag=0} flag && /^[[:space:]]*-/{sub(/^[[:space:]]*-[[:space:]]*/,""); print}' "$ep")"
  all_tags="$(printf '%s\n%s\n' "$inline_tags" "$block_tags" | sed '/^$/d' | sort -u)"

  while IFS= read -r tag; do
    [[ -z "$tag" ]] && continue
    printf '%s\t%s\n' "$repo" "$tag" >> "$tmp_pairs"
  done <<<"$all_tags"
done < <(find "$EPISODES" -type f -name '*.md' 2>/dev/null)

# Group by (repo, tag) and pick those with count >= threshold.
# Output: <count>\t<repo>\t<tag>
candidates="$(sort "$tmp_pairs" | uniq -c | awk -v t="$threshold" '$1 >= t { print $1 "\t" $2 "\t" $3 }')"

promoted=0
while IFS=$'\t' read -r count repo tag; do
  [[ -z "$tag" ]] && continue
  if (( promoted >= max_per_run )); then break; fi

  # If topic exists and most source episodes are already distilled, skip.
  topic_path="$GUIDES/$repo/topics/${tag}.md"
  if [[ -f "$topic_path" ]]; then
    distilled_count=$(grep -lE "distilled_into:.*/topics/${tag}\.md" "$EPISODES"/*/*.md 2>/dev/null | wc -l | tr -d ' ')
    if (( distilled_count >= count - 1 )); then continue; fi
  fi

  lock="$LOCK_DIR/episode-to-topic-${repo}-${tag}.lock"
  if [[ -f "$lock" ]]; then continue; fi
  touch "$lock"

  log="${TMPDIR:-/tmp}/cartograph-auto-promote-${repo}-${tag}.log"
  echo "[auto-promote] episode→topic: tag=$tag repo=$repo count=$count → background claude -p" >&2
  nohup env CARTOGRAPH_AUTO_DRAFTED=1 \
    bash "$CARTOGRAPH_ROOT/scripts/promote-tag.sh" "$tag" \
    > "$log" 2>&1 &
  disown $! 2>/dev/null || true
  promoted=$((promoted + 1))
done <<<"$candidates"

# ────────────────────────────────────────────────────────────────────
# Cascade 2: topic → bedrock
#
# Default-approve here too: any non-rejected, not-yet-folded topic is
# eligible. Cap at max_per_run per SessionStart so a fresh repo with
# many topic notes doesn't fire dozens of claude -p calls at once.
# ────────────────────────────────────────────────────────────────────

folded=0
for repo_dir in "$GUIDES"/*/; do
  [[ -d "$repo_dir" ]] || continue
  repo="$(basename "$repo_dir")"
  topics_dir="$repo_dir/topics"
  [[ -d "$topics_dir" ]] || continue

  for topic in "$topics_dir"/*.md; do
    if (( folded >= max_per_run )); then break 2; fi
    [[ -f "$topic" ]] || continue
    name="$(basename "$topic" .md)"

    # Opt-out: rejected topics don't fold.
    if grep -qE '^rejected:[[:space:]]*true' "$topic" 2>/dev/null; then continue; fi
    # Idempotency: already folded.
    if grep -qE '^folded_into_bedrock:[[:space:]]*[^~[:space:]]' "$topic" 2>/dev/null; then continue; fi

    # NOTE: previous version required `reviewed_by_human:` to be set.
    # That made bedrock fold opt-IN instead of opt-OUT, which contradicts
    # the cartograph-compounds-automatically property. Now we proceed by
    # default; the user explicitly rejects to halt the cascade.

    lock="$LOCK_DIR/topic-to-bedrock-${repo}-${name}.lock"
    if [[ -f "$lock" ]]; then continue; fi
    touch "$lock"

    log="${TMPDIR:-/tmp}/cartograph-auto-fold-${repo}-${name}.log"
    echo "[auto-promote] topic→bedrock: $repo/$name → background claude -p" >&2
    nohup bash "$CARTOGRAPH_ROOT/scripts/fold-topic-to-bedrock.sh" "$repo" "$name" \
      > "$log" 2>&1 &
    disown $! 2>/dev/null || true
    folded=$((folded + 1))
  done
done

exit 0
