#!/usr/bin/env bash
# scripts/auto-revise.sh — close the drift loop automatically by invoking
# `claude -p` headless to revise bedrock against an open drift report.
#
# USAGE
#   scripts/auto-revise.sh <repo>            # single repo
#   scripts/auto-revise.sh --all             # all repos with open drift reports
#   scripts/auto-revise.sh --dry-run <repo>  # show what would happen, don't invoke claude
#
# WHAT IT DOES
#   1. Reads .drift-reports/<repo>.md
#   2. Reads the bedrock files for <repo>
#   3. Writes a structured prompt to a temp file
#   4. Pipes it into `claude -p` with permissions to Read, Edit, Glob, Grep,
#      and Bash (read-only) on the repo
#   5. Claude revises bedrock in place ONLY where contradicted; bumps
#      backfilled_from_sha + last_revised; deletes the drift report
#   6. The script commits the bedrock change and pushes to origin/main —
#      a drift resolution must land on main, not sit local.
#   7. Logs the full transcript to .auto-revise-log/YYYY-MM-DDThhmmss-<repo>.log
#
# SAFETY
#   - Conservative prompt: "only revise on genuine contradiction".
#   - Claude itself never commits; the script commits deterministically
#     AFTER the run, so the commit message + diff scope are predictable.
#   - Set CARTOGRAPH_AUTO_REVISE_PUSH=0 to stage-only (skip commit+push)
#     if you want to review via `git diff` first.
#
# REQUIREMENTS
#   - `claude` CLI installed (the one that runs Claude Code).
#   - Run from inside <cartograph-root>/ (or set CARTOGRAPH_ROOT).
#
# Safe to run unattended: the claude call routes through lib/headless.sh,
# so the global agent cap, recursion guard, and kill switch all apply.
# drift-drain.sh (serve.py loop + maintenance.sh) calls this automatically;
# /auto-revise and the UI button remain the manual paths. Exits 75/77 when
# the spawn was deferred/refused — the drift report is kept for a retry.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
DRIFT_DIR="$CARTOGRAPH_ROOT/.drift-reports"
LOG_DIR="$CARTOGRAPH_ROOT/.auto-revise-log"

mkdir -p "$LOG_DIR"

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
  shift
fi

target="${1:?usage: $0 [--dry-run] <repo|--all>}"

# Verify claude CLI exists (skip in dry-run).
if [[ $dry_run -eq 0 ]] && ! command -v claude >/dev/null 2>&1; then
  echo "auto-revise: 'claude' CLI not found in PATH. Install Claude Code first." >&2
  echo "auto-revise: rerun with --dry-run to preview without invoking claude." >&2
  exit 1
fi

build_prompt_file() {
  local repo="$1" drift="$2" tmp="$3" today
  today="$(date +%Y-%m-%d)"

  {
    echo "You are auto-resolving a Cartograph drift report. Work conservatively."
    echo
    echo "## The drift report"
    echo
    echo "    (verbatim contents of .drift-reports/${repo}.md follow)"
    echo
    sed 's/^/    /' "$drift"
    echo
    echo "## Bedrock files for repo \`${repo}\`"
    echo
    echo "The three files below are the current bedrock to revise IN PLACE if (and only if) the drift contradicts them:"
    echo "  - guides/${repo}/overview.md"
    echo "  - guides/${repo}/architecture.md"
    echo "  - guides/${repo}/conventions.md"
    echo
    echo "(Use the Read tool to read them fresh. Their content is on disk; do not assume what was here at session start.)"
    echo
    echo "## Your task"
    echo
    echo "1. Read the drift report (above) and identify which files were CHANGED upstream AND cited in the current bedrock."
    echo "2. For each such file, inspect the upstream diff via Bash:"
    echo
    echo "   git -C ${CARTOGRAPH_ROOT}/workspace/${repo} diff <old_sha>..<new_sha> -- <file>"
    echo
    echo "3. For each section of each bedrock file, decide:"
    echo "   - No contradiction → leave the section alone"
    echo "   - Genuine contradiction in code → revise the section in place via Edit"
    echo "4. After all section decisions, bump frontmatter in each REVISED bedrock file:"
    echo "   - backfilled_from_sha: <new_upstream_short_sha>"
    echo "   - last_revised: ${today}"
    echo "5. For files NOT revised but where the bedrock is still confirmed accurate against the new sha, ALSO bump backfilled_from_sha to the new sha (so future drift checks don't re-flag)."
    echo "6. Delete the drift report:"
    echo
    echo "   rm ${drift}"
    echo
    echo "7. Print a one-paragraph summary at the end:"
    echo "   - which files revised, which left alone, what evidence drove each call"
    echo
    echo "## Constraints"
    echo
    echo "- Be conservative. A bedrock section about general architecture is rarely contradicted by a single-file change. Revise only on hard evidence."
    echo "- DO NOT invent. If you can't verify a section from the diff, leave it."
    echo "- DO NOT touch files outside guides/${repo}/."
    echo "- DO NOT commit or push. The wrapper script commits + pushes the bedrock to origin/main after you finish — your job is only the in-place revision."
    echo
    echo "Begin."
  } > "$tmp"
}

# Commit the resolved bedrock and push to origin/main. A drift fix changes
# the knowledge base on disk — it must land on main, not sit local.
commit_and_push() {
  local repo="$1"
  cd "$CARTOGRAPH_ROOT"

  if git diff --quiet -- "guides/$repo" 2>/dev/null; then
    echo "auto-revise: no bedrock changes for '$repo' — nothing to commit"
    return 0
  fi
  if [[ "${CARTOGRAPH_AUTO_REVISE_PUSH:-1}" == "0" ]]; then
    echo "auto-revise: CARTOGRAPH_AUTO_REVISE_PUSH=0 — changes left unstaged for 'git diff' review"
    return 0
  fi

  local sha
  sha="$(grep -hE '^backfilled_from_sha:' "guides/$repo"/*.md 2>/dev/null \
    | head -1 | sed -E 's/.*:[[:space:]]*//' | tr -d '[:space:]')"

  # Narrow add: the bedrock for this repo, plus any episode the run wrote.
  git add "guides/$repo"
  [[ -d episodes ]] && git add episodes
  git commit -q -m "chore(bedrock): resolve ${repo} drift${sha:+ — backfilled to ${sha}}

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

  if git push origin main 2>/dev/null; then
    echo "auto-revise: ✓ committed + pushed bedrock for '$repo'"
  else
    echo "auto-revise: push rejected (origin advanced) — pull-rebase + retry"
    if git pull --rebase origin main && git push origin main; then
      echo "auto-revise: ✓ pushed after rebase for '$repo'"
    else
      echo "auto-revise: ⚠ push still failing for '$repo' — resolve + push manually"
    fi
  fi
}

resolve_one() {
  local repo="$1"
  local drift="$DRIFT_DIR/${repo}.md"

  if [[ ! -f "$drift" ]]; then
    echo "auto-revise: no drift report for '$repo' — nothing to do"
    return 0
  fi

  local timestamp prompt_file log
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  prompt_file="$(mktemp -t cartograph-auto-revise-prompt.XXXXXX)"
  log="$LOG_DIR/${timestamp}-${repo}.log"

  build_prompt_file "$repo" "$drift" "$prompt_file"

  if [[ $dry_run -eq 1 ]]; then
    echo "auto-revise --dry-run: would invoke claude -p for '$repo'"
    echo "auto-revise --dry-run: prompt file: $prompt_file ($(wc -c < "$prompt_file" | tr -d ' ') bytes)"
    echo "auto-revise --dry-run: log would write to $log"
    echo
    echo "--- prompt preview (first 25 lines) ---"
    head -25 "$prompt_file"
    echo "..."
    # Keep the file for inspection in dry-run.
    return 0
  fi

  echo "auto-revise: invoking claude -p for '$repo' (log: $log)"
  cd "$CARTOGRAPH_ROOT"
  # Headless invocation:
  #   -p / --print            : non-interactive, exits when Claude finishes
  #   --permission-mode acceptEdits : auto-approve Edit calls so the run is
  #                              actually non-interactive (otherwise Claude
  #                              prompts for each edit and the script hangs)
  #   --allowedTools          : restrict tool surface to what's needed
  # If the user wants stricter / more permissive behavior, override via
  # CARTOGRAPH_AUTO_REVISE_CLAUDE_FLAGS.
  local flags="${CARTOGRAPH_AUTO_REVISE_CLAUDE_FLAGS:--p --output-format text --permission-mode acceptEdits --allowedTools Read,Edit,Glob,Grep,Bash}"
  # shellcheck source=lib/headless.sh
  source "$(dirname "$0")/lib/headless.sh"
  cg_headless_run "auto-revise:$repo" -- $flags < "$prompt_file" > "$log" 2>&1
  local rc=$?
  rm -f "$prompt_file"

  if (( rc == 75 || rc == 77 )); then
    echo "auto-revise: deferred for '$repo' (rc=$rc) — headless cap reached or disabled; report kept for retry"
    rm -f "$log"   # holds only the deferral notice, not a transcript
    return "$rc"
  fi

  echo "auto-revise: claude exited $rc; tail of transcript:"
  tail -15 "$log"

  if [[ ! -f "$drift" ]]; then
    echo "auto-revise: ✓ drift report removed by claude — drift closed for '$repo'"
    commit_and_push "$repo"
    # Refresh the static site so the revised bedrock shows in the web UI.
    source "$(dirname "$0")/lib/notify-server.sh" 2>/dev/null && server_post /api/rebuild || true
  else
    echo "auto-revise: ⚠ drift report still present for '$repo'; review manually"
  fi
}

if [[ "$target" == "--all" ]]; then
  any=0
  for f in "$DRIFT_DIR"/*.md; do
    [[ -f "$f" ]] || continue
    any=1
    repo="$(basename "${f%.md}")"
    echo "─── $repo ───"
    rc=0
    resolve_one "$repo" || rc=$?
    if (( rc == 75 || rc == 77 )); then
      # Cap is occupied (or kill switch on) — every later spawn would defer
      # too. Stop the pass; the remaining reports retry next time.
      exit "$rc"
    fi
    echo
  done
  if [[ $any -eq 0 ]]; then
    echo "auto-revise: no drift reports found in $DRIFT_DIR — nothing to do"
  fi
else
  resolve_one "$target"
fi
