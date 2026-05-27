#!/usr/bin/env bash
# Stop hook: when a Claude session ended with knowledge worth keeping,
# auto-draft it in the background via `claude -p`. Two independent drafts:
#   - an EPISODE, if the session did real work (≥threshold edits);
#   - RESEARCH / PAPER notes, if the session consulted external material
#     (WebFetch / WebSearch) — drafted by session-to-research.sh.
# This is the load-bearing "cartograph compounds with each interaction"
# property — we don't rely on claude remembering to write things up; we
# draft them and let the user review.
#
# Behaviour:
#   1. Detects the just-finished session via $CARTOGRAPH_ROOT/sessions/.current-session
#   2. If the session log shows ≥CARTOGRAPH_AUTO_EPISODE_THRESHOLD edits
#      (default 3) AND no episode file appeared dated today AND no
#      episode is already linked from the session frontmatter, fires a
#      BACKGROUND `claude -p` invocation against the session log to draft
#      an episode. The Stop hook itself returns immediately so it doesn't
#      block the user.
#   3. The drafted episode is written with `auto_drafted: true` in
#      frontmatter so the UI can surface it as "pending review."
#
# Opt out via env: CARTOGRAPH_AUTO_EPISODE=0
# Tune threshold: CARTOGRAPH_AUTO_EPISODE_THRESHOLD=5
#
# Still emits a hint to Claude via stdout so the CURRENT claude (the one
# being stopped) also sees the prompt — covers the case where Claude is
# stopping mid-task and could write the episode itself.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
WORKSPACE="$CARTOGRAPH_ROOT/workspace"
EPISODES="$CARTOGRAPH_ROOT/episodes"
SESSIONS_DIR="$CARTOGRAPH_ROOT/sessions"

# Drain stdin (hook contract) — we don't read it but Claude Code expects us to consume it.
cat 2>/dev/null >/dev/null || true

CWD="$(pwd -P)"
WORKSPACE_REAL="$(cd "$WORKSPACE" 2>/dev/null && pwd -P || echo "$WORKSPACE")"

# Only act inside a fork directory.
if [[ "$CWD" != "$WORKSPACE_REAL"/* ]]; then
  exit 0
fi
REL="${CWD#$WORKSPACE_REAL/}"
REPO="${REL%%/*}"

today="$(date +%Y-%m-%d)"
month="$(date +%Y-%m)"

# Has an episode already been written today for this repo?
episode_today="$(find "$EPISODES/$month" -type f -name "${today}-${REPO}-*.md" 2>/dev/null | head -1 || true)"

# Find the just-finished session log (pointer file dropped by session-log.sh).
session_log=""
if [[ -f "$SESSIONS_DIR/.current-session" ]]; then
  session_log="$(cat "$SESSIONS_DIR/.current-session" 2>/dev/null || true)"
fi
# Fallback: most recent .md in this month's sessions/ if the pointer is gone.
if [[ -z "$session_log" || ! -f "$session_log" ]]; then
  session_log="$(ls -t "$SESSIONS_DIR/$month"/*.md 2>/dev/null | head -1 || true)"
fi

# Count edits in the session log to decide if it merits an auto-draft.
edits=0
reads_count=0
whatknows_calls=0
if [[ -f "$session_log" ]]; then
  edits=$(grep -cE '^- [0-9:]+ {2}(Edit|Write|NotebookEdit)' "$session_log" 2>/dev/null || echo 0)
  edits=${edits//[!0-9]/}
  reads_count=$(grep -cE '^- [0-9:]+ {2}Read' "$session_log" 2>/dev/null || echo 0)
  reads_count=${reads_count//[!0-9]/}
  # /whatknows invocations show up either as the slash itself or as a
  # Bash call to /api/whatknows. Either signals the §1a discipline was
  # exercised at least once this session.
  whatknows_calls=$(grep -cE '/whatknows |/api/whatknows' "$session_log" 2>/dev/null || echo 0)
  whatknows_calls=${whatknows_calls//[!0-9]/}
fi

# Count topics flagged for revision-pending this session — a coarse
# proxy for "your edits hit cited code; the §4 revision discipline is
# now owed."
revisions_pending=0
rev_path="$CARTOGRAPH_ROOT/.cartograph/state/topic-revisions-pending.json"
if [[ -f "$rev_path" ]]; then
  revisions_pending=$(python3 -c "
import json
try: print(len(json.load(open('$rev_path'))))
except Exception: print(0)
" 2>/dev/null || echo 0)
fi

# Auto-drafted episodes from prior sessions that are still unblessed.
# These are the 'curate me' obligation — auto-draft is consumption-free
# only if it actually flows into approved knowledge.
unblessed_auto_drafts=0
if [[ -d "$CARTOGRAPH_ROOT/episodes" ]]; then
  unblessed_auto_drafts=$(grep -lrE '^auto_drafted:[[:space:]]*true' "$CARTOGRAPH_ROOT/episodes" 2>/dev/null \
    | xargs -I {} grep -L 'reviewed_by_human:[[:space:]]*[^~[:space:]]' {} 2>/dev/null \
    | xargs -I {} grep -L '^rejected:[[:space:]]*true' {} 2>/dev/null \
    | wc -l | tr -d ' ')
fi

threshold="${CARTOGRAPH_AUTO_EPISODE_THRESHOLD:-3}"
auto="${CARTOGRAPH_AUTO_EPISODE:-1}"

# ── Discipline scorecard ────────────────────────────────────────────────
# Emit whenever the session touched workspace code, regardless of
# whether the auto-draft branch below also fires. The scorecard exists
# to make the discipline gap visible to the current claude session —
# even sessions below the auto-draft threshold can have violated §1a
# (edit without /whatknows) or §4 (cited file moved, topic not revised).
if (( edits > 0 )); then
  # Compose the rows. A row's status mark is ✓ when discipline was
  # met, ⚠ for soft warnings, ✗ for hard-rule violations.
  whatknows_mark="✓"
  whatknows_note=""
  if (( whatknows_calls == 0 )); then
    whatknows_mark="✗"
    whatknows_note="    HARD RULE §1a — /whatknows on every workspace path BEFORE Read/Edit."
  fi
  rev_mark="✓"
  rev_note=""
  if (( revisions_pending > 0 )); then
    rev_mark="⚠"
    rev_note="    queued at /console/review/ ('Topics whose cited files moved'). HARD RULE §4."
  fi
  draft_mark="✓"
  draft_note=""
  if (( unblessed_auto_drafts > 0 )); then
    draft_mark="⚠"
    draft_note="    review at /console/review/ — auto-draft ≠ curated."
  fi
  cat <<EOF
[cartograph-stop-hook] · ${today} discipline scorecard
  ✓ edits this session              ${edits}
  ${whatknows_mark} /whatknows invocations         ${whatknows_calls}
${whatknows_note}
  ${rev_mark} topics needing revision         ${revisions_pending}
${rev_note}
  ${draft_mark} unblessed auto-drafted episodes  ${unblessed_auto_drafts}
${draft_note}
Any ✗ or ⚠ row is work owed before the next session.
EOF
fi

# Episode and research auto-drafts are INDEPENDENT decisions — a session
# can be below the edit threshold yet still have done real external
# research, and vice versa. Neither short-circuits the other.

# ── Episode auto-draft ──────────────────────────────────────────────────
# Real work (≥threshold edits) + no episode today → hint the current
# claude, then background-draft an episode from the session log.
if [[ -z "$episode_today" ]] && (( edits >= threshold )) && [[ -f "$session_log" ]]; then
  cat <<EOF
[cartograph-stop-hook]
This session touched ${edits} file(s) under workspace/${REPO}/ and no
episode has been written for ${today}. If you learned something durable,
write a brief episode now (200-600 words) to:
  cartograph/episodes/${month}/${today}-${REPO}-<slug>.md

If you don't write one, cartograph will auto-draft one in the background
from the session log at ${session_log} for you to review later.
EOF
  if [[ "$auto" == "1" ]]; then
    slug="$(basename "$session_log" .md)"
    marker="$SESSIONS_DIR/.auto-draft-${slug}.lock"
    if [[ ! -f "$marker" ]]; then
      touch "$marker"
      log_file="${TMPDIR:-/tmp}/cartograph-auto-episode-${slug}.log"
      nohup env CARTOGRAPH_AUTO_DRAFTED=1 \
        bash "$CARTOGRAPH_ROOT/scripts/session-to-episode.sh" "$slug" \
        > "$log_file" 2>&1 &
      disown $! 2>/dev/null || true
      ( sleep 600 && rm -f "$marker" ) &
      disown $! 2>/dev/null || true
    fi
  fi
fi

# ── Research / paper auto-draft ──────────────────────────────────────────
# If the session consulted external material — the WebFetch URLs /
# WebSearch queries the session-log hook records — and wrote no
# research/paper note itself, background-draft one. session-to-research.sh
# curates: it writes nothing if the fetches were incidental. This is what
# makes papers / research flow into cartograph automatically, not only
# episodes. Opt out: CARTOGRAPH_AUTO_RESEARCH=0.
research_signals=0
if [[ -f "$session_log" ]]; then
  research_signals=$(grep -cE '^- [0-9:]+ {2}(WebFetch|WebSearch)\b' "$session_log" 2>/dev/null || echo 0)
  research_signals=${research_signals//[!0-9]/}
fi
research_threshold="${CARTOGRAPH_AUTO_RESEARCH_THRESHOLD:-2}"
auto_research="${CARTOGRAPH_AUTO_RESEARCH:-1}"
research_written=""
if [[ -f "$session_log" ]]; then
  research_written="$(find "$CARTOGRAPH_ROOT/research/$REPO" "$CARTOGRAPH_ROOT/papers/$REPO" \
    -name '*.md' -newer "$session_log" 2>/dev/null | head -1 || true)"
fi
if [[ "$auto_research" == "1" && -z "$research_written" && -f "$session_log" ]] \
   && (( research_signals >= research_threshold )); then
  slug="$(basename "$session_log" .md)"
  marker="$SESSIONS_DIR/.auto-research-${slug}.lock"
  if [[ ! -f "$marker" ]]; then
    touch "$marker"
    rlog="${TMPDIR:-/tmp}/cartograph-auto-research-${slug}.log"
    nohup env CARTOGRAPH_AUTO_DRAFTED=1 \
      bash "$CARTOGRAPH_ROOT/scripts/session-to-research.sh" "$slug" \
      > "$rlog" 2>&1 &
    disown $! 2>/dev/null || true
    ( sleep 600 && rm -f "$marker" ) &
    disown $! 2>/dev/null || true
  fi
fi

exit 0
