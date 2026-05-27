#!/usr/bin/env bash
# Tag-frequency digest. For each tag appearing on >= THRESHOLD episodes from
# the last LOOKBACK_DAYS that are NOT yet distilled into a topic note, suggest
# /promote <tag>.
#
# Designed to be cheap (just grep + awk) so it can run on every SessionStart
# without measurable cost.

set -euo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
EPISODES="$CARTOGRAPH_ROOT/episodes"

THRESHOLD="${CARTOGRAPH_DIGEST_THRESHOLD:-3}"
LOOKBACK_DAYS="${CARTOGRAPH_DIGEST_LOOKBACK_DAYS:-90}"

[[ -d "$EPISODES" ]] || exit 0

# macOS find: -mtime in days; -<n> means "modified within last n days".
files="$(find "$EPISODES" -type f -name '*.md' -mtime "-$LOOKBACK_DAYS" 2>/dev/null || true)"
[[ -z "$files" ]] && exit 0

# For each episode: if distilled_into is set (non-null), skip.
# Otherwise, extract the tags: [a, b, c] line and emit one "repo|tag" line per tag.
emit() {
  local f="$1"
  if grep -qE '^distilled_into:[[:space:]]*[^~[:space:]]' "$f" 2>/dev/null; then
    return
  fi
  local repo tags_line
  repo="$(awk -F': *' '/^repo:/{print $2; exit}' "$f" 2>/dev/null | tr -d ' "')"
  tags_line="$(awk '/^tags:/{print; exit}' "$f" 2>/dev/null)"
  # Strip 'tags:' prefix, brackets, quotes, then split on commas.
  tags="$(echo "$tags_line" | sed -E 's/^tags:[[:space:]]*//; s/^\[//; s/\]$//; s/"//g; s/'\''//g')"
  IFS=',' read -ra arr <<<"$tags"
  for t in "${arr[@]}"; do
    t="$(echo "$t" | xargs)"
    [[ -z "$t" ]] && continue
    printf '%s|%s\n' "${repo:-unknown}" "$t"
  done
}

counts="$(
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    emit "$f"
  done <<<"$files" \
  | sort | uniq -c | awk -v T="$THRESHOLD" '$1 >= T {print $1, $2}' | sort -rn
)"

if [[ -z "$counts" ]]; then
  exit 0
fi

echo "[cartograph-digest] tags with >= $THRESHOLD undistilled episodes in last $LOOKBACK_DAYS days:"
while IFS= read -r line; do
  count="${line%% *}"
  rest="${line#* }"
  repo="${rest%|*}"
  tag="${rest#*|}"
  printf "  %3d × repo=%-10s tag=%s    -> consider /promote %s\n" "$count" "$repo" "$tag" "$tag"
done <<<"$counts"
