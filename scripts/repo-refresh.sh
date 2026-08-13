#!/usr/bin/env bash
# scripts/repo-refresh.sh — one-shot "pull + fix drift" for a single fork.
# Token-free since the token-diet rework: git + python only.
#
#   1. upstream-sync.sh <repo>      fetch upstream, safe fast-forward, push fork
#   2. drift-check.sh <repo>        re-detect repo-level bedrock drift
#   3. drift-drain.sh drain <repo>  re-detect per-topic drift, then
#      mechanically re-anchor (reanchor.py); pure line-shift reports close.
#      Reports that survive need judgment and are surfaced to the active
#      session by the orientation injection.
#
# Writes status JSON to .cartograph/jobs/refresh-<repo>-all.json in the same
# protocol as drift-fix.sh (running/pid, then done | error), so
# GET /api/job/refresh/<repo>/all polls it. Callers: the repo-page button
# (via POST /api/repo-refresh/<repo>).
#
# Usage: repo-refresh.sh <repo> [<slug>]   (slug accepted and ignored so the
#                                           serve.py spawn signature fits)

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
repo="${1:?usage: $0 <repo> [<slug>]}"

jobs_dir="$CARTOGRAPH_ROOT/.cartograph/jobs"
mkdir -p "$jobs_dir"
status_path="$jobs_dir/refresh-$repo-all.json"

started_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_epoch="$(date +%s)"

emit() {
  # $1 = extra JSON fields (object body without braces is error-prone; pass
  # a full JSON object and let python merge it).
  python3 - "$1" "$started_iso" "$started_epoch" <<'PY' > "$status_path.tmp" && mv "$status_path.tmp" "$status_path"
import json, sys, time
d = json.loads(sys.argv[1])
d["started_at"] = sys.argv[2]
d["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
d["elapsed_secs"] = int(time.time()) - int(sys.argv[3])
print(json.dumps(d))
PY
  cat "$status_path"
}

# Self-guard: a live run owns the status file; a second spawn is a no-op.
# Both entry points (serve.py POST and session-start's direct fallback) can
# fire near-simultaneously; this keeps the second one harmless.
if [[ -f "$status_path" ]]; then
  live_pid="$(python3 -c "
import json,sys
try: d=json.load(open('$status_path'))
except Exception: sys.exit()
if d.get('status')=='running' and d.get('pid'): print(d['pid'])
" 2>/dev/null)"
  if [[ -n "$live_pid" ]] && kill -0 "$live_pid" 2>/dev/null; then
    echo "repo-refresh: already running for $repo (pid $live_pid)"
    exit 0
  fi
fi

python3 - "$started_iso" "$$" <<'PY' > "$status_path.tmp" && mv "$status_path.tmp" "$status_path"
import json, sys
print(json.dumps({"status": "running", "started_at": sys.argv[1], "pid": int(sys.argv[2])}))
PY

if [[ ! -d "$CARTOGRAPH_ROOT/workspace/$repo/.git" ]]; then
  emit "{\"status\":\"error\",\"error\":\"workspace/$repo is not a git repo\"}"
  exit 0
fi

sync_note="ok"
bash "$SCRIPTS/upstream-sync.sh" "$repo" || sync_note="upstream-sync failed (rc=$?)"

bash "$SCRIPTS/drift-check.sh" "$repo" || true

open_before="$(bash "$SCRIPTS/drift-drain.sh" count "$repo")"
bash "$SCRIPTS/drift-drain.sh" drain "$repo" >/dev/null 2>&1 || true
open_after="$(bash "$SCRIPTS/drift-drain.sh" count "$repo")"

emit "{\"status\":\"done\",\"sync\":\"$sync_note\",\"reports_before\":$open_before,\"reports_after\":$open_after}"
