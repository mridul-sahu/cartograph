#!/usr/bin/env bash
# Stop hook: reminders only — no background drafting, no claude spawns.
# The session that holds the context writes its own notes; this hook just
# makes the obligation visible at Stop:
#   - the discipline scorecard (edits vs /whatknows, pending revisions,
#     unblessed drafts, the drift-resolution contract);
#   - an EPISODE reminder when the session did real work (≥threshold
#     edits, default 3) and no episode exists for today;
#   - a RESEARCH-note reminder when the session consulted external
#     material (WebFetch / WebSearch) and wrote nothing down.
#
# Tune the episode threshold: CARTOGRAPH_AUTO_EPISODE_THRESHOLD=5

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
WORKSPACE="$CARTOGRAPH_ROOT/workspace"
EPISODES="$CARTOGRAPH_ROOT/episodes"
SESSIONS_DIR="$CARTOGRAPH_ROOT/sessions"

# Drain stdin (hook contract) — we don't read it but Claude Code expects us to consume it.
cat 2>/dev/null >/dev/null || true

# shellcheck source=lib/errors.sh
source "$(dirname "$0")/lib/errors.sh"
# Inside a headless session (eval harness) the reminder is noise; skip.
[[ "${CARTOGRAPH_HEADLESS:-0}" == "1" ]] && exit 0

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

# Distillation debt for this repo: tags over the promotion threshold.
# Promotion is automatic — this session was expected to distill them.
distill_debt=0
_dc="$CARTOGRAPH_ROOT/.cartograph/state/digest-cache"
if [[ -f "$_dc" ]]; then
  distill_debt=$(grep -c "repo=$REPO " "$_dc" 2>/dev/null || echo 0)
  distill_debt=${distill_debt//[!0-9]/}
fi

threshold="${CARTOGRAPH_AUTO_EPISODE_THRESHOLD:-3}"

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
  distill_mark="✓"
  distill_note=""
  if (( distill_debt > 0 )); then
    distill_mark="✗"
    distill_note="    HARD RULE §6 — promotion is automatic: run the /promote procedure for these tags NOW, before ending."
  fi
  # Curation-contract grade: compare the drift reports open at session
  # start (snapshot from session-start.sh) with what is open now. A
  # report gone from the snapshot was resolved this session; the rest
  # carry to the next session's contract.
  drift_resolved=0
  drift_carried=0
  drift_snap="$CARTOGRAPH_ROOT/.cartograph/state/drift-snapshot-$REPO"
  if [[ -f "$drift_snap" ]]; then
    while IFS= read -r entry; do
      [[ -n "$entry" ]] || continue
      if [[ "$entry" == "__bedrock__" ]]; then
        open_now="$CARTOGRAPH_ROOT/.drift-reports/$REPO.md"
      else
        open_now="$CARTOGRAPH_ROOT/.drift-reports/topics/$REPO/$entry"
      fi
      if [[ -f "$open_now" ]]; then
        drift_carried=$((drift_carried + 1))
      else
        drift_resolved=$((drift_resolved + 1))
      fi
    done < "$drift_snap"
  fi
  drift_mark="✓"
  drift_note=""
  if (( drift_carried > 0 && drift_resolved == 0 )); then
    drift_mark="⚠"
    drift_note="    contract unmet — resolve at least one next session (they carry over)."
  fi
  cat <<EOF
[cartograph-stop-hook] · ${today} discipline scorecard
  ✓ edits this session              ${edits}
  ${whatknows_mark} /whatknows invocations         ${whatknows_calls}
${whatknows_note}
  ${rev_mark} topics needing revision         ${revisions_pending}
${rev_note}
  ${distill_mark} distillation contract (this repo) ${distill_debt} tag(s) over threshold
${distill_note}
  ${drift_mark} curation contract               resolved ${drift_resolved}, carried ${drift_carried}
${drift_note}
Any ✗ or ⚠ row is work owed before the next session.
EOF
fi

# Episode and research reminders are INDEPENDENT — a session can be below
# the edit threshold yet still have done real external research, and vice
# versa. Neither short-circuits the other. Nothing drafts in the
# background: this session holds the context, so it writes the note.

# ── Episode reminder ────────────────────────────────────────────────────
if [[ -z "$episode_today" ]] && (( edits >= threshold )) && [[ -f "$session_log" ]]; then
  cat <<EOF
[cartograph-stop-hook]
This session touched ${edits} file(s) under workspace/${REPO}/ and no
episode has been written for ${today}. If you learned something durable,
write a brief episode now (200-600 words, or /episode <title>) to:
  cartograph/episodes/${month}/${today}-${REPO}-<slug>.md
Nothing will draft this for you later — this session holds the context.

EOF
fi

# ── Research-note reminder ──────────────────────────────────────────────
# External material consulted (WebFetch / WebSearch in the session log)
# but no research/paper note written → remind, don't draft.
research_signals=0
if [[ -f "$session_log" ]]; then
  research_signals=$(grep -cE '^- [0-9:]+ {2}(WebFetch|WebSearch)\b' "$session_log" 2>/dev/null || echo 0)
  research_signals=${research_signals//[!0-9]/}
fi
research_threshold="${CARTOGRAPH_AUTO_RESEARCH_THRESHOLD:-2}"
research_written=""
if [[ -f "$session_log" ]]; then
  research_written="$(find "$CARTOGRAPH_ROOT/research/$REPO" "$CARTOGRAPH_ROOT/papers/$REPO" \
    -name '*.md' -newer "$session_log" 2>/dev/null | head -1 || true)"
fi
if [[ -z "$research_written" && -f "$session_log" ]] \
   && (( research_signals >= research_threshold )); then
  cat <<EOF
[cartograph-stop-hook]
This session consulted external material (${research_signals} WebFetch/WebSearch
calls) and no research or paper note was written. If any of it is worth
keeping, file it now via /research ${REPO} <slug> or /paper ${REPO} <slug>.

EOF
fi

exit 0
