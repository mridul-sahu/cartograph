#!/usr/bin/env bash
# scripts/auto-review-scan.sh — enqueue pending notes for batched auto-review.
#
# Finds episodes and topic notes that await human review (no
# reviewed_by_human, not rejected) and have no fresh stored opinion, and
# enqueues `review` curation tasks for them. The actual reviewing happens
# in curate.sh's drain — ONE headless agent per batch, under the global
# concurrency cap in lib/headless.sh — so total concurrent claude
# sessions stay bounded no matter how deep the review backlog is.
#
# Each reviewed note gets an opinion file the bulk-review UI surfaces
# (.cartograph/jobs/opinion-<key>.json); confident defects are auto-acted
# (rejected: true / superseded_by:) per the task instructions in curate.sh.
#
# Knobs:
#   CARTOGRAPH_AUTO_REVIEW=0        — disable entirely
#   CARTOGRAPH_AUTO_REVIEW_MAX=12   — max enqueues per scan (default 12)
#
# Enqueue-only and idempotent: re-running never duplicates queue entries
# (curate.sh's key dedup), and notes with an opinion newer than their last
# edit are skipped.

set -uo pipefail

# shellcheck source=lib/headless.sh
source "$(dirname "$0")/lib/headless.sh"   # sets CARTOGRAPH_ROOT; guards

cg_autospawn_guard
[[ "${CARTOGRAPH_AUTO_REVIEW:-1}" == "0" ]] && exit 0

MAX="${CARTOGRAPH_AUTO_REVIEW_MAX:-12}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"

pending="$(python3 - "$CARTOGRAPH_ROOT" <<'PY'
import pathlib, re, sys

root = pathlib.Path(sys.argv[1])
jobs = root / ".cartograph" / "jobs"


def fm(path):
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    return text[4:end] if end != -1 else None


def field(front, name):
    m = re.search(rf"^{name}:[ \t]*(.*)$", front, re.MULTILINE)
    return (m.group(1).strip() if m else "")


def opinion_fresh(rel, note_path):
    key = rel[:-3] if rel.endswith(".md") else rel
    op = jobs / ("opinion-" + key.replace("/", "_") + ".json")
    try:
        return op.stat().st_mtime >= note_path.stat().st_mtime
    except OSError:
        return False


rows = []
sources = [(p, "episodes") for p in sorted((root / "episodes").rglob("*.md"))]
for topics_dir in sorted(root.glob("guides/*/topics")):
    repo = topics_dir.parent.name
    sources += [(p, repo) for p in sorted(topics_dir.glob("*.md"))]

for path, bucket in sources:
    front = fm(path)
    if front is None:
        continue
    reviewed = field(front, "reviewed_by_human")
    if reviewed and reviewed != "~":
        continue
    if re.search(r"^rejected:[ \t]*true", front, re.MULTILINE):
        continue
    if bucket == "episodes" and re.search(
        r"^superseded_by:[ \t]*[^~\s]", front, re.MULTILINE
    ):
        continue
    rel = str(path.relative_to(root))
    if opinion_fresh(rel, path):
        continue
    auto = 0 if field(front, "auto_drafted") == "true" else 1
    date = field(front, "date") or field(front, "last_revised") or "9999"
    rows.append((auto, date, bucket, path.stem))

# auto-drafted first (most likely noise), then oldest first.
rows.sort()
for _auto, _date, bucket, slug in rows:
    print(f"{bucket}\t{slug}")
PY
)" || pending=""

[[ -z "$pending" ]] && { echo "[auto-review] nothing pending" >&2; exit 0; }

total="$(printf '%s\n' "$pending" | grep -c .)"
queued=0
while IFS=$'\t' read -r bucket slug; do
  [[ -z "$bucket" || -z "$slug" ]] && continue
  (( queued >= MAX )) && break
  bash "$SCRIPTS/curate.sh" enqueue review "$bucket" "$slug" || continue
  queued=$((queued + 1))
done <<<"$pending"

echo "[auto-review] $total pending; enqueued $queued (cap $MAX) — drains via the single capped curation agent" >&2
exit 0
