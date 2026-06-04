#!/usr/bin/env bash
# scripts/backfill-bedrock.sh — re-backfill a repo's bedrock against the
# quality bar via `claude -p` headless. Same pattern as auto-revise.sh but
# for full bedrock rewrites against docs/quality-bar.md.
#
# USAGE
#   scripts/backfill-bedrock.sh <repo>
#   scripts/backfill-bedrock.sh --dry-run <repo>
#
# Used by:
#   /api/backfill/{repo}  (POST from UI button)
#   /backfill slash command (future)

set -uo pipefail

source "$(dirname "$0")/lib/load-config.sh"
source "$(dirname "$0")/lib/notify-server.sh"
# shellcheck source=lib/headless.sh
source "$(dirname "$0")/lib/headless.sh"

LOG_DIR="$CARTOGRAPH_ROOT/.backfill-log"
mkdir -p "$LOG_DIR"

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
  shift
fi

repo="${1:?usage: $0 [--dry-run] <repo>}"

# Any repo is valid as long as workspace/<repo> is an initialised git checkout.
# Use `just add-repo` (or scripts/fork-setup.sh) to scaffold one.
workspace_dir="$CARTOGRAPH_ROOT/workspace/$repo"
if [[ ! -d "$workspace_dir/.git" ]]; then
  echo "backfill-bedrock: workspace/$repo is not a git checkout" >&2
  echo "  expected: $workspace_dir/.git" >&2
  echo "  scaffold one with: just add-repo $repo <upstream-url>" >&2
  exit 2
fi

if [[ $dry_run -eq 0 ]] && ! command -v claude >/dev/null 2>&1; then
  echo "backfill-bedrock: 'claude' CLI not in PATH" >&2
  exit 1
fi

# Resolve upstream's actual default branch (main / master / trunk / whatever).
# Falls back to "main" only if the symbolic ref isn't set, so error messages
# below still print something useful.
upstream_default="$(git -C "$workspace_dir" symbolic-ref --short refs/remotes/upstream/HEAD 2>/dev/null | sed 's|^upstream/||')"
upstream_default="${upstream_default:-main}"
current_sha="$(git -C "$workspace_dir" rev-parse --short "upstream/$upstream_default" 2>/dev/null || echo unknown)"
today="$(date +%Y-%m-%d)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

prompt_file="$(mktemp -t cartograph-backfill-prompt.XXXXXX)"
log="$LOG_DIR/${timestamp}-${repo}.log"

# Build the prompt — use a temp file to avoid heredoc/backtick conflicts.
{
  echo "You are re-backfilling Cartograph bedrock for repo \`${repo}\` against the quality bar."
  echo
  echo "## The contract"
  echo
  echo "Read \`docs/quality-bar.md\`. Your rewrite of"
  echo "  guides/${repo}/overview.md"
  echo "  guides/${repo}/architecture.md"
  echo "  guides/${repo}/conventions.md"
  echo "must clear that bar with zero hard failures."
  echo
  echo "## Required exact section headings (lint enforces case-insensitive substring match)"
  echo
  echo "overview.md:"
  echo "  - What this codebase does"
  echo "  - Major subsystems"
  echo "  - Non-obvious design decisions"
  echo "  - Surprises (and gotchas)"
  echo "  - Seams to other repos"
  echo
  echo "architecture.md:"
  echo "  - Top-level layout"
  echo "  - Where to find things (a table)"
  echo "  - Build artifacts (and generated trees to ignore)"
  echo "  - Files Claude should rarely need to read"
  echo
  echo "conventions.md:"
  echo "  - Build (and test)"
  echo "  - PR norms"
  echo "  - Code-style specifics"
  echo "  - Things that look broken but aren't"
  echo
  echo "## Floors"
  echo "  overview: ≥ 1000 words"
  echo "  architecture: ≥ 1200 words"
  echo "  conventions: ≥ 800 words"
  echo "  ≥ 1 file:line citation per 200 words"
  echo
  echo "## Forbidden"
  echo "  TODO, FIXME, XXX, TBD"
  forbidden_list="cartograph, anthropic, claude code, claude opus, claude sonnet, claude haiku"
  if [[ -n "${CARTOGRAPH_FORBIDDEN_EXTRAS:-}" ]]; then
    forbidden_list="${forbidden_list}, ${CARTOGRAPH_FORBIDDEN_EXTRAS}"
  fi
  echo "  ${forbidden_list}"
  echo "  (plain 'claude' without 'code'/'opus'/'sonnet'/'haiku' is allowed)"
  echo
  echo "## Method"
  echo "  1. Read current guides/${repo}/{overview,architecture,conventions}.md."
  echo "  2. Read guides/${repo}/topics/ (existing topic notes) for cross-references."
  echo "  3. Read guides/seams.md."
  echo "  4. Sync upstream: bash scripts/upstream-sync.sh ${repo}. Current sha: ${current_sha}."
  echo "  5. Rewrite each file under the required headings; PRESERVE good content, EXPAND under each heading, ADD file:line citations."
  echo "  6. Frontmatter:"
  echo "     ---"
  echo "     layer: bedrock"
  echo "     repo: ${repo}"
  echo "     last_revised: ${today}"
  echo "     backfilled_from_sha: <current sha>"
  echo "     ---"
  echo "  7. Verify: bash scripts/lint-content.sh --human 2>&1 | grep -A 1 guides/${repo}/"
  echo
  echo "## Be conservative"
  echo "  Don't invent. Cross-reference topic notes rather than re-derive their content."
  echo "  Cite specific file:line anchors."
  echo "  Keep frontmatter intact except sha + date bumps."
  echo
  echo "Begin."
} > "$prompt_file"

if [[ $dry_run -eq 1 ]]; then
  echo "backfill-bedrock --dry-run: prompt file: $prompt_file ($(wc -c < "$prompt_file" | tr -d ' ') bytes)"
  echo "backfill-bedrock --dry-run: log would write to $log"
  echo
  head -25 "$prompt_file"
  exit 0
fi

# ── Job state ───────────────────────────────────────────────────────────
# The script owns .backfill-log/<repo>.state.json so a backfill is visible
# to the UI whether it was started from the repo-page button or the CLI.
# GET /api/backfill/<repo>/status reads this file.
STATE_FILE="$LOG_DIR/${repo}.state.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

write_state() {  # $1=state  $2=exit_code (empty while running)
  local st="$1" ec="${2:-}" fin="null"
  [[ "$st" != "running" ]] && fin="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  [[ -z "$ec" ]] && ec="null"
  printf '{"repo":"%s","state":"%s","started_at":"%s","finished_at":%s,"exit_code":%s,"pid":%s,"log":"%s"}\n' \
    "$repo" "$st" "$STARTED_AT" "$fin" "$ec" "$$" "$log" > "$STATE_FILE"
}

# Reflect the final state even if claude crashes or the run is killed.
on_exit() {
  local ec=$?
  write_state "$([[ $ec -eq 0 ]] && echo done || echo error)" "$ec"
}
trap on_exit EXIT
write_state running

# Commit the re-backfilled bedrock and push to origin/main. A cartograph
# content update must land on master, not sit local. Opt out with
# CARTOGRAPH_BACKFILL_PUSH=0.
commit_and_push() {
  cd "$CARTOGRAPH_ROOT"
  if git diff --quiet -- "guides/$repo" 2>/dev/null; then
    echo "backfill-bedrock: no bedrock changes for '$repo' — nothing to commit"
    return 0
  fi
  if [[ "${CARTOGRAPH_BACKFILL_PUSH:-1}" == "0" ]]; then
    echo "backfill-bedrock: CARTOGRAPH_BACKFILL_PUSH=0 — changes left for 'git diff' review"
    return 0
  fi
  # Resolve cartograph's own default branch — don't assume 'main'.
  local cg_default
  cg_default="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
  cg_default="${cg_default:-main}"
  git add "guides/$repo"
  git commit -q -m "chore(bedrock): re-backfill ${repo}${current_sha:+ — backfilled to ${current_sha}}

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  if git push origin "$cg_default" 2>/dev/null; then
    echo "backfill-bedrock: ✓ committed + pushed bedrock for '$repo'"
  else
    echo "backfill-bedrock: push rejected (origin advanced) — pull-rebase + retry"
    if git pull --rebase origin "$cg_default" && git push origin "$cg_default"; then
      echo "backfill-bedrock: ✓ pushed after rebase for '$repo'"
    else
      echo "backfill-bedrock: ⚠ push still failing for '$repo' — resolve + push manually"
    fi
  fi
}

echo "backfill-bedrock: invoking claude -p for '${repo}' (log: $log)"
cd "$CARTOGRAPH_ROOT"

# Find claude. Subprocess PATH from the FastAPI server may miss user bins.
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [[ -z "$CLAUDE_BIN" ]]; then
  for candidate in "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/claude" "/usr/local/bin/claude" "/opt/homebrew/bin/claude"; do
    if [[ -x "$candidate" ]]; then
      CLAUDE_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$CLAUDE_BIN" ]]; then
  {
    echo "ERROR: claude CLI not found."
    echo "  searched PATH ($PATH) and common locations"
    echo "  install: https://docs.claude.com/en/docs/claude-code"
  } > "$log"
  echo "backfill-bedrock: claude not found — see $log"
  rm -f "$prompt_file"
  exit 127
fi

# Log the invocation for debugging.
{
  echo "=== invocation ==="
  echo "claude: $CLAUDE_BIN"
  echo "version: $("$CLAUDE_BIN" --version 2>&1 | head -1)"
  echo "PATH: $PATH"
  echo "PWD: $(pwd)"
  echo "prompt size: $(wc -c < "$prompt_file" | tr -d ' ') bytes"
  echo "=== claude stdout/stderr ==="
} > "$log"

flags="${CARTOGRAPH_BACKFILL_CLAUDE_FLAGS:---print --output-format text --permission-mode acceptEdits --allowedTools Read,Edit,Glob,Grep,Bash}"
cg_headless_run "backfill:$repo" -- $flags < "$prompt_file" >> "$log" 2>&1
rc=$?
rm -f "$prompt_file"

echo "backfill-bedrock: claude exited $rc; tail of transcript:"
tail -15 "$log"

# Re-run lint to confirm bar is met.
echo
echo "=== lint (filtered to ${repo}) ==="
/bin/bash scripts/lint-content.sh --human 2>&1 | grep -A 1 "guides/${repo}/" || echo "  (no warnings — clean)"

# On a clean run, land the bedrock update on master automatically and
# refresh the static site so the rewrite shows up in the web UI.
if [[ $rc -eq 0 ]]; then
  echo
  echo "=== commit + push ==="
  commit_and_push
  server_post /api/rebuild || true
fi

# Exit with claude's code so the EXIT trap records done/error correctly.
exit "$rc"
