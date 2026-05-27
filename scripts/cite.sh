#!/usr/bin/env bash
# scripts/cite.sh — mid-task lookup across all Cartograph layers.
#
# Single ripgrep call per content dir, grouped by layer, capped per
# layer to keep output scannable. Fixed-string match by default
# (rg -F); regex callers can re-issue rg directly.
#
# Design: claude-designs/cartograph/cite-lookup/README.md

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
PER_LAYER_CAP="${CARTOGRAPH_CITE_CAP:-10}"

q="${1:-}"
if [[ -z "$q" ]]; then
  cat <<EOF
usage: cite.sh <symbol-or-path>

Grouped fixed-string search across bedrock, topics, episodes, research,
papers, designs, learn. Cap per layer = $PER_LAYER_CAP.
EOF
  exit 2
fi

SEARCH_CMD=""
if command -v rg >/dev/null 2>&1; then
  SEARCH_CMD="rg --color=never -n --type md -F"
else
  # Portable fallback: GNU/BSD grep -RHnF restricted to .md by --include.
  SEARCH_CMD="grep -RHnF --include=*.md --color=never"
fi

# layer label : dir under CARTOGRAPH_ROOT
declare -a LAYERS=(
  "bedrock:guides"          # bedrock + topic both live under guides/, split below
  "episode:episodes"
  "research:research"
  "paper:papers"
  "design:designs"
  "design-self:claude-designs"
  "learn:learn"
  "diary:diary"
)

run_section() {
  local label="$1" dir="$2" extra_filter="$3"
  local full="$CARTOGRAPH_ROOT/$dir"
  [[ -d "$full" ]] || return
  local hits
  hits="$($SEARCH_CMD -- "$q" "$full" 2>/dev/null \
            | { [[ -n "$extra_filter" ]] && eval "$extra_filter" || cat; } \
            | head -"$PER_LAYER_CAP")"
  local count
  count="$(printf '%s' "$hits" | grep -c . || true)"
  [[ "$count" -eq 0 ]] && return
  printf '\n▸ %s (%d hits, capped at %d)\n' "$label" "$count" "$PER_LAYER_CAP"
  printf '%s\n' "$hits" | sed "s#^$CARTOGRAPH_ROOT/##; s/^/    /"
}

printf '═══════════════════════════════════════════════════════════════════\n'
printf '  cartograph cite — %s\n' "$q"
printf '═══════════════════════════════════════════════════════════════════\n'

# bedrock: only the three top-level files per repo
run_section "bedrock" "guides" "grep -vE '/topics/'"
# topic: only files under */topics/
run_section "topic"   "guides" "grep -E '/topics/'"
run_section "episode" "episodes" ""
run_section "research" "research" ""
run_section "paper" "papers" ""
run_section "design" "designs" ""
run_section "design-self" "claude-designs" ""
run_section "learn" "learn" ""
run_section "diary" "diary" ""

echo
