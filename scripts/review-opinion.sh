#!/usr/bin/env bash
# scripts/review-opinion.sh — ask claude -p whether to approve a piece
# of Cartograph content. Writes status JSON to
# .cartograph/jobs/opinion-<sanitized-path>.json for poll-based UIs;
# stdout still echoes the final payload so direct callers work too.
#
# USAGE
#   scripts/review-opinion.sh <path-relative-to-cartograph-root>
#
# STATUS FILE LIFECYCLE
#   { status: "running", started_at, pid }                 while in progress
#   { status: "done", verdict, reason, confidence, ... }   on completion
#   { status: "error", error, ... }                        on failure

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"

rel="${1:?usage: $0 <content-path>}"
file="$CARTOGRAPH_ROOT/$rel"

jobs_dir="$CARTOGRAPH_ROOT/.cartograph/jobs"
mkdir -p "$jobs_dir"
# Sanitize the relative path into a flat filename: slashes → underscores,
# strip the .md suffix. Deterministic so the UI can compute the same key.
sanitized="$(printf '%s' "$rel" | sed -E 's|/|_|g; s|\.md$||')"
status_path="$jobs_dir/opinion-$sanitized.json"

started_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_epoch="$(date +%s)"

emit_done() {
  # Pass payload + start markers as sys.argv. Trailing FOO=bar after
  # `python3 -c` are POSITIONAL args, not env vars — bash only treats
  # leading FOO=bar as exported vars. The earlier env-var form was
  # blowing up with KeyError, leaving the status file stuck at 'running'.
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

# Initial running marker.
python3 - "$started_iso" "$$" <<'PY' > "$status_path.tmp" && mv "$status_path.tmp" "$status_path"
import json, sys
print(json.dumps({"status": "running", "started_at": sys.argv[1], "pid": int(sys.argv[2])}))
PY

if [[ ! -f "$file" ]]; then
  emit_done "{\"verdict\":\"reject\",\"reason\":\"file not found: $rel\",\"confidence\":\"high\"}"
  exit 0
fi
if ! command -v claude >/dev/null 2>&1; then
  emit_done "{\"verdict\":\"approve\",\"reason\":\"claude CLI not on PATH — pre-approving (manual review only)\",\"confidence\":\"low\"}"
  exit 0
fi

tmp="$(mktemp -t cartograph-review.XXXXXX)"
trap 'rm -f "$tmp"' EXIT

{
  cat <<'PROMPT_HEADER'
You are reviewing a Cartograph note for approval. Cartograph is a
layered knowledge base for stable codebases — jax, xla, orbax, tunix,
tokamax. Notes flow upward: episodes -> topic notes -> bedrock. The
quality bar:

  - Bedrock + topic notes must cite specific path/to/file.py:NNN anchors.
  - Claims must match the current code, not be invented or stale.
  - Episodes (200-600 words) capture per-session insight; trivial
    sessions should not have produced one.
  - Auto-drafted notes are the most likely to be rejected — they were
    written by a hook, not by a human.

PROMPT_HEADER

  echo "PATH: $rel"
  echo
  echo "FILE CONTENTS BELOW:"
  echo "---------------------------------------------------------------------"
  cat "$file"
  echo "---------------------------------------------------------------------"
  echo

  cat <<'PROMPT_FOOTER'
Your job: output exactly ONE line of JSON with three fields.

  {"verdict": "approve" | "reject", "reason": "<one sentence>", "confidence": "high" | "medium" | "low"}

Be CONSERVATIVE — when in doubt, approve. Only reject if you see a
concrete defect:
  - factual contradiction with what the code actually does
  - hallucinated function names or APIs
  - missing critical citations (a topic about file X with no anchors to X)
  - the note is empty / a stub / has TODO placeholders
  - the insight is trivially obvious or was already known

DO NOT reject for stylistic preferences. DO NOT reject for "could be
better" — that's a revision request, not a defect.

Output ONLY the JSON line, no preamble, no closing thoughts.
PROMPT_FOOTER
} > "$tmp"

raw="$(claude -p --output-format text < "$tmp" 2>/dev/null | head -c 8192)"

json="$(printf '%s' "$raw" | grep -oE '\{[^{}]*"verdict"[^{}]*\}' | head -1)"

if [[ -z "$json" ]]; then
  emit_done "{\"verdict\":\"approve\",\"reason\":\"opinion parser saw no verdict in claude -p output — defaulting to approve\",\"confidence\":\"low\"}"
  exit 0
fi

emit_done "$json"
