#!/usr/bin/env bash
# scripts/session-to-episode.sh — invoke claude -p to draft an episode
# from a session log.
#
# Usage:
#   scripts/session-to-episode.sh <session-slug>
#
# Reads sessions/<month>/<slug>.md, primes claude with the tool-use log
# and any "## hint at stop" block, and asks claude to draft a short
# episode summarising what was learned. The user reviews the draft
# before commit.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
slug="${1:?usage: $0 <session-slug>}"

if [[ "$slug" =~ \.\. ]] || [[ "$slug" =~ / ]]; then
  echo "invalid slug" >&2
  exit 2
fi

# Find the session file across YYYY-MM subdirs.
log=""
for d in "$CARTOGRAPH_ROOT/sessions"/*; do
  [[ -d "$d" ]] || continue
  if [[ -f "$d/$slug.md" ]]; then
    log="$d/$slug.md"
    break
  fi
done

if [[ -z "$log" ]]; then
  echo "session log not found for slug: $slug" >&2
  exit 1
fi

# Find claude.
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [[ -z "$CLAUDE_BIN" ]]; then
  for c in "$HOME/.local/bin/claude" /usr/local/bin/claude /opt/homebrew/bin/claude; do
    if [[ -x "$c" ]]; then CLAUDE_BIN="$c"; break; fi
  done
fi
if [[ -z "$CLAUDE_BIN" ]]; then
  echo "claude CLI not found" >&2
  exit 127
fi

# Extract scope from the session log frontmatter so we can target
# the right episode subdir + frontmatter repo field.
scope="$(grep -E '^scope:' "$log" | head -1 | sed -E 's/^scope:[[:space:]]*//')"
repo=""
case "$scope" in
  fork-*) repo="${scope#fork-}" ;;
  *) repo="" ;;
esac

today="$(date +%Y-%m-%d)"
month="$(date +%Y-%m)"

# Auto-drafted episodes get `auto_drafted: true` in frontmatter so the UI
# can flag them as pending human review. Set via env from episode-prompt.sh.
auto_drafted="${CARTOGRAPH_AUTO_DRAFTED:-0}"

prompt_file="$(mktemp -t cartograph-session-episode.XXXXXX)"
{
  echo "You are drafting a Cartograph episode from a session log."
  echo
  echo "## The session log"
  echo
  cat "$log"
  echo
  echo
  echo "## Your task"
  echo
  echo "Read the session log above. Look at the files that were edited"
  echo "(via git log / git diff if needed). Then draft a short episode"
  echo "(200–600 words) at:"
  if [[ -n "$repo" ]]; then
    echo "  episodes/$month/${today}-${repo}-from-session-${slug}.md"
  else
    echo "  episodes/$month/${today}-from-session-${slug}.md"
  fi
  echo
  echo "Frontmatter:"
  echo "  ---"
  echo "  layer: episode"
  echo "  date: $today"
  if [[ -n "$repo" ]]; then
    echo "  repo: $repo"
  fi
  echo "  files_touched:"
  echo "    - <list the files from the tool-use log>"
  echo "  tags: [...]"
  echo "  superseded_by: ~"
  echo "  distilled_into: ~"
  if [[ "$auto_drafted" == "1" ]]; then
    echo "  auto_drafted: true"
    echo "  source_session: sessions/$(basename "$(dirname "$log")")/$(basename "$log")"
  fi
  echo "  ---"
  echo
  echo "## Constraints"
  echo
  echo "- Don't invent details — if the session was trivial, write a SHORT"
  echo "  note explaining why nothing substantive came out. Don't pad."
  echo "- Cross-reference any topic notes or research notes that are"
  echo "  relevant. Cite file:line if you can verify from git diff."
  echo "- Tag with subsystem-specific keywords (not 'bug' / 'feature' alone)."
  echo "- Body sections: 'What the task was', 'What I learned', 'What to"
  echo "  tell a future Claude session'."
  echo
  echo "Be conservative. If you don't have enough material, write 1–2"
  echo "paragraphs and set the file's body appropriately — the user will"
  echo "decide whether to keep, expand, or mark this session as trivial."
} > "$prompt_file"

flags="${CARTOGRAPH_S2E_CLAUDE_FLAGS:---print --output-format text --permission-mode acceptEdits --allowedTools Read,Edit,Write,Glob,Grep,Bash}"
cd "$CARTOGRAPH_ROOT"
echo "session-to-episode: invoking claude -p for session $slug (log: $log)"
"$CLAUDE_BIN" $flags < "$prompt_file"
rc=$?
rm -f "$prompt_file"

# Commit the draft. This script runs DETACHED from the Stop hook — it
# finishes minutes after the hook's auto-committer (publish_content) has
# already returned, so if it doesn't commit its own output the episode is
# orphaned until some future Stop sweeps it (or never). Opt out:
# CARTOGRAPH_DRAFT_PUSH=0.
if [[ $rc -eq 0 && "${CARTOGRAPH_DRAFT_PUSH:-1}" != "0" ]]; then
  git add -- episodes 2>/dev/null || true
  if ! git diff --cached --quiet -- episodes 2>/dev/null; then
    git commit -q -m "content: auto-drafted episode from session ${slug}" \
      -- episodes 2>/dev/null || true
    git push origin main 2>/dev/null \
      || { git pull --rebase origin main 2>/dev/null \
           && git push origin main 2>/dev/null; }
    source "$(dirname "$0")/lib/notify-server.sh" 2>/dev/null && server_post /api/rebuild || true
  fi
fi
exit $rc
