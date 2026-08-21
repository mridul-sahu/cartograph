#!/usr/bin/env bash
# scripts/distill-signal.sh — PostToolUse:Edit|Write step (via post-edit.sh).
#
# When the file just written is an episode and one of its tags crossed the
# promotion threshold, emit the BINDING distillation contract: the CURRENT
# session merges those episodes into a topic (dedup-first) and folds to
# bedrock before it ends. Promotion is automatic; no /promote typing, no
# review gate. Detection reuses digest.sh (the single detector), run live
# because the daemon's cache is a few seconds behind this very write.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
payload="$(cat 2>/dev/null || true)"
path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[[ -z "$path" ]] && exit 0
case "$path" in
  "$CARTOGRAPH_ROOT"/episodes/*) : ;;
  *) exit 0 ;;
esac
[[ "${CARTOGRAPH_HEADLESS:-0}" == "1" ]] && exit 0
[[ -f "$path" ]] || exit 0

repo="$(awk -F': *' '/^repo:/{print $2; exit}' "$path" 2>/dev/null | tr -d ' "')"
tags_line="$(awk '/^tags:/{print; exit}' "$path" 2>/dev/null \
  | sed -E 's/^tags:[[:space:]]*//; s/^\[//; s/\]$//; s/"//g')"
[[ -z "$tags_line" ]] && exit 0

digest_out="$(bash "$CARTOGRAPH_ROOT/scripts/digest.sh" 2>/dev/null || true)"
[[ -z "$digest_out" ]] && exit 0

hits=""
IFS=',' read -ra arr <<<"$tags_line"
for t in "${arr[@]}"; do
  t="$(echo "$t" | xargs)"
  [[ -z "$t" ]] && continue
  line="$(printf '%s\n' "$digest_out" | grep -F "repo=${repo:-unknown}" | grep -E "tag=${t}( |$)" || true)"
  [[ -n "$line" ]] && hits+="$line"$'\n'
done
[[ -z "$hits" ]] && exit 0

topics="$(ls "$CARTOGRAPH_ROOT/guides/${repo:-none}/topics" 2>/dev/null | sed 's/\.md$//' | tr '\n' ' ')"
cat <<EOF
[cartograph-distill] The episode just written pushed tag(s) over the
promotion threshold:
$hits
DISTILLATION CONTRACT (automatic — do not ask, do not defer): after the
user's current task is done and before this session ends, run the
distillation procedure (the /promote steps) for each tag above: merge
into an EXISTING topic if one already covers the ground, else create
guides/$repo/topics/<tag>.md; stamp distilled_into on the sources; fold
a 1-3 sentence pointer into bedrock. Distilling must SHRINK the reading
surface (the topic replaces the episodes in retrieval), never grow it.
Existing $repo topics to dedup against: ${topics:-none yet}
