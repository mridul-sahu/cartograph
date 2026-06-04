#!/usr/bin/env bash
# scripts/fold-topic-to-bedrock.sh — surgically integrate a topic note's
# insight into the relevant bedrock section.
#
# Usage:
#   scripts/fold-topic-to-bedrock.sh <repo> <topic-slug>
#
# Surgical, not a rewrite — claude picks ONE of overview/architecture/
# conventions, adds a 1–3 sentence reference to the topic, bumps the
# bedrock file's last_revised, and leaves the topic note unchanged.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
repo="${1:?usage: $0 <repo> <topic-slug>}"
topic="${2:?usage: $0 <repo> <topic-slug>}"

case "$repo" in
  */*|*..*) echo "invalid repo" >&2; exit 2 ;;
esac
case "$topic" in
  */*|*..*) echo "invalid topic" >&2; exit 2 ;;
esac

topic_path="$CARTOGRAPH_ROOT/guides/$repo/topics/${topic}.md"
if [[ ! -f "$topic_path" ]]; then
  echo "topic note not found: $topic_path" >&2
  exit 1
fi

# shellcheck source=lib/headless.sh
source "$(dirname "$0")/lib/headless.sh"

today="$(date +%Y-%m-%d)"
current_sha="$(git -C "$CARTOGRAPH_ROOT/workspace/$repo" rev-parse --short upstream/main 2>/dev/null || echo unknown)"

prompt="$(mktemp -t cartograph-fold.XXXXXX)"
{
  echo "You are folding a Cartograph topic note's insight into the relevant"
  echo "bedrock section for repo \`$repo\`. This is a SURGICAL update — NOT"
  echo "a bedrock rewrite."
  echo
  echo "## The topic note to fold in"
  echo
  echo "File: guides/$repo/topics/${topic}.md"
  echo
  cat "$topic_path"
  echo
  echo
  echo "## The current bedrock files"
  echo
  for layer in overview architecture conventions; do
    f="$CARTOGRAPH_ROOT/guides/$repo/$layer.md"
    [[ -f "$f" ]] || continue
    echo "### guides/$repo/$layer.md"
    echo
    cat "$f"
    echo
    echo "---"
    echo
  done
  echo
  echo "## Your task"
  echo
  echo "Pick the SINGLE bedrock file (overview / architecture / conventions)"
  echo "whose existing structure is most relevant to this topic's insight."
  echo
  echo "Add the topic's insight as ONE of:"
  echo "  - A new bullet under an existing section (preferred)"
  echo "  - A 1–3 sentence reference under the most relevant section heading,"
  echo "    cross-linked to \`guides/$repo/topics/${topic}.md\`"
  echo "  - A new short subsection if no existing section fits naturally"
  echo
  echo "## Constraints"
  echo
  echo "- DO NOT rewrite or restructure any existing bedrock content."
  echo "- DO NOT touch the other two bedrock files."
  echo "- DO NOT touch the topic note at \`guides/$repo/topics/${topic}.md\`."
  echo "  (The topic note is the deep dive; bedrock just references it.)"
  echo "- Bump \`last_revised: $today\` in the bedrock file you edit."
  echo "- Keep the bedrock file's other frontmatter (layer, repo,"
  echo "  backfilled_from_sha) unchanged."
  echo "- The cross-reference should use the form:"
  echo "    See \`guides/$repo/topics/${topic}.md\` for the full discussion."
  echo "- If the topic's claim *contradicts* existing bedrock content"
  echo "  (rather than extending it), revise the contradicted sentence"
  echo "  in place AND add a reference to the topic note."
  echo
  echo "## After"
  echo
  echo "Run the lint to confirm the bedrock still meets the bar:"
  echo "  bash scripts/lint-content.sh --human 2>&1 | grep -A 1 guides/$repo/"
  echo
  echo "Set \`folded_into_bedrock: $today\` in the topic note's frontmatter"
  echo "at guides/$repo/topics/${topic}.md so the auto-promoter knows this"
  echo "topic has been folded and won't fire again."
  echo
  echo "Print a one-line summary: 'folded guides/$repo/topics/${topic}.md"
  echo "into guides/$repo/<layer>.md — added <N> sentences under <section>'."
} > "$prompt"

echo "fold-topic-to-bedrock: invoking claude -p — folding topic '$topic' into $repo bedrock"
flags="${CARTOGRAPH_FOLD_CLAUDE_FLAGS:---print --output-format text --permission-mode acceptEdits --allowedTools Read,Edit,Glob,Grep,Bash}"
cd "$CARTOGRAPH_ROOT"
cg_headless_run "fold:$repo/$topic" -- $flags < "$prompt"
rc=$?
rm -f "$prompt"

# Re-run lint on this repo's bedrock to catch any structural break.
echo
echo "=== lint (filtered to $repo bedrock) ==="
/bin/bash "$CARTOGRAPH_ROOT/scripts/lint-content.sh" --human 2>&1 | grep -A 1 "guides/$repo/" || echo "  clean"

exit $rc
