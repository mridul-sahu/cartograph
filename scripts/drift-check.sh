#!/usr/bin/env bash
# For each tracked repo, compute drift between the bedrock's recorded
# `backfilled_from_sha` and the current upstream tip. If drift exists,
# write a drift report at .drift-reports/<repo>.md that gets injected by
# inject-context.sh on the next user turn.
#
# Called from upstream-sync.sh after every successful pull. Also runnable
# standalone (e.g., from /backfill or doctor).
#
# Usage: drift-check.sh [<repo>]
#   With no arg, checks all forks under workspace/.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
WORKSPACE="$CARTOGRAPH_ROOT/workspace"
GUIDES="$CARTOGRAPH_ROOT/guides"
REPORTS_DIR="$CARTOGRAPH_ROOT/.drift-reports"

# shellcheck disable=SC1091
source "$CARTOGRAPH_ROOT/scripts/lib/frontmatter.sh"

mkdir -p "$REPORTS_DIR"

# Resolve which repos to check.
repos=()
if [[ $# -ge 1 ]]; then
  repos=("$1")
else
  while IFS= read -r -d '' d; do
    [[ -d "$d/.git" ]] && repos+=("$(basename "$d")")
  done < <(find "$WORKSPACE" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
fi

for repo in "${repos[@]}"; do
  fork_dir="$WORKSPACE/$repo"
  overview="$GUIDES/$repo/overview.md"
  report="$REPORTS_DIR/$repo.md"

  if [[ ! -d "$fork_dir/.git" ]]; then
    continue
  fi
  if [[ ! -f "$overview" ]]; then
    # No bedrock yet — nothing to compute drift against.
    continue
  fi

  backfilled_sha="$(fm_get "$overview" backfilled_from_sha)"
  if [[ -z "$backfilled_sha" ]]; then
    # Bedrock has never been backfilled with sha tracking. Skip silently —
    # the next backfill will start tracking.
    continue
  fi

  # Determine tracked branch (default main).
  tracked_branch="$(git -C "$fork_dir" symbolic-ref --short refs/remotes/upstream/HEAD 2>/dev/null | sed 's#^upstream/##')"
  [[ -z "$tracked_branch" ]] && tracked_branch="main"

  current_sha="$(git -C "$fork_dir" rev-parse --short upstream/"$tracked_branch" 2>/dev/null || true)"
  if [[ -z "$current_sha" ]]; then
    continue
  fi

  if [[ "$backfilled_sha" == "$current_sha" ]] || git -C "$fork_dir" merge-base --is-ancestor "$current_sha" "$backfilled_sha" 2>/dev/null; then
    # No drift, or current is ancestor of backfilled (shouldn't normally happen).
    rm -f "$report"
    continue
  fi

  # Make sure backfilled_sha is reachable.
  if ! git -C "$fork_dir" cat-file -e "$backfilled_sha" 2>/dev/null; then
    # Sha not in repo (corrupted state or fork was re-cloned). Skip.
    continue
  fi

  commit_count="$(git -C "$fork_dir" rev-list --count "$backfilled_sha".."$current_sha" 2>/dev/null || echo 0)"
  if [[ "$commit_count" -eq 0 ]]; then
    rm -f "$report"
    continue
  fi

  file_count="$(git -C "$fork_dir" diff --name-only "$backfilled_sha".."$current_sha" 2>/dev/null | wc -l | tr -d ' ')"

  {
    echo "# Ingest: $repo — upstream moved; absorb what changed"
    echo
    echo "Bedrock reflects \`$backfilled_sha\`; upstream is now \`$current_sha\`."
    echo "**$commit_count commit(s), $file_count file(s) changed.**"
    echo
    echo "This is NEW KNOWLEDGE to ingest, not just citations to defend."
    echo "The pull tells you what upstream learned; the notes should learn it too."
    echo
    echo "## Where the change concentrated (top directories)"
    echo
    git -C "$fork_dir" diff --name-only "$backfilled_sha".."$current_sha" 2>/dev/null \
      | awk -F/ 'NF>2 {print $1"/"$2} NF<=2 {print $1}' | sort | uniq -c | sort -rn | head -8 \
      | awk '{printf "- %s (%d files)\n", $2, $1}'
    echo
    echo "## Files cited in the current bedrock"
    echo
    # Pull every \`path/to/file\` pattern from the three bedrock files; cross-reference
    # whether they changed.
    cited="$(grep -hoE '`[a-zA-Z0-9_./-]+\.(py|cc|h|hh|cpp|md|toml|yaml|yml|bzl|BUILD)`' \
      "$GUIDES/$repo"/{overview,architecture,conventions}.md 2>/dev/null \
      | tr -d '`' | sort -u || true)"
    changed_files="$(git -C "$fork_dir" diff --name-only "$backfilled_sha".."$current_sha" 2>/dev/null)"
    if [[ -n "$cited" ]]; then
      cited_changed=""
      while IFS= read -r citation; do
        [[ -z "$citation" ]] && continue
        if echo "$changed_files" | grep -qFx "$citation"; then
          cited_changed+="- \`$citation\` (CHANGED — review bedrock sections that reference it)"$'\n'
        fi
      done <<<"$cited"
      if [[ -n "$cited_changed" ]]; then
        echo "$cited_changed"
      else
        echo "_None of the file paths cited in the current bedrock appear in this diff._"
        echo "_(Drift is likely additive — new code, not changes to documented code.)_"
      fi
    else
      echo "_Bedrock cites no specific file paths yet._"
    fi
    echo
    echo "## Recent commits (most recent first, up to 20)"
    echo
    git -C "$fork_dir" log --oneline --no-decorate -n 20 "$backfilled_sha".."$current_sha" 2>/dev/null | sed 's/^/- /'
    echo
    echo "## Ingestion contract (automatic — the active session does this)"
    echo
    echo "1. For each CHANGED cited file: read the diff and update the notes"
    echo "   that describe it so they state the NEW behavior (absorb, don't"
    echo "   just re-verify). Fold anything load-bearing into bedrock."
    echo "2. For the top changed directories with no covering note: if the"
    echo "   change is substantial, write the topic or episode that captures"
    echo "   what upstream added (the coverage-gap items in the curation"
    echo "   agenda track the hottest of these)."
    echo "3. Bump \`backfilled_from_sha: $current_sha\` and \`last_revised:\`"
    echo "   in each updated bedrock file. The next pull then starts clean."
    echo
    echo "Structural change (many subsystems moved): run \`/backfill $repo\`"
    echo "for a full re-exploration instead of piecemeal ingestion."
  } > "$report"

  echo "[ingest] $repo: $commit_count commit(s), $file_count file(s) to absorb — see .drift-reports/$repo.md"
done

# Per-citation drift (claude-designs/cartograph/per-citation-drift/).
# Runs after per-repo drift so the topic reports complement the repo ones.
if [[ -x "$CARTOGRAPH_ROOT/scripts/topic-drift.sh" ]]; then
  for repo in "${repos[@]}"; do
    bash "$CARTOGRAPH_ROOT/scripts/topic-drift.sh" "$repo" || true
  done
fi

# Merge topic-citation drift into the per-repo report so the orientation
# hook (which only injects .drift-reports/<repo>.md) surfaces it. The
# section is rebuilt from scratch on every run — idempotent, no duplicates.
merge_topic_drift() {
  local repo="$1"
  local report="$REPORTS_DIR/$repo.md"
  local topics_dir="$REPORTS_DIR/topics/$repo"
  local section_header="## Topic notes with citation drift"

  # Collect one line per topic drift report: slug + its first heading.
  local lines=() f slug heading
  if [[ -d "$topics_dir" ]]; then
    for f in "$topics_dir"/*.md; do
      [[ -f "$f" ]] || continue
      slug="$(basename "$f" .md)"
      heading="$(grep -m1 '^#' "$f" 2>/dev/null | sed 's/^#[# ]*//')"
      lines+=("- \`$slug\` — ${heading:-"(no heading)"} (see \`.drift-reports/topics/$repo/$slug.md\`)")
    done
  fi

  # Strip any previous section (header through next ## or EOF), dropping
  # trailing blank lines so reruns don't accumulate whitespace.
  if [[ -f "$report" ]]; then
    awk -v hdr="$section_header" '
      $0 == hdr { skip=1; next }
      skip && /^## / { skip=0 }
      skip { next }
      /^[[:space:]]*$/ { blanks++; next }
      { for (i=0; i<blanks; i++) print ""; blanks=0; print }
    ' "$report" > "$report.tmp" && mv "$report.tmp" "$report"
  fi

  if [[ ${#lines[@]} -eq 0 ]]; then
    # No topic drift. If the report existed only to carry this section,
    # remove it; a bedrock-drift report stays as the loop above left it.
    if [[ -f "$report" ]] && grep -q '<!-- topic-drift-only -->' "$report"; then
      rm -f "$report"
    fi
    return 0
  fi

  if [[ ! -f "$report" ]]; then
    # No bedrock-level drift, but topic citations drifted — write a minimal
    # report so the orientation hook still surfaces it.
    {
      echo "# Drift: $repo"
      echo
      echo "<!-- topic-drift-only -->"
      echo "_No bedrock-level drift; topic-citation drift below._"
    } > "$report"
  fi

  {
    echo
    echo "$section_header"
    echo
    for l in "${lines[@]}"; do
      echo "$l"
    done
  } >> "$report"
}

for repo in "${repos[@]}"; do
  merge_topic_drift "$repo"
done

exit 0
