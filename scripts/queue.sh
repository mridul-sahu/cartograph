#!/usr/bin/env bash
# scripts/queue.sh — sectioned review-debt dashboard.
#
# Composes cartograph_query.py calls plus a handful of filesystem checks
# to surface work the chassis silently created. Read-only.
#
# Tunables (env):
#   CARTOGRAPH_QUEUE_TOPIC_AGE_DAYS  default 90
#   CARTOGRAPH_QUEUE_LEASE_TTL_MIN   default 30
#
# Design: claude-designs/cartograph/review-queue/README.md

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
TOPIC_AGE_DAYS="${CARTOGRAPH_QUEUE_TOPIC_AGE_DAYS:-90}"

Q="python3 $CARTOGRAPH_ROOT/scripts/cartograph_query.py"

today="$(date +%Y-%m-%d)"
age_cutoff="$(date -v-"${TOPIC_AGE_DAYS}"d +%Y-%m-%d 2>/dev/null || date -d "-${TOPIC_AGE_DAYS} days" +%Y-%m-%d)"

section() {
  local label="$1"; shift
  local items="$*"
  local count
  count="$(printf '%s' "$items" | grep -c . || true)"
  [[ "$count" -eq 0 ]] && return
  printf '\n▸ %s (%d)\n' "$label" "$count"
  printf '%s\n' "$items" | sed 's/^/    /'
}

# 1. Auto-drafted episodes awaiting review
auto_drafted="$($Q layer=episode auto_drafted=true '!reviewed_by_human' '!rejected' --format paths 2>/dev/null)"

# 2. Topics without reviewed_by_human (auto-promoted, awaiting fold)
unblessed_topics="$($Q layer=topic '!reviewed_by_human' '!rejected' --format paths 2>/dev/null)"

# 3. Topics aged >TOPIC_AGE_DAYS
stale_topics="$($Q layer=topic "last_revised<$age_cutoff" --format paths 2>/dev/null)"

# 4. Drift reports open (per-repo)
drift_open=""
if [[ -d "$CARTOGRAPH_ROOT/.drift-reports" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    rel="${f#$CARTOGRAPH_ROOT/}"
    commits="$(grep -oE '\*\*[0-9]+ commit' "$f" 2>/dev/null | head -1 | grep -oE '[0-9]+' || echo "?")"
    drift_open+="${rel}    ${commits} commits"$'\n'
  done < <(find "$CARTOGRAPH_ROOT/.drift-reports" -maxdepth 1 -name '*.md' -type f 2>/dev/null)
fi

# 5. Topic-level drift (per-citation-drift design)
topic_drift_open=""
if [[ -d "$CARTOGRAPH_ROOT/.drift-reports/topics" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    topic_drift_open+="${f#$CARTOGRAPH_ROOT/}"$'\n'
  done < <(find "$CARTOGRAPH_ROOT/.drift-reports/topics" -name '*.md' -type f 2>/dev/null)
fi

# 6. Active worknote leases
leases=""
if [[ -d "$CARTOGRAPH_ROOT/.cartograph/in-flight" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    rel="${f#$CARTOGRAPH_ROOT/}"
    intent="$(grep -E '^intent:' "$f" 2>/dev/null | head -1 | sed 's/^intent:[[:space:]]*//')"
    acquired="$(grep -E '^acquired_at:' "$f" 2>/dev/null | head -1 | sed 's/^acquired_at:[[:space:]]*//')"
    leases+="${rel}    ${acquired:-?}  ${intent:-?}"$'\n'
  done < <(find "$CARTOGRAPH_ROOT/.cartograph/in-flight" -name '*.md' -type f 2>/dev/null)
fi

# 7. Episodes with empty tags (lint debt)
# Easier as a separate check — cartograph_query has no native "tags is empty" filter
empty_tags=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  tags_line="$(awk '/^tags:/{print; exit}' "$f" 2>/dev/null)"
  # Empty: `tags:`, `tags: []`, `tags: ~`, or absent altogether
  if [[ -z "$tags_line" ]]; then
    empty_tags+="${f#$CARTOGRAPH_ROOT/}"$'\n'
    continue
  fi
  body="$(echo "$tags_line" | sed -E 's/^tags:[[:space:]]*//; s/[[:space:]]*$//')"
  if [[ -z "$body" || "$body" == "[]" || "$body" == "~" ]]; then
    empty_tags+="${f#$CARTOGRAPH_ROOT/}"$'\n'
  fi
done < <(find "$CARTOGRAPH_ROOT/episodes" -name '*.md' -type f 2>/dev/null | head -200)

# 8. Anchor-coverage audit — topic notes missing canonical-file anchors.
# Reads .cartograph/state/anchor-coverage.json (refreshed by SessionStart).
# Each line: "<topic-path>    missing: <file1>×N, <file2>×N, ..."
anchor_gaps=""
ac_path="$CARTOGRAPH_ROOT/.cartograph/state/anchor-coverage.json"
if [[ -f "$ac_path" ]]; then
  anchor_gaps="$(python3 - "$ac_path" <<'PY'
import json, sys
try:
    data = json.loads(open(sys.argv[1]).read())
except Exception:
    sys.exit(0)
for repo, gaps in data.get("gaps_by_repo", {}).items():
    for gap in gaps[:5]:
        missing = ", ".join(f"{m['file']}×{m['episode_signal']}" for m in gap["missing"][:3])
        print(f"{gap['topic_path']}    missing: {missing}")
PY
  )"
fi

# ----- Render -----
printf '═══════════════════════════════════════════════════════════════════\n'
printf ' cartograph review queue — %s\n' "$today"
printf '═══════════════════════════════════════════════════════════════════\n'

section "Auto-drafted episodes awaiting review"             "${auto_drafted}"
section "Topics awaiting human review"                      "${unblessed_topics}"
section "Topics aged >${TOPIC_AGE_DAYS}d"                   "${stale_topics}"
section "Per-repo drift open (bedrock vs upstream)"         "${drift_open%$'\n'}"
section "Per-topic drift (cited code moved upstream)"       "${topic_drift_open%$'\n'}"
section "Active worknote leases"                            "${leases%$'\n'}"
section "Episodes with empty tags"                          "${empty_tags%$'\n'}"
section "Topic notes missing canonical-file anchors"        "${anchor_gaps}"

# If nothing surfaced, say so
if [[ -z "$auto_drafted$unblessed_topics$stale_topics$drift_open$topic_drift_open$leases$empty_tags$anchor_gaps" ]]; then
  printf '\n  no review-debt items.\n'
fi

cat <<'EOF'

────────
Triage everything:           open /console/review/  (claude decides + acts: bless · anchor · drift)
Dismiss an item:             set rejected: true in its frontmatter.
EOF
