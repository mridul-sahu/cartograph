#!/usr/bin/env bash
# scripts/session-to-research.sh — invoke claude -p to draft research notes
# (and paper notes, when a real paper was central) from a session log.
#
# Usage: scripts/session-to-research.sh <session-slug>
#
# The companion of session-to-episode.sh: where that captures "what the
# session DID", this captures "what external material the session
# CONSULTED" — the WebFetch URLs / WebSearch queries the session-log hook
# recorded. Spawned in the background from the Stop hook (episode-prompt.sh)
# when a session did external research but wrote no research note itself.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
slug="${1:?usage: $0 <session-slug>}"

if [[ "$slug" =~ \.\. ]] || [[ "$slug" =~ / ]]; then
  echo "invalid slug" >&2
  exit 2
fi

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

# shellcheck source=lib/headless.sh
source "$(dirname "$0")/lib/headless.sh"

scope="$(grep -E '^scope:' "$log" | head -1 | sed -E 's/^scope:[[:space:]]*//')"
repo=""
case "$scope" in
  fork-*) repo="${scope#fork-}" ;;
esac
today="$(date +%Y-%m-%d)"
auto_drafted="${CARTOGRAPH_AUTO_DRAFTED:-0}"

prompt_file="$(mktemp -t cartograph-session-research.XXXXXX)"
{
  echo "You are drafting Cartograph research/paper notes from a session log."
  echo
  echo "## The session log"
  echo
  cat "$log"
  echo
  echo
  echo "## Your task"
  echo
  echo "The tool-use log above includes WebFetch / WebSearch lines — the"
  echo "external material this session consulted (arXiv papers, RFCs, docs,"
  echo "comparisons). Capture what is worth keeping:"
  echo
  echo "1. FIRST read the existing notes so you don't duplicate:"
  if [[ -n "$repo" ]]; then
    echo "     ls research/$repo/ ; ls papers/$repo/"
  else
    echo "     ls research/ ; ls papers/"
  fi
  echo "   If an existing research note already covers the topic, UPDATE it"
  echo "   in place (bump last_revised) instead of writing a new one."
  echo
  echo "2. For genuine exploration / comparison / design rationale, draft a"
  if [[ -n "$repo" ]]; then
    echo "   research note at research/$repo/<slug>.md. Frontmatter:"
  else
    echo "   research note at research/<repo>/<slug>.md. Frontmatter:"
  fi
  echo "     ---"
  echo "     layer: research"
  [[ -n "$repo" ]] && echo "     repo: $repo"
  echo "     last_revised: $today"
  echo "     sources: [<the URLs / papers consulted>]"
  echo "     tags: [...]"
  [[ "$auto_drafted" == "1" ]] && echo "     auto_drafted: true"
  echo "     ---"
  echo
  echo "3. If a genuine academic paper (arXiv / a conference paper) was"
  echo "   CENTRAL to the session, also draft a paper note at"
  if [[ -n "$repo" ]]; then
    echo "   papers/$repo/<paper-slug>/notes.md — match the format of an"
  else
    echo "   papers/<repo>/<paper-slug>/notes.md — match the format of an"
  fi
  echo "   existing papers/*/notes.md (title, authors, year, summary, and a"
  echo "   'how we used it' section). Do NOT fabricate a PDF."
  echo
  echo "## Constraints — this is curation, not accumulation"
  echo
  echo "- If the session's external fetches were incidental (a quick doc"
  echo "  lookup, nothing synthesised), write NOTHING and exit. A note that"
  echo "  isn't worth reading later should not exist."
  echo "- Don't invent. Every claim traces to the consulted material or the"
  echo "  code. Record exact URLs in 'sources:'."
  echo "- Cross-reference related topic notes / bedrock where relevant."
  echo "- Print a one-line summary of what you wrote (or why you wrote"
  echo "  nothing)."
  echo
  echo "Begin."
} > "$prompt_file"

flags="${CARTOGRAPH_S2R_CLAUDE_FLAGS:---print --output-format text --permission-mode acceptEdits --allowedTools Read,Edit,Write,Glob,Grep,Bash}"
cd "$CARTOGRAPH_ROOT"
echo "session-to-research: invoking claude -p for session $slug (log: $log)"
cg_headless_run "research:$slug" -- $flags < "$prompt_file"
rc=$?
rm -f "$prompt_file"

# Commit the draft. This script runs DETACHED from the Stop hook — it
# finishes minutes after the hook's auto-committer (publish_content) has
# already returned, so it must commit its own output or the research /
# paper note is orphaned until some future Stop (or never). Opt out:
# CARTOGRAPH_DRAFT_PUSH=0.
if [[ $rc -eq 0 && "${CARTOGRAPH_DRAFT_PUSH:-1}" != "0" ]]; then
  git add -- research papers 2>/dev/null || true
  if ! git diff --cached --quiet -- research papers 2>/dev/null; then
    git commit -q -m "content: auto-drafted research/paper notes from session ${slug}" \
      -- research papers 2>/dev/null || true
    git push origin main 2>/dev/null \
      || { git pull --rebase origin main 2>/dev/null \
           && git push origin main 2>/dev/null; }
    source "$(dirname "$0")/lib/notify-server.sh" 2>/dev/null && server_post /api/rebuild || true
  fi
fi
exit $rc
