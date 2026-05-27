#!/usr/bin/env bash
# scripts/anchor-fix.sh — hand the anchor-coverage gap for one topic to
# claude -p and let it add the missing canonical-file `path:NNN` anchors
# in place. Writes status to .cartograph/jobs/anchor-<repo>-<slug>.json
# so the bulk UI can poll without keeping the HTTP request open.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
repo="${1:?usage: $0 <repo> <slug>}"
slug="${2:?usage: $0 <repo> <slug>}"

topic_rel="guides/$repo/topics/$slug.md"
topic_abs="$CARTOGRAPH_ROOT/$topic_rel"
coverage="$CARTOGRAPH_ROOT/.cartograph/state/anchor-coverage.json"

jobs_dir="$CARTOGRAPH_ROOT/.cartograph/jobs"
mkdir -p "$jobs_dir"
status_path="$jobs_dir/anchor-$repo-$slug.json"

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
if [[ ! -f "$coverage" ]]; then emit_error "anchor-coverage audit not built yet"; fi
if ! command -v claude >/dev/null 2>&1; then emit_error "claude CLI not on PATH"; fi

missing_csv="$(python3 - "$coverage" "$repo" "$slug" <<'PY'
import json, sys
data = json.loads(open(sys.argv[1]).read())
repo, slug = sys.argv[2], sys.argv[3]
gaps = data.get("gaps_by_repo", {}).get(repo, [])
for g in gaps:
    if g.get("slug") == slug:
        print(", ".join(m["file"] for m in g.get("missing", [])))
        break
PY
)"

if [[ -z "$missing_csv" ]]; then
  emit_done '{"action":"no-op","files_added":0,"summary":"no missing files recorded for this topic — audit may be stale"}'
  exit 0
fi

tmp="$(mktemp -t cartograph-anchor-fix.XXXXXX)"
trap 'rm -f "$tmp"' EXIT

{
  cat <<'PROMPT_HEADER'
You are adding missing canonical-file anchors to a Cartograph topic note.

Your job:
1. Read the topic note.
2. For each missing file, check whether the topic body discusses the
   file's subsystem. If YES — add a `path:NNN` anchor where that claim
   lives, via the Edit tool. If NO — skip (false positive).
3. Bump `last_revised:` only if at least one anchor was added.
4. Output ONE line of JSON:
   {"action":"anchored"|"no-op","files_added":<count>,"summary":"<one sentence>"}

PROMPT_HEADER
  echo "REPO: $repo"
  echo "TOPIC: $topic_rel"
  echo "MISSING FILES: $missing_csv"
  echo "WORKSPACE: $CARTOGRAPH_ROOT/workspace/$repo/"
  echo "TODAY: $(date +%Y-%m-%d)"
  echo
  echo "Conservative. Output JSON on its own line at the end."
} > "$tmp"

raw="$(claude -p --output-format text \
  --allowedTools "Read,Edit,Bash,Glob,Grep" \
  < "$tmp" 2>&1 | tail -c 8192)"

json="$(printf '%s' "$raw" | grep -oE '\{[^{}]*"action"[^{}]*\}' | tail -1)"

if [[ -z "$json" ]]; then
  emit_error "no JSON summary in claude output (snippet: $(printf '%s' "$raw" | tail -c 200 | tr '\n' ' '))"
fi

# Drop this topic from the live audit so the bulk queue stops listing
# it on next reload. action=anchored means the gap is genuinely fixed;
# action=no-op means it was a false positive — either way, the row
# shouldn't reappear. False positives also go on the suppress list so
# subsequent audits don't re-flag them.
action="$(printf '%s' "$json" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('action',''))" 2>/dev/null || true)"
if [[ "$action" == "anchored" || "$action" == "no-op" ]]; then
  python3 - "$CARTOGRAPH_ROOT" "$repo" "$slug" "$action" "$missing_csv" <<'PY' || true
import json, pathlib, sys
root, repo, slug, action, missing_csv = sys.argv[1:6]
root = pathlib.Path(root)

# Patch live audit JSON: drop this slug from gaps_by_repo[repo].
ac_path = root / ".cartograph" / "state" / "anchor-coverage.json"
if ac_path.is_file():
    try:
        ac = json.loads(ac_path.read_text(encoding="utf-8"))
        gaps = ac.get("gaps_by_repo", {}).get(repo, [])
        ac["gaps_by_repo"][repo] = [g for g in gaps if g.get("slug") != slug]
        ac["total_gaps"] = sum(len(v) for v in ac.get("gaps_by_repo", {}).values())
        ac_path.write_text(json.dumps(ac, indent=2), encoding="utf-8")
    except (OSError, json.JSONDecodeError):
        pass

# Persistent suppress list so the next full audit re-run doesn't undo
# the no-op verdict. For action=anchored we don't need persistence — the
# topic now actually has the anchors, the audit will see them as
# anchored. For action=no-op the suppress list is the only record.
if action == "no-op":
    sup_path = root / ".cartograph" / "state" / "anchor-suppress.json"
    sup_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        sup = json.loads(sup_path.read_text(encoding="utf-8")) if sup_path.is_file() else {}
    except (OSError, json.JSONDecodeError):
        sup = {}
    sup.setdefault("topics", [])
    if not any(t.get("repo") == repo and t.get("slug") == slug for t in sup["topics"]):
        sup["topics"].append({"repo": repo, "slug": slug, "reason": "claude no-op"})
    sup_path.write_text(json.dumps(sup, indent=2), encoding="utf-8")
PY
fi

emit_done "$json"
