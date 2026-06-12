#!/usr/bin/env bash
# scripts/drift-fix.sh — hand a per-topic drift report to claude -p,
# revises the topic in place where claims contradict current code,
# otherwise bumps last_revised. Writes status JSON to
# .cartograph/jobs/drift-<repo>-<slug>.json for poll-based UIs.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
# shellcheck source=lib/headless.sh
source "$(dirname "$0")/lib/headless.sh"
repo="${1:?usage: $0 <repo> <slug>}"
slug="${2:?usage: $0 <repo> <slug>}"

topic_rel="guides/$repo/topics/$slug.md"
report_rel=".drift-reports/topics/$repo/$slug.md"
topic_abs="$CARTOGRAPH_ROOT/$topic_rel"
report_abs="$CARTOGRAPH_ROOT/$report_rel"

jobs_dir="$CARTOGRAPH_ROOT/.cartograph/jobs"
mkdir -p "$jobs_dir"
status_path="$jobs_dir/drift-$repo-$slug.json"

started_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_epoch="$(date +%s)"

emit_done() {
  # See review-opinion.sh: trailing FOO=bar after `python3 -c` are
  # sys.argv, NOT env vars. The old env-var form crashed silently.
  python3 - "$1" "$started_iso" "$started_epoch" <<'PY' > "$status_path.tmp" && mv "$status_path.tmp" "$status_path"
import json, sys, time
try: d = json.loads(sys.argv[1])
except Exception: d = {"raw": True}
d["status"] = "done"
d["started_at"] = sys.argv[2]
d["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
d["elapsed_secs"] = int(time.time()) - int(sys.argv[3])
print(json.dumps(d))
PY
  cat "$status_path"
}

# Cap reached / kill switch on: not a failure — the report stays and a later
# pass retries. Distinct status so poll-based UIs don't show a scary error.
emit_deferred() {
  python3 - "$started_iso" "$1" "$started_epoch" <<'PY' > "$status_path.tmp" && mv "$status_path.tmp" "$status_path"
import json, sys, time
print(json.dumps({
    "status": "deferred", "detail": sys.argv[2],
    "started_at": sys.argv[1],
    "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "elapsed_secs": int(time.time()) - int(sys.argv[3]),
}))
PY
  cat "$status_path"
  exit 75
}

emit_error() {
  python3 - "$started_iso" "$1" "$started_epoch" <<'PY' > "$status_path.tmp" && mv "$status_path.tmp" "$status_path"
import json, sys, time
print(json.dumps({
    "status": "error", "error": sys.argv[2],
    "started_at": sys.argv[1],
    "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "elapsed_secs": int(time.time()) - int(sys.argv[3]),
}))
PY
  cat "$status_path"
  exit 0
}

python3 - "$started_iso" "$$" <<'PY' > "$status_path.tmp" && mv "$status_path.tmp" "$status_path"
import json, sys
print(json.dumps({"status": "running", "started_at": sys.argv[1], "pid": int(sys.argv[2])}))
PY

if [[ ! -f "$topic_abs" ]]; then emit_error "topic not found: $topic_rel"; fi
if [[ ! -f "$report_abs" ]]; then
  emit_done '{"action":"no-op","sections_changed":0,"summary":"no drift report — nothing to fix"}'
  exit 0
fi

tmp="$(mktemp -t cartograph-drift-fix.XXXXXX)"
trap 'rm -f "$tmp"' EXIT

{
  cat <<'PROMPT_HEADER'
You are resolving per-citation drift in a Cartograph topic note.

PROCEDURE
1. Read the drift report — it lists each flagged citation.
2. Read the topic note.
3. For each flagged citation: read the upstream file at the cited line
   range. Compare code to topic claim.
   - Holds (additive / refactor that preserved semantics): update line
     number if moved, keep prose.
   - Contradicted (semantics changed, function renamed/removed):
     revise the topic's section in place.
4. Bump `last_revised:` to today's date.
5. Output ONE line of JSON:
   {"action":"revised"|"bumped-only","sections_changed":<int>,"summary":"<one sentence>"}

PROMPT_HEADER
  echo "REPO: $repo"
  echo "TOPIC: $topic_rel"
  echo "DRIFT REPORT: $report_rel"
  echo "WORKSPACE: $CARTOGRAPH_ROOT/workspace/$repo/"
  echo "TODAY: $(date +%Y-%m-%d)"
} > "$tmp"

# Single chokepoint for headless spawns: cg_headless_run enforces the global
# CARTOGRAPH_HEADLESS_MAX cap, the recursion guard, and the kill switch.
raw="$(cg_headless_run "drift-fix:$repo/$slug" -- \
  -p --output-format text \
  --allowedTools "Read,Edit,Bash,Glob,Grep" \
  < "$tmp" 2>&1)"
rc=$?
case "$rc" in
  75|77) emit_deferred "headless spawn deferred/refused (rc=$rc)" ;;
  78)    emit_error "claude CLI not found" ;;
esac
raw="$(printf '%s' "$raw" | tail -c 8192)"

json="$(printf '%s' "$raw" | grep -oE '\{[^{}]*"action"[^{}]*\}' | tail -1)"

if [[ -z "$json" ]]; then
  emit_error "no JSON summary in claude output (snippet: $(printf '%s' "$raw" | tail -c 200 | tr '\n' ' '))"
fi

action="$(printf '%s' "$json" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('action',''))" 2>/dev/null || true)"
# Remove the drift report on any terminal action: revised + bumped-only
# resolved the drift, no-op means claude judged it a false positive —
# all three reasons to stop listing this topic in the drift queue.
if [[ "$action" == "revised" || "$action" == "bumped-only" || "$action" == "no-op" ]]; then
  rm -f "$report_abs"
fi

emit_done "$json"
