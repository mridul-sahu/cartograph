#!/usr/bin/env bash
# Tag-frequency digest — THE promotion detector (single source of truth;
# /api/promote-candidates applies the same rule). For each tag appearing on
# >= CARTOGRAPH_PROMOTE_THRESHOLD episodes not yet distilled UNDER THAT TAG,
# suggest /promote <tag>. An episode distilled into topics/<slug>.md still
# counts toward its OTHER tags — multi-tag episodes keep their signal.
#
# Cheap (grep + awk); the serve daemon precomputes it into
# .cartograph/state/digest-cache on every content change.

set -euo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
EPISODES="$CARTOGRAPH_ROOT/episodes"

THRESHOLD="${CARTOGRAPH_PROMOTE_THRESHOLD:-3}"

[[ -d "$EPISODES" ]] || exit 0

files="$(find "$EPISODES" -type f -name '*.md' 2>/dev/null || true)"
[[ -z "$files" ]] && exit 0

# For each episode: emit one "repo|tag" line per tag, EXCEPT the tag the
# episode was already distilled under (distilled_into's basename).
emit() {
  local f="$1"
  local distilled dslug=""
  distilled="$(awk -F': *' '/^distilled_into:/{print $2; exit}' "$f" 2>/dev/null | tr -d ' "')"
  if [[ -n "$distilled" && "$distilled" != "~" ]]; then
    dslug="${distilled##*/}"
    dslug="${dslug%.md}"
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
    [[ -n "$dslug" && "$t" == "$dslug" ]] && continue
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

echo "[cartograph-digest] DISTILLATION CONTRACT — tags with >= $THRESHOLD episodes not yet distilled under them. Promotion is automatic: when one of these tags belongs to the repo you are working in, run the distillation procedure (the /promote steps: dedup-first merge into an existing topic or create one, stamp distilled_into, fold to bedrock) as part of THIS session. No permission needed, no review gate."
while IFS= read -r line; do
  count="${line%% *}"
  rest="${line#* }"
  repo="${rest%|*}"
  tag="${rest#*|}"
  printf "  %3d × repo=%-10s tag=%s    -> distill (automatic)\n" "$count" "$repo" "$tag"
done <<<"$counts"
