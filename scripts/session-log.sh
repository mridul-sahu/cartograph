#!/usr/bin/env bash
# scripts/session-log.sh — append-only audit log of every Claude session
# under <cartograph-root>/, INCLUDING what cartograph content each
# session produced (episodes / research / papers / topics / bedrock).
#
# Three modes — chosen via the first arg:
#   start    — SessionStart hook: writes a new session file
#   touch    — PostToolUse hook: appends a tool-use line (with the file path)
#   stop     — Stop hook: closes out the session, derives the artifacts
#              list, commits + pushes the worknote AND any cartograph
#              content the session wrote, and rebuilds the static site
#
# Layout: sessions/<YYYY-MM>/<YYYY-MM-DD>-<HHMMSS>-<scope>.md
# Scope: 'fork-<repo>' when cwd is under workspace/<repo>/, else 'cartograph'.
#
# The PostToolUse hook receives JSON on stdin per Claude Code's hook
# contract; we lift `.tool_name` and `.tool_input.file_path` from it.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
SESSIONS_DIR="$CARTOGRAPH_ROOT/sessions"

# shellcheck source=lib/errors.sh
source "$(dirname "$0")/lib/errors.sh"

MODE="${1:-start}"
shift || true

CWD="$(pwd -P)"
if [[ "$CWD" == "$CARTOGRAPH_ROOT/workspace/"* ]]; then
  rest="${CWD#"$CARTOGRAPH_ROOT/workspace/"}"
  SCOPE="fork-${rest%%/*}"
elif [[ "$CWD" == "$CARTOGRAPH_ROOT"* ]]; then
  SCOPE="cartograph"
else
  exit 0
fi

session_path() {
  local id="$1"
  local month="${id:0:7}"
  local stamp="${id:0:10}-${id:11:8}"
  echo "$SESSIONS_DIR/$month/${stamp}-${SCOPE}.md"
}

# Classify a path (relative to cartograph root) into a cartograph layer.
# Empty output = not a cartograph artifact.
classify_artifact() {
  local p="$1"
  p="${p#"$CARTOGRAPH_ROOT"/}"
  case "$p" in
    episodes/*/*.md|episodes/*.md)                          echo "episode" ;;
    research/*/*.md)                                        echo "research" ;;
    papers/*/*/*.md)                                        echo "paper" ;;
    guides/*/topics/*.md)                                   echo "topic" ;;
    guides/*/overview.md|guides/*/architecture.md|guides/*/conventions.md) echo "bedrock" ;;
    guides/seams.md)                                        echo "seam" ;;
    learn/walkthroughs/*.md)                                echo "walkthrough" ;;
    learn/ramp-up/*.md)                                     echo "ramp-up" ;;
    learn/drafts/*.md)                                      echo "draft" ;;
    *)                                                      echo "" ;;
  esac
}

start_session() {
  local id log
  id="$(date -u +%Y-%m-%dT%H%M%S)"
  log="$(session_path "$id")"
  mkdir -p "$(dirname "$log")"
  [[ -f "$log" ]] && return 0
  cat > "$log" <<EOF
---
layer: session
session_id: $id
scope: $SCOPE
cwd: $CWD
started_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
ended_at: ~
edit_count: 0
artifact_count: 0
episode_written: ~
---

# session $id ($SCOPE)

## tool use log

EOF
  echo "$log" > "$SESSIONS_DIR/.current-session"
}

touch_session() {
  local log
  log="$(cat "$SESSIONS_DIR/.current-session" 2>/dev/null || echo "")"
  [[ -z "$log" || ! -f "$log" ]] && return 0

  # The PostToolUse hook hands us JSON on stdin. Lift the tool name and a
  # one-line "detail": a file path for Edit/Write, the URL for WebFetch,
  # the query for WebSearch. Capturing WebFetch/WebSearch is what lets the
  # Stop hook see that a session did external research worth a note.
  local payload tool detail
  payload="$(cat 2>/dev/null || true)"
  tool="tool"
  detail=""
  if [[ -n "$payload" ]] && command -v jq >/dev/null 2>&1; then
    tool="$(printf '%s' "$payload" | jq -r '.tool_name // "tool"' 2>/dev/null || echo tool)"
    detail="$(printf '%s' "$payload" \
      | jq -r '.tool_input.file_path // .tool_input.url // .tool_input.query // ""' \
        2>/dev/null || echo "")"
  fi

  local stamp
  stamp="$(date -u +%H:%M:%S)"
  if [[ -n "$detail" ]]; then
    echo "- ${stamp}  ${tool}  ${detail}" >> "$log"
  else
    echo "- ${stamp}  ${tool}" >> "$log"
  fi
}

stop_session() {
  local log
  log="$(cat "$SESSIONS_DIR/.current-session" 2>/dev/null || echo "")"
  [[ -z "$log" || ! -f "$log" ]] && return 0

  /usr/bin/sed -i.bak "s|^ended_at: .*|ended_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)|" "$log"
  rm -f "${log}.bak"

  # Count Edit/Write entries.
  local edits
  edits=$(grep -cE '^- [0-9:]+  (Edit|Write|NotebookEdit)' "$log" 2>/dev/null || echo 0)
  edits=${edits//[!0-9]/}
  /usr/bin/sed -i.bak "s|^edit_count: .*|edit_count: ${edits:-0}|" "$log"
  rm -f "${log}.bak"

  # Derive the artifacts list: every cartograph content file the session
  # wrote, deduplicated + classified. Append an "## artifacts produced"
  # section so the UI can show what this session churned out.
  local artifact_paths
  artifact_paths="$(grep -oE '(episodes|research|papers|guides|learn)/[a-zA-Z0-9_./-]+\.md' "$log" 2>/dev/null | sort -u || true)"

  local artifact_count=0
  if [[ -n "$artifact_paths" ]]; then
    {
      echo
      echo "## artifacts produced"
      echo
    } >> "$log"
    while IFS= read -r p; do
      [[ -z "$p" ]] && continue
      local kind
      kind="$(classify_artifact "$p")"
      [[ -z "$kind" ]] && continue
      echo "- ${kind}: ${p}" >> "$log"
      artifact_count=$((artifact_count + 1))
    done <<<"$artifact_paths"
  fi
  /usr/bin/sed -i.bak "s|^artifact_count: .*|artifact_count: ${artifact_count}|" "$log"
  rm -f "${log}.bak"

  # Episode-written detection: an episode file newer than the session log.
  local edits_num="${edits:-0}"
  if (( edits_num >= 3 )); then
    local today recent_episode
    today="$(date +%Y-%m-%d)"
    recent_episode=$(find "$CARTOGRAPH_ROOT/episodes" -name "${today}-*.md" -newer "$log" 2>/dev/null | head -1)
    if [[ -z "$recent_episode" ]]; then
      cat >> "$log" <<EOF

## hint at stop

This session did real work (>=3 edits) but no episode was written. If
anything was learned, consider \`/episode\` before closing the session.
EOF
    else
      /usr/bin/sed -i.bak "s|^episode_written: .*|episode_written: \"$(basename "$recent_episode")\"|" "$log"
      rm -f "${log}.bak"
    fi
  else
    /usr/bin/sed -i.bak "s|^episode_written: .*|episode_written: \"not-needed\"|" "$log"
    rm -f "${log}.bak"
  fi
  rm -f "$SESSIONS_DIR/.current-session"

  # Land the worknote on master so sessions/ never accrues uncommitted
  # files. Best-effort + fully subshell-isolated: a git failure (or a
  # workspace/<repo> cwd) can never break the Stop hook. The pathspec
  # commit form touches ONLY the worknote, so a concurrent agent's
  # staged index is never hijacked. Opt out with CARTOGRAPH_SESSION_PUSH=0.
  if [[ "${CARTOGRAPH_SESSION_PUSH:-1}" != "0" ]]; then
    (
      cd "$CARTOGRAPH_ROOT" || exit 0
      git commit -q -m "chore: session worknote $(basename "$log" .md)" \
        -- "$log" 2>/dev/null || exit 0
      git push origin main 2>/dev/null \
        || { git pull --rebase origin main 2>/dev/null \
             && git push origin main 2>/dev/null; }
    ) >/dev/null 2>&1 || true
  fi
}

# publish_content — runs on EVERY Stop hook (i.e. end of every turn),
# independent of the session worknote. stop_session() consumes
# .current-session and only its first call does real work; this does not
# depend on that, so content written in any turn is caught.
#
# If the turn left cartograph content uncommitted (a §4 inline note
# revision, a hand-written episode — Edit-tool writes that hit no API and
# so trigger no rebuild), commit it, push it, and rebuild the static site.
# State-free: it just asks git "is there uncommitted content?".
publish_content() {
  [[ "${CARTOGRAPH_SESSION_PUSH:-1}" == "0" ]] && return 0
  (
    cd "$CARTOGRAPH_ROOT" || exit 0
    # Anything modified / staged / untracked under the content dirs?
    if [[ -z "$(git status --porcelain -- guides episodes research papers learn 2>/dev/null)" ]]; then
      exit 0
    fi
    # Narrow add — only the content dirs, never the whole tree.
    git add -- guides episodes research papers learn 2>/dev/null || true
    if ! git diff --cached --quiet 2>/dev/null; then
      git commit -q -m "content: session-written cartograph updates" 2>/dev/null \
        || cg_log_error session-log "publish_content: git commit failed"
      git push origin main 2>/dev/null \
        || { git pull --rebase origin main 2>/dev/null \
             && git push origin main 2>/dev/null; } \
        || cg_log_error session-log "publish_content: git push failed (after pull-rebase retry)"
    fi
    # The turn changed content — refresh the static site regardless of
    # whether the commit found something stageable. session-log writes
    # run inside subshells with redirected output, so we don't surface
    # the notify-server warning here (it would clutter every session
    # commit). Failures are recorded in .cartograph/errors.log instead.
    curl -fsS -X POST --connect-timeout 1 http://127.0.0.1:47777/api/rebuild >/dev/null 2>&1 \
      || cg_log_error session-log "publish_content: rebuild POST to 127.0.0.1:47777 failed (server down?)"
  ) >/dev/null 2>&1 || true
}

case "$MODE" in
  start) start_session ;;
  touch) touch_session ;;
  # Stop fires every turn: finalize the worknote (real work only on the
  # first call — it consumes .current-session) AND publish any content the
  # turn wrote (state-free, so every turn is covered).
  stop)  stop_session; publish_content ;;
  *) echo "usage: $0 start|touch|stop" >&2; exit 2 ;;
esac
