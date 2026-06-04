#!/usr/bin/env bash
# scripts/promote-tag.sh — distill ≥3 same-tag episodes into a topic note
# via claude -p. The promotion workflow is described in CLAUDE.md §6.
#
# Usage:
#   scripts/promote-tag.sh <tag>
#
# Picks the target repo by majority of the source episodes' repo fields.
# Drafts guides/<repo>/topics/<tag>.md and sets distilled_into: on each
# source episode. The user reviews the diff before commit.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
tag="${1:?usage: $0 <tag>}"

if [[ "$tag" =~ / ]] || [[ "$tag" =~ \.\. ]]; then
  echo "invalid tag" >&2
  exit 2
fi

# Find episodes whose tags include $tag AND that aren't already distilled.
matching=()
while IFS= read -r ep; do
  # Skip if already distilled.
  if grep -qE '^distilled_into:[[:space:]]*[^~[:space:]]' "$ep" 2>/dev/null; then
    continue
  fi
  # Check tags list includes the tag.
  if /usr/bin/sed -n '/^---[[:space:]]*$/,/^---[[:space:]]*$/p' "$ep" | grep -qE "^[[:space:]]*-[[:space:]]*${tag}[[:space:]]*$|tags:.*[][[:space:]]${tag}[],[[:space:]]"; then
    matching+=("$ep")
  fi
done < <(find "$CARTOGRAPH_ROOT/episodes" -type f -name '*.md' 2>/dev/null)

if (( ${#matching[@]} < 3 )); then
  echo "promote-tag: only ${#matching[@]} matching non-distilled episodes for tag '$tag' (need >=3)" >&2
  exit 1
fi

# Pick the target repo. Strategy:
#   1. Majority of repo: frontmatter across source episodes.
#   2. Fallback: if no episode has repo: set, but the tag itself is a
#      known repo name (orbax, jax, xla, tunix, tokamax), use it.
#      Cartograph-session episodes commonly tag the upstream repo they
#      were working on without setting repo: directly.
# Bash 3.2 compat: sort/uniq tempfile, not 'declare -A'.
tmp_repos="$(mktemp -t cartograph-promote-repos.XXXXXX)"
trap 'rm -f "$tmp_repos"' EXIT
for ep in "${matching[@]}"; do
  r="$(grep -E '^repo:' "$ep" 2>/dev/null | head -1 | sed -E 's/^repo:[[:space:]]*//')"
  [[ -z "$r" ]] && continue
  printf '%s\n' "$r" >> "$tmp_repos"
done
target_repo="$(sort "$tmp_repos" | uniq -c | sort -rn | head -1 | awk '{print $2}')"

# Known-repo fallback. The list mirrors REPOS in serve.py — keep in sync.
KNOWN_REPOS_RE="^(jax|orbax|xla|tunix|tokamax)$"
if [[ -z "$target_repo" ]]; then
  if [[ "$tag" =~ $KNOWN_REPOS_RE ]]; then
    target_repo="$tag"
    echo "promote-tag: no repo: in source frontmatter — falling back to tag-as-repo ($tag is a known repo name)" >&2
  fi
fi

if [[ -z "$target_repo" ]]; then
  echo "promote-tag: could not determine target repo. None of the ${#matching[@]} source episodes have a repo: frontmatter field, and the tag '$tag' isn't a known repo name (jax|orbax|xla|tunix|tokamax). Add repo: to the episodes or pick a different tag." >&2
  exit 1
fi

dest="$CARTOGRAPH_ROOT/guides/$target_repo/topics/${tag}.md"
if [[ -f "$dest" ]]; then
  echo "promote-tag: topic note already exists at $dest — claude will revise it instead" >&2
fi

# shellcheck source=lib/headless.sh
source "$(dirname "$0")/lib/headless.sh"

today="$(date +%Y-%m-%d)"

# Auto-promoted topics get `auto_promoted: true` so the UI can flag
# them as pending review (default-approve unless explicitly rejected).
auto_drafted="${CARTOGRAPH_AUTO_DRAFTED:-0}"

# Build the prompt.
prompt="$(mktemp -t cartograph-promote.XXXXXX)"
{
  echo "You are distilling ${#matching[@]} episodes tagged \`$tag\` into a Cartograph topic note."
  echo
  echo "## The episodes to distill"
  echo
  for ep in "${matching[@]}"; do
    rel="${ep#$CARTOGRAPH_ROOT/}"
    echo "### $rel"
    cat "$ep"
    echo
    echo "---"
    echo
  done
  echo
  echo "## Your task"
  echo
  echo "Draft a topic note at:"
  echo "  guides/$target_repo/topics/${tag}.md"
  echo
  echo "Frontmatter:"
  echo "  ---"
  echo "  layer: topic"
  echo "  repo: $target_repo"
  echo "  topic: $tag"
  echo "  last_revised: $today"
  echo "  reviewed_by_human: ~"
  echo "  rejected: false"
  if [[ "$auto_drafted" == "1" ]]; then
    echo "  auto_promoted: true"
  fi
  echo "  synthesized_from_exploration: false"
  echo "  distilled_from:"
  for ep in "${matching[@]}"; do
    rel="${ep#$CARTOGRAPH_ROOT/}"
    echo "    - $rel"
  done
  echo "  ---"
  echo
  echo "Body: 1000–1500 words covering the COMMON insights across the episodes."
  echo "  - Lead with the load-bearing claim (what's the durable mental model?)"
  echo "  - Cite file:line anchors that show up in ≥2 source episodes"
  echo "  - Cross-reference bedrock if relevant"
  echo "  - End with 'When to revise this note': what would have to change"
  echo "    in $target_repo for this distillation to be wrong"
  echo
  echo "If a topic note already exists at the destination, REVISE IT IN PLACE."
  echo "Don't fork a v2."
  echo
  echo "## After writing the topic note"
  echo
  echo "Update each source episode's frontmatter — set:"
  echo "  distilled_into: guides/$target_repo/topics/${tag}.md"
  echo
  echo "Print a one-line summary at the end: 'distilled <N> episodes into <path>'"
} > "$prompt"

echo "promote-tag: invoking claude -p — distilling ${#matching[@]} episodes for tag '$tag' → guides/$target_repo/topics/${tag}.md"
flags="${CARTOGRAPH_PROMOTE_CLAUDE_FLAGS:---print --output-format text --permission-mode acceptEdits --allowedTools Read,Edit,Write,Glob,Grep,Bash}"
cd "$CARTOGRAPH_ROOT"
cg_headless_run "promote:$tag" -- $flags < "$prompt"
rc=$?
rm -f "$prompt"

# Post-flight: claude can exit 0 without invoking Write — it returns
# the draft as text instead of saving the file. Verify the topic file
# exists; without this the API endpoint reports ok=true and the UI
# says 'topic drafted' but the candidate stays in the queue forever.
if [[ "$rc" -eq 0 ]]; then
  if [[ ! -f "$dest" ]]; then
    echo "promote-tag: claude exited 0 but $dest was not written — falling back to non-zero exit so caller knows the work didn't land" >&2
    exit 4
  fi
  # Verify at least one source episode got distilled_into stamped. If
  # none did, claude wrote the topic but skipped the back-stamping step.
  stamped=0
  for ep in "${matching[@]}"; do
    if grep -qE "^distilled_into:[[:space:]]*guides/${target_repo}/topics/${tag}\.md" "$ep" 2>/dev/null; then
      stamped=$((stamped + 1))
    fi
  done
  if [[ "$stamped" -eq 0 ]]; then
    echo "promote-tag: topic file written but no source episode has distilled_into stamped — partial success, returning non-zero so caller can retry" >&2
    exit 5
  fi
  echo "promote-tag: distilled ${stamped}/${#matching[@]} episodes into $dest"
fi
exit $rc
