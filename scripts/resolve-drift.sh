#!/usr/bin/env bash
# scripts/resolve-drift.sh — pre-stage the §3b bedrock drift resolution.
#
# The judgment in a bedrock drift pass is small; the bookkeeping is not.
# This stages everything the session needs in one shot: the drift report,
# and for every cited-changed file, the bedrock passages that cite it plus
# the upstream diff since backfilled_from_sha. The session reads, revises
# what is contradicted, and closes with the checklist printed at the end.
#
# Usage: resolve-drift.sh <repo>     (invoked by the /resolve-drift slash)

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
repo="${1:?usage: $0 <repo>}"
GUIDES="$CARTOGRAPH_ROOT/guides/$repo"
FORK="$CARTOGRAPH_ROOT/workspace/$repo"
REPORT="$CARTOGRAPH_ROOT/.drift-reports/$repo.md"

if [[ ! -f "$REPORT" ]]; then
  echo "No open bedrock drift report for $repo — nothing to resolve."
  echo "(The badge reads backfilled_from_sha vs upstream tip; if it shows"
  echo " stale but no report exists, run scripts/drift-check.sh $repo first.)"
  exit 0
fi

base_sha="$(grep -m1 '^backfilled_from_sha:' "$GUIDES/overview.md" | awk '{print $2}')"
tip_sha="$(git -C "$FORK" rev-parse --short HEAD)"

echo "# Bedrock drift resolution: $repo ($base_sha -> $tip_sha)"
echo
echo "## The report"
echo
cat "$REPORT"
echo

# Cited-changed files are listed in the report's first section as
# backticked paths. Stage each one's evidence.
cited_files="$(grep -oE '^\- \`[^`]+\` \(CHANGED' "$REPORT" | sed -E 's/^- \`([^`]+)\`.*/\1/')"

if [[ -z "$cited_files" ]]; then
  echo "No cited files changed — this drift is additive. Skip straight to"
  echo "the checklist below."
else
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    echo "=================================================================="
    echo "## Cited file: $f"
    echo
    echo "### Bedrock passages citing it (verify each claim against the diff)"
    echo
    base_name="$(basename "$f")"
    grep -n "$base_name" "$GUIDES"/overview.md "$GUIDES"/architecture.md "$GUIDES"/conventions.md 2>/dev/null \
      | sed 's/^/  /' || echo "  (no direct passage found — cited indirectly?)"
    echo
    echo "### Upstream diff since $base_sha (truncated to 250 lines)"
    echo
    git -C "$FORK" diff "$base_sha"..HEAD -- "$f" 2>/dev/null | head -250
    echo
  done <<<"$cited_files"
fi

echo "=================================================================="
echo "## Closing checklist (do ALL of these)"
echo
echo "1. Revise any contradicted bedrock passage in place (fix anchors by"
echo "   hand for file types the scanners skip)."
echo "2. In all three bedrock files, set:"
echo "     backfilled_from_sha: $tip_sha"
echo "     last_revised: $(date +%Y-%m-%d)"
echo "3. rm $REPORT"
echo "4. Commit + push guides/$repo (message: 'chore(bedrock): resolve"
echo "   $repo drift — backfilled to $tip_sha') — do not leave it to the"
echo "   watch loop if you want a non-generic message."
echo "5. If a contradiction was real, note it in an episode (or the"
echo "   session's existing episode)."
