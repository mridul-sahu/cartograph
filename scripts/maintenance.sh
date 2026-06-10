#!/usr/bin/env bash
# scripts/maintenance.sh — the nightly maintenance entrypoint (also safe to
# run by hand). One sequential pass that:
#
#   a. resolves open drift — repo-level reports via auto-revise.sh, per-topic
#      reports via drift-fix.sh — one at a time (auto-revise routes its
#      claude call through cg_headless_run; drift-fix is synchronous);
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

cg_autospawn_guard   # never run from inside a headless agent / kill switch on

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
DRIFT_DIR="$CARTOGRAPH_ROOT/.drift-reports"
STATE_DIR="$CARTOGRAPH_ROOT/.cartograph"
MAINT_LOG="$STATE_DIR/maintenance.log"

drift_repos=0
drift_topics=0
lint_status="ok"
anchors_enqueued=0
drain_rc=0
archived=0

# ── a. drift resolution ─────────────────────────────────────────────────
# Repo-level drift reports → auto-revise.sh, one repo at a time.
for report in "$DRIFT_DIR"/*.md; do
  [[ -f "$report" ]] || continue
  repo="$(basename "${report%.md}")"
  echo "maintenance: auto-revise drift for '$repo'"
  rc=0
  bash "$SCRIPTS/auto-revise.sh" "$repo" || rc=$?
  if (( rc != 0 )); then
    cg_log_error maintenance "auto-revise $repo failed (rc=$rc)"
  fi
  drift_repos=$((drift_repos + 1))
done

# Per-topic drift reports (.drift-reports/topics/<repo>/<slug>.md) →
# drift-fix.sh <repo> <slug>, sequentially.
if [[ -d "$DRIFT_DIR/topics" ]]; then
  while IFS= read -r report; do
    repo="$(basename "$(dirname "$report")")"
    slug="$(basename "${report%.md}")"
    echo "maintenance: drift-fix topic '$repo/$slug'"
    rc=0
    bash "$SCRIPTS/drift-fix.sh" "$repo" "$slug" || rc=$?
    if (( rc != 0 )); then
      cg_log_error maintenance "drift-fix $repo/$slug failed (rc=$rc)"
    fi
    drift_topics=$((drift_topics + 1))
  done < <(find "$DRIFT_DIR/topics" -mindepth 2 -maxdepth 2 -name '*.md' -type f 2>/dev/null | sort)
fi

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

# ── f. summary ──────────────────────────────────────────────────────────
mkdir -p "$STATE_DIR"
summary="drift_repos=$drift_repos drift_topics=$drift_topics lint=$lint_status anchors_enqueued=$anchors_enqueued drain_rc=$drain_rc archived=$archived"
printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$summary" >> "$MAINT_LOG" 2>/dev/null \
  || cg_log_error maintenance "could not write maintenance.log"
echo "maintenance: $summary"
