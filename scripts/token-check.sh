#!/usr/bin/env bash
# PostToolUse hook on Edit/Write inside workspace/.
# Scans the new content for forbidden identity tokens and warns (does NOT block).
# The commit-msg git hook is the hard backstop; this just gives Claude an early
# self-correction signal before the diff reaches a commit.

set -euo pipefail

source "$(dirname "$0")/lib/load-config.sh"

WORKSPACE="$CARTOGRAPH_ROOT/workspace"

payload="$(cat 2>/dev/null || true)"

# Extract the file path and (best-effort) the new content from the tool input.
file_path=""
new_content=""
if command -v jq >/dev/null 2>&1 && [[ -n "$payload" ]]; then
  file_path="$(echo "$payload" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)"
  # Edit tool: new_string. Write tool: content. NotebookEdit: new_source.
  new_content="$(echo "$payload" | jq -r '.tool_input.new_string // .tool_input.content // .tool_input.new_source // empty' 2>/dev/null || true)"
fi

# Nothing to check.
[[ -z "$file_path" ]] && exit 0

# Resolve realpath for prefix matching.
WORKSPACE_REAL="$(cd "$WORKSPACE" 2>/dev/null && pwd -P || echo "$WORKSPACE")"
file_real="$(cd "$(dirname "$file_path")" 2>/dev/null && pwd -P || echo "")/$(basename "$file_path")"

# Only check files inside a fork.
[[ "$file_real" != "$WORKSPACE_REAL"/* ]] && exit 0

# Forbidden tokens (case-insensitive). Framework universals + user extras
# from CARTOGRAPH_FORBIDDEN_EXTRAS (comma-separated, regex-escaped).
forbidden='cartograph|claude code|claude opus|claude sonnet|claude haiku|anthropic'
if [[ -n "${CARTOGRAPH_FORBIDDEN_EXTRAS:-}" ]]; then
  IFS=',' read -r -a _extras <<< "$CARTOGRAPH_FORBIDDEN_EXTRAS"
  for _w in "${_extras[@]}"; do
    _w="${_w## }"; _w="${_w%% }"
    [[ -n "$_w" ]] && forbidden="${forbidden}|$(printf '%s' "$_w" | sed 's/[][\\/.*^$()+?{|]/\\&/g')"
  done
fi

hits=""
if [[ -n "$new_content" ]]; then
  hits="$(echo "$new_content" | grep -inE "$forbidden" 2>/dev/null | head -5 || true)"
fi

if [[ -n "$hits" ]]; then
  cat <<EOF
[cartograph-warn] Forbidden identity tokens detected in $file_path:
$hits

This fork must not mention these tokens in any public-facing content
(commits, comments, PRs). Remove or rephrase before committing. The
commit-msg git hook will reject the commit if these reach a commit
message; this is your early warning.
EOF
fi

# Warn-only: never block.
exit 0
