#!/usr/bin/env bash
# scripts/maintenance.sh — the nightly maintenance entrypoint (also safe to
# run by hand). Fully deterministic: git, python, and file bookkeeping only.
# No claude is ever spawned here. One sequential pass that:
#
#   a. runs the deterministic drift pass via drift-drain.sh (re-detect +
#      mechanical re-anchor; surviving reports wait for an active session);
#   b. runs the content lint and records hard failures;
#   c. re-runs the anchor-coverage audit (gaps surface in /queue);
#   d. writes today's diary entry if stale;
#   e. archives sessions older than the retention window;
#   f. appends a one-line summary to .cartograph/maintenance.log.
#
# Every step is best-effort: a failure is logged to errors.log via
# lib/errors.sh and the pass moves on. Run daily by the serve daemon's
# maintenance loop (serve.py) when the last pass is >24h old; safe to
# run by hand any time.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# shellcheck source=lib/errors.sh
source "$(dirname "$0")/lib/errors.sh"
# shellcheck source=lib/serve-control.sh
source "$(dirname "$0")/lib/serve-control.sh"

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$CARTOGRAPH_ROOT/.cartograph"
MAINT_LOG="$STATE_DIR/maintenance.log"

drift_repos=0
drift_topics=0
lint_status="ok"
archived=0

# ── a. drift resolution ─────────────────────────────────────────────────
# One deterministic drift-drain pass (git + python, no tokens) — same path
# the serve.py drift loop uses. Reports that survive need judgment and
# wait for an active session.
drift_out="$(bash "$SCRIPTS/drift-drain.sh" drain)" \
  || cg_log_error maintenance "drift-drain failed"
printf '%s\n' "$drift_out"
drift_summary="$(printf '%s\n' "$drift_out" | grep -E '^drift-drain: repos=' | tail -1)"
drift_repos="$(printf '%s' "$drift_summary" | grep -oE 'repos=[0-9]+' | grep -oE '[0-9]+')"
drift_topics="$(printf '%s' "$drift_summary" | grep -oE 'topics=[0-9]+' | grep -oE '[0-9]+')"
drift_repos="${drift_repos:-0}"
drift_topics="${drift_topics:-0}"

# ── b. content lint ─────────────────────────────────────────────────────
lint_out="$(bash "$SCRIPTS/lint-content.sh" 2>/dev/null)" || {
  lint_status="fail"
  lint_summary="$(printf '%s' "$lint_out" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print("hard_fails=%s soft_warns=%s" % (d.get("hard_fails"), d.get("soft_warns")))
except Exception:
    print("unparseable lint output")
' 2>/dev/null || echo "unparseable lint output")"
  cg_log_error maintenance "lint-content hard failures: $lint_summary"
}

# ── b2. curation agenda — deterministic sleep-time analysis ─────────────
# Near-dup pairs, decay candidates, coverage gaps, open contradictions.
# Zero tokens; the orientation injection surfaces the results to the next
# active session.
python3 "$SCRIPTS/curation-agenda.py" >/dev/null 2>&1 \
  || cg_log_error maintenance "curation-agenda.py failed"

# ── c. anchor-coverage audit ────────────────────────────────────────────
# Deterministic audit only: coverage gaps surface in /queue for the active
# session, where anchor fixes happen in-session.
python3 "$SCRIPTS/anchor-coverage.py" >/dev/null 2>&1 \
  || cg_log_error maintenance "anchor-coverage.py failed"

# ── d. diary ────────────────────────────────────────────────────────────
# Once per calendar day; moved here from SessionStart (a daily pass is the
# natural home for a daily digest).
bash "$SCRIPTS/diary.sh" --if-stale >/dev/null 2>&1 \
  || cg_log_error maintenance "diary.sh failed"

# ── e. archive old sessions ─────────────────────────────────────────────
archive_out="$(bash "$SCRIPTS/archive-sessions.sh" 2>/dev/null)" \
  || cg_log_error maintenance "archive-sessions failed"
archived="$(printf '%s\n' "$archive_out" | grep -oE 'archived [0-9]+' | grep -oE '[0-9]+' | head -1)"
archived="${archived:-0}"

# ── e2. supervision self-heal ───────────────────────────────────────────
# Repair launchd drift (orphan holding the port, or server down) so the
# nightly pass is a guaranteed recovery point even if no session ran.
heal_out="$(cg_serve_heal 2>&1)" || cg_log_error maintenance "serve-heal failed"
serve_healed=0
[[ -n "$heal_out" ]] && serve_healed=1
[[ -n "$heal_out" ]] && printf '%s\n' "$heal_out"

# ── f. summary ──────────────────────────────────────────────────────────
mkdir -p "$STATE_DIR"
summary="drift_repos=$drift_repos drift_topics=$drift_topics lint=$lint_status archived=$archived serve_healed=$serve_healed"
printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$summary" >> "$MAINT_LOG" 2>/dev/null \
  || cg_log_error maintenance "could not write maintenance.log"
echo "maintenance: $summary"
