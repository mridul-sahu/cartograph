#!/usr/bin/env bash
# scripts/maintenance.sh — the nightly maintenance entrypoint (also safe to
# run by hand). One sequential pass that:
#
#   a. resolves open drift via drift-drain.sh — repo-level reports through
#      auto-revise.sh, per-topic through drift-fix.sh, every claude call
#      under the cg_headless_run cap;
#   b. runs the content lint and records hard failures;
#   c. re-runs the anchor-coverage audit and enqueues an anchor-fix curation
#      task per gapped topic;
#   d. drains the curation queue once (one batched headless agent);
#   e. archives sessions older than the retention window;
#   f. appends a one-line summary to .cartograph/maintenance.log.
#
# Every step is best-effort: a failure is logged to errors.log via
# lib/errors.sh and the pass moves on. Scheduled via launchd
# (com.cartograph.maintenance, see scripts/setup-launchd.sh).

set -uo pipefail

# shellcheck source=lib/headless.sh
source "$(dirname "$0")/lib/headless.sh"   # also sets CARTOGRAPH_ROOT
# shellcheck source=lib/errors.sh
source "$(dirname "$0")/lib/errors.sh"
# shellcheck source=lib/serve-control.sh
source "$(dirname "$0")/lib/serve-control.sh"

cg_autospawn_guard   # never run from inside a headless agent / kill switch on

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$CARTOGRAPH_ROOT/.cartograph"
MAINT_LOG="$STATE_DIR/maintenance.log"

drift_repos=0
drift_topics=0
lint_status="ok"
anchors_enqueued=0
drain_rc=0
archived=0

# ── a. drift resolution ─────────────────────────────────────────────────
# One drift-drain pass: repo-level reports via auto-revise.sh, per-topic via
# drift-fix.sh — same path the serve.py drift loop uses. The drain stops
# early when the headless cap defers; whatever remains retries next pass.
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

# ── c. anchor-coverage audit → enqueue anchor-fix tasks ─────────────────
coverage_json="$STATE_DIR/state/anchor-coverage.json"
if python3 "$SCRIPTS/anchor-coverage.py" >/dev/null 2>&1; then
  while IFS=$'\t' read -r repo slug; do
    [[ -n "$repo" && -n "$slug" ]] || continue
    if bash "$SCRIPTS/curate.sh" enqueue anchor "$repo" "$slug"; then
      anchors_enqueued=$((anchors_enqueued + 1))
    else
      cg_log_error maintenance "enqueue anchor $repo/$slug failed"
    fi
  done < <(python3 - "$coverage_json" <<'PY' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for repo, gaps in (d.get("gaps_by_repo") or {}).items():
    for g in gaps:
        slug = g.get("slug") or ""
        if slug:
            print("%s\t%s" % (repo, slug))
PY
)
else
  cg_log_error maintenance "anchor-coverage.py failed"
fi

# ── c2. enqueue pending notes for auto-review ───────────────────────────
review_out="$(bash "$SCRIPTS/auto-review-scan.sh" 2>&1)" \
  || cg_log_error maintenance "auto-review-scan failed"
reviews_enqueued="$(printf '%s\n' "$review_out" | grep -oE 'enqueued [0-9]+' | grep -oE '[0-9]+' | head -1)"
reviews_enqueued="${reviews_enqueued:-0}"

# ── d. drain the curation queue (one batched headless agent) ────────────
bash "$SCRIPTS/curate.sh" drain || drain_rc=$?
if (( drain_rc != 0 )); then
  cg_log_error maintenance "curate drain exited rc=$drain_rc"
fi

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
summary="drift_repos=$drift_repos drift_topics=$drift_topics lint=$lint_status anchors_enqueued=$anchors_enqueued reviews_enqueued=$reviews_enqueued drain_rc=$drain_rc archived=$archived serve_healed=$serve_healed"
printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$summary" >> "$MAINT_LOG" 2>/dev/null \
  || cg_log_error maintenance "could not write maintenance.log"
echo "maintenance: $summary"
