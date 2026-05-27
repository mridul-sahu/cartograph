#!/usr/bin/env bash
# scripts/revise-rejected.sh — when a human rejects a piece of Cartograph
# content with a note, drive `claude -p` headless to research the problem,
# fix the content per that note, and reset it to pending re-review.
#
# USAGE
#   scripts/revise-rejected.sh <path-relative-to-cartograph-root>
#     e.g. scripts/revise-rejected.sh episodes/2026-05/foo.md
#          scripts/revise-rejected.sh guides/jax/topics/bar.md
#
# Spawned detached by the reject branch of the review endpoints. On a
# clean run it commits the revision, pushes, and triggers a site rebuild.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
LOG_DIR="$CARTOGRAPH_ROOT/.revise-log"
mkdir -p "$LOG_DIR"

rel="${1:?usage: $0 <content-path>}"
file="$CARTOGRAPH_ROOT/$rel"
if [[ ! -f "$file" ]]; then
  echo "revise-rejected: no file at $rel" >&2
  exit 2
fi

today="$(date +%Y-%m-%d)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
log="$LOG_DIR/${timestamp}-$(basename "$rel" .md).log"
prompt_file="$(mktemp -t cartograph-revise-rejected.XXXXXX)"

# Pull the rejection note + repo out of the content's frontmatter.
note="$(grep -E '^review_notes:' "$file" 2>/dev/null | head -1 | sed -E 's/^review_notes:[[:space:]]*//')"
repo="$(grep -E '^repo:' "$file" 2>/dev/null | head -1 | sed -E 's/^repo:[[:space:]]*//')"
[[ -z "$note" ]] && note="(no note recorded — improve overall accuracy and quality)"

{
  echo "You are revising a piece of Cartograph content that a human reviewer REJECTED."
  echo "Fix it per their note, then reset it to pending re-review."
  echo
  echo "## The content file (revise this, in place)"
  echo "  $rel"
  echo
  echo "## Why the reviewer rejected it"
  echo "  $note"
  echo
  echo "## Your task"
  echo "1. Read $rel in full."
  echo "2. Treat the reviewer's note as the specific defect to fix."
  echo "3. Research as needed — read the relevant upstream code under"
  echo "   workspace/${repo:-<repo>}/, related topic notes, and bedrock — so the"
  echo "   fix is accurate, not guessed."
  echo "4. Revise the content IN PLACE with Edit. Be surgical: address the note,"
  echo "   preserve what was already correct. Do not rewrite wholesale."
  echo "5. Update the frontmatter of $rel:"
  echo "     - remove the 'rejected:' line entirely"
  echo "     - remove the 'review_notes:' line entirely"
  echo "     - set 'reviewed_by_human: ~'   (pending — the human re-reviews)"
  echo "     - add 'revised_after_rejection: ${today}'"
  echo "6. Print a one-paragraph summary: what was wrong, what you changed."
  echo
  echo "## Constraints"
  echo "- Surgical. Fix the rejection reason; don't gold-plate."
  echo "- Don't invent — verify against code."
  echo "- Touch ONLY $rel."
  echo
  echo "Begin."
} > "$prompt_file"

# Find claude — the server's subprocess PATH may miss user bins.
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [[ -z "$CLAUDE_BIN" ]]; then
  for c in "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/claude" \
           "/usr/local/bin/claude" "/opt/homebrew/bin/claude"; do
    [[ -x "$c" ]] && CLAUDE_BIN="$c" && break
  done
fi
if [[ -z "$CLAUDE_BIN" ]]; then
  echo "revise-rejected: claude CLI not found" > "$log"
  rm -f "$prompt_file"
  exit 127
fi

echo "revise-rejected: invoking claude -p for '$rel' (log: $log)"
cd "$CARTOGRAPH_ROOT"

flags="${CARTOGRAPH_REVISE_CLAUDE_FLAGS:---print --output-format text --permission-mode acceptEdits --allowedTools Read,Edit,Glob,Grep,Bash}"
"$CLAUDE_BIN" $flags < "$prompt_file" > "$log" 2>&1
rc=$?
rm -f "$prompt_file"

echo "revise-rejected: claude exited $rc; tail of transcript:"
tail -12 "$log"

if [[ $rc -eq 0 ]]; then
  # Land the revision on master and refresh the static site.
  if [[ "${CARTOGRAPH_REVISE_PUSH:-1}" != "0" ]] \
     && ! git diff --quiet -- "$rel" 2>/dev/null; then
    git add "$rel"
    git commit -q -m "fix(content): revise rejected ${rel} per reviewer note

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
    git push origin main 2>/dev/null \
      || { git pull --rebase origin main 2>/dev/null \
           && git push origin main 2>/dev/null; } \
      || echo "revise-rejected: push failed for $rel — push manually" >&2
  fi
  source "$(dirname "$0")/lib/notify-server.sh" 2>/dev/null && server_post /api/rebuild || true
fi

exit "$rc"
