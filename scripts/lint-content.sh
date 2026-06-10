#!/usr/bin/env bash
# scripts/lint-content.sh — enforce Cartograph's content quality bar.
#
# Reads every bedrock / topic / episode / walkthrough / ramp-up file under
# guides/ and learn/, runs the checks documented in docs/quality-bar.md, and
# emits JSON on stdout (or a human-readable summary with --human).
#
# Exit codes:
#   0 — no hard failures
#   1 — one or more hard failures (CI / pre-commit blocker)
#
# Used by:
#   /lint slash command
#   `cartograph lint` CLI shim
#   /api/lint endpoint (UI dashboard panel)

set -uo pipefail

source "$(dirname "$0")/lib/load-config.sh"

GUIDES="$CARTOGRAPH_ROOT/guides"
LEARN="$CARTOGRAPH_ROOT/learn"
EPISODES="$CARTOGRAPH_ROOT/episodes"

human=0
[[ "${1:-}" == "--human" ]] && human=1

# Tunable thresholds (override via env).
BEDROCK_MIN_OVERVIEW="${BEDROCK_MIN_OVERVIEW:-800}"
BEDROCK_MIN_ARCHITECTURE="${BEDROCK_MIN_ARCHITECTURE:-1000}"
BEDROCK_MIN_CONVENTIONS="${BEDROCK_MIN_CONVENTIONS:-600}"
TOPIC_MIN="${TOPIC_MIN:-800}"
WALKTHROUGH_MIN="${WALKTHROUGH_MIN:-2000}"
RAMPUP_MIN="${RAMPUP_MIN:-1500}"
EPISODE_MIN="${EPISODE_MIN:-200}"
EPISODE_MAX="${EPISODE_MAX:-800}"

# Framework universals + user extras from CARTOGRAPH_FORBIDDEN_EXTRAS.
FORBIDDEN_TOKENS='cartograph|claude code|claude opus|claude sonnet|claude haiku|anthropic'
if [[ -n "${CARTOGRAPH_FORBIDDEN_EXTRAS:-}" ]]; then
  IFS=',' read -r -a _extras <<< "$CARTOGRAPH_FORBIDDEN_EXTRAS"
  for _w in "${_extras[@]}"; do
    _w="${_w## }"; _w="${_w%% }"
    [[ -n "$_w" ]] && FORBIDDEN_TOKENS="${FORBIDDEN_TOKENS}|$(printf '%s' "$_w" | sed 's/[][\\/.*^$()+?{|]/\\&/g')"
  done
fi
PLACEHOLDER_TOKENS='\bTODO\b|\bFIXME\b|\bXXX\b|fill in|tbd\b'

# Tracked repo names — banned as episode tags (catch-alls; every orbax
# episode would tag `orbax`, which carries zero retrieval signal).
TRACKED_REPOS="jax xla orbax tunix tokamax sglang"

# Counters for the final report.
total_files=0
hard_fails=0
soft_warns=0

# Per-file failure/warning collectors (printed at end).
issues=()

issue() {
  # issue <severity> <file> <message>
  local sev="$1" file="$2" msg="$3"
  issues+=("$sev|$file|$msg")
  if [[ "$sev" == "fail" ]]; then
    hard_fails=$((hard_fails + 1))
  else
    soft_warns=$((soft_warns + 1))
  fi
}

# Frontmatter helper: pull a single field's value (empty if absent).
fm_field() {
  local file="$1" field="$2"
  [[ -f "$file" ]] || return 0
  sed -n '/^---[[:space:]]*$/,/^---[[:space:]]*$/p' "$file" 2>/dev/null \
    | sed '1d;$d' \
    | grep -E "^[[:space:]]*${field}[[:space:]]*:" \
    | head -1 \
    | sed -E "s/^[[:space:]]*${field}[[:space:]]*:[[:space:]]*//; s/[[:space:]]*#.*$//; s/[[:space:]]+$//"
}

# Body word count (excluding frontmatter).
body_words() {
  local file="$1"
  [[ -f "$file" ]] || { echo 0; return; }
  sed -n '/^---[[:space:]]*$/,/^---[[:space:]]*$/!p' "$file" 2>/dev/null \
    | wc -w | tr -d ' '
}

# Citation density: count file:line patterns of the form `path/to/file.{py,cc,h,...}` or `:NNN`.
citation_count() {
  local file="$1"
  [[ -f "$file" ]] || { echo 0; return; }
  grep -oE '[a-zA-Z0-9_./-]+\.(py|pyi|cc|cpp|h|hh|hpp|c|ts|tsx|js|go|rs|md|toml|yaml|yml|bzl|BUILD)(:[0-9]+)?' "$file" 2>/dev/null \
    | wc -l | tr -d ' '
}

# Section-presence check.
has_section() {
  local file="$1" pattern="$2"
  grep -qiE "^#{1,3}[[:space:]]+.*${pattern}" "$file" 2>/dev/null
}

# Forbidden / placeholder scan.
forbidden_scan() {
  local file="$1"
  local sev="$2"  # fail | warn
  # skip frontmatter (sed -n '...!p' inverts)
  if grep -iE "$FORBIDDEN_TOKENS" \
       <(sed -n '/^---[[:space:]]*$/,/^---[[:space:]]*$/!p' "$file") >/dev/null 2>&1; then
    issue "$sev" "$file" "contains forbidden identity token (see CARTOGRAPH_FORBIDDEN_EXTRAS + framework defaults)"
  fi
  if grep -iE "$PLACEHOLDER_TOKENS" \
       <(sed -n '/^---[[:space:]]*$/,/^---[[:space:]]*$/!p' "$file") >/dev/null 2>&1; then
    issue "warn" "$file" "contains TODO/FIXME/placeholder text"
  fi
}

###############################################################################
# Bedrock checks
###############################################################################
# (bash 3.2 on macOS lacks associative arrays — use parallel case statements.)
bedrock_sections_for() {
  case "$1" in
    overview)     echo "what this codebase does|major subsystems|non-obvious design decisions|surprises|seams to other repos" ;;
    architecture) echo "top-level layout|where to find things|build artifacts|files claude should rarely" ;;
    conventions)  echo "build|pr norms|code-style|things that look broken but aren't" ;;
  esac
}

bedrock_min_for() {
  case "$1" in
    overview)     echo "$BEDROCK_MIN_OVERVIEW" ;;
    architecture) echo "$BEDROCK_MIN_ARCHITECTURE" ;;
    conventions)  echo "$BEDROCK_MIN_CONVENTIONS" ;;
  esac
}

for repo_dir in "$GUIDES"/*/; do
  repo="$(basename "$repo_dir")"
  [[ "$repo" == "seams.md" ]] && continue
  for layer in overview architecture conventions; do
    file="$repo_dir$layer.md"
    [[ -f "$file" ]] || continue
    total_files=$((total_files + 1))

    # Word count.
    words="$(body_words "$file")"
    min="$(bedrock_min_for "$layer")"
    if (( words < min )); then
      issue "warn" "$file" "below word-count floor ($words < $min)"
    fi

    # Required sections.
    sections_csv="$(bedrock_sections_for "$layer")"
    IFS='|' read -ra patterns <<<"$sections_csv"
    for pat in "${patterns[@]}"; do
      [[ -z "$pat" ]] && continue
      if ! has_section "$file" "$pat"; then
        issue "fail" "$file" "missing required section matching: ${pat}"
      fi
    done

    # Frontmatter integrity.
    fm_layer="$(fm_field "$file" layer)"
    [[ "$fm_layer" == "bedrock" ]] || issue "fail" "$file" "frontmatter 'layer' must be 'bedrock' (got '$fm_layer')"
    [[ -n "$(fm_field "$file" repo)" ]] || issue "fail" "$file" "frontmatter 'repo' missing"
    [[ -n "$(fm_field "$file" last_revised)" ]] || issue "fail" "$file" "frontmatter 'last_revised' missing"
    [[ -n "$(fm_field "$file" backfilled_from_sha)" ]] || issue "warn" "$file" "frontmatter 'backfilled_from_sha' missing"

    # Citation density.
    cites="$(citation_count "$file")"
    if (( words > 0 )); then
      density=$(awk "BEGIN { printf \"%.2f\", $cites * 250 / $words }")
      if (( $(awk "BEGIN { print ($density < 1.0) }") )); then
        issue "warn" "$file" "low citation density ($cites cites / $words words; expected ≥1 per 250 words)"
      fi
    fi

    forbidden_scan "$file" "fail"
  done
done

###############################################################################
# Topic notes
###############################################################################
for repo_dir in "$GUIDES"/*/; do
  topics_dir="$repo_dir/topics"
  [[ -d "$topics_dir" ]] || continue
  for file in "$topics_dir"/*.md; do
    [[ -f "$file" ]] || continue
    [[ "$(basename "$file")" == ".gitkeep" ]] && continue
    total_files=$((total_files + 1))

    words="$(body_words "$file")"
    if (( words < TOPIC_MIN )); then
      issue "warn" "$file" "topic note below word-count floor ($words < $TOPIC_MIN)"
    fi

    [[ -n "$(fm_field "$file" topic)" ]] || issue "fail" "$file" "frontmatter 'topic' missing"
    [[ -n "$(fm_field "$file" last_revised)" ]] || issue "fail" "$file" "frontmatter 'last_revised' missing"

    cites="$(citation_count "$file")"
    if (( cites < 3 )); then
      issue "warn" "$file" "topic note has <3 file:line citations ($cites)"
    fi

    forbidden_scan "$file" "fail"
  done
done

###############################################################################
# Episodes
###############################################################################
if [[ -d "$EPISODES" ]]; then
  while IFS= read -r -d '' file; do
    [[ "$(basename "$file")" == "README.md" ]] && continue
    total_files=$((total_files + 1))

    words="$(body_words "$file")"
    if (( words < EPISODE_MIN )); then
      issue "warn" "$file" "episode below floor ($words < $EPISODE_MIN)"
    elif (( words > EPISODE_MAX )); then
      issue "fail" "$file" "episode over ceiling ($words > $EPISODE_MAX); distill or split"
    fi

    [[ -n "$(fm_field "$file" date)" ]] || issue "fail" "$file" "frontmatter 'date' missing"
    tags_line="$(fm_field "$file" tags)"
    tag_count="$(echo "$tags_line" | tr ',' '\n' | grep -v '^[[:space:]]*$' | wc -l | tr -d ' ')"
    if (( tag_count < 2 )); then
      issue "warn" "$file" "episode has <2 tags"
    fi
    # Repo-name catch-all tags carry no retrieval signal — every episode in
    # a repo would match. Demand subsystem tags instead.
    while IFS= read -r tag; do
      tag="$(echo "$tag" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | tr '[:upper:]' '[:lower:]')"
      [[ -z "$tag" ]] && continue
      case " $TRACKED_REPOS " in
        *" $tag "*) issue "fail" "$file" "repo-name tag '$tag' is a catch-all — use a subsystem tag" ;;
      esac
    done < <(echo "$tags_line" | tr -d '[]' | tr ',' '\n')
  done < <(find "$EPISODES" -name '*.md' -print0 2>/dev/null)
fi

###############################################################################
# Walkthroughs + ramp-ups
###############################################################################
if [[ -d "$LEARN/walkthroughs" ]]; then
  for file in "$LEARN/walkthroughs"/*.md; do
    [[ -f "$file" ]] || continue
    total_files=$((total_files + 1))
    words="$(body_words "$file")"
    if (( words < WALKTHROUGH_MIN )); then
      issue "warn" "$file" "walkthrough below floor ($words < $WALKTHROUGH_MIN)"
    fi
    if ! grep -qiE '^```mermaid|<mermaid' "$file"; then
      issue "warn" "$file" "walkthrough has no Mermaid diagram"
    fi
    forbidden_scan "$file" "fail"
  done
fi

if [[ -d "$LEARN/ramp-up" ]]; then
  for file in "$LEARN/ramp-up"/*.md; do
    [[ -f "$file" ]] || continue
    [[ "$(basename "$file")" == "README.md" ]] && continue
    total_files=$((total_files + 1))
    words="$(body_words "$file")"
    if (( words < RAMPUP_MIN )); then
      issue "warn" "$file" "ramp-up below floor ($words < $RAMPUP_MIN)"
    fi
    if ! grep -qiE '^#{1,3}[[:space:]]+Day[[:space:]]+[0-9]' "$file"; then
      issue "warn" "$file" "ramp-up has no 'Day N' headings"
    fi
    forbidden_scan "$file" "fail"
  done
fi

###############################################################################
# Emit results
###############################################################################
if [[ $human -eq 1 ]]; then
  echo "═══════════════════════════════════════════════════════════"
  echo " cartograph content lint — $(date +'%Y-%m-%d %H:%M:%S')"
  echo "═══════════════════════════════════════════════════════════"
  echo
  echo " checked: $total_files files"
  echo " hard fails: $hard_fails"
  echo " soft warns: $soft_warns"
  echo
  if (( ${#issues[@]} > 0 )); then
    for i in "${issues[@]}"; do
      sev="${i%%|*}"
      rest="${i#*|}"
      file="${rest%%|*}"
      msg="${rest#*|}"
      rel="${file#$CARTOGRAPH_ROOT/}"
      if [[ "$sev" == "fail" ]]; then
        printf " ❌ %s\n    %s\n" "$rel" "$msg"
      else
        printf " ⚠  %s\n    %s\n" "$rel" "$msg"
      fi
    done
  else
    echo " no issues found."
  fi
  if (( hard_fails > 0 )); then
    exit 1
  fi
  exit 0
fi

# JSON output.
items_json=""
first=1
for i in "${issues[@]}"; do
  sev="${i%%|*}"
  rest="${i#*|}"
  file="${rest%%|*}"
  msg="${rest#*|}"
  rel="${file#$CARTOGRAPH_ROOT/}"
  # Crude JSON escape (escape backslashes and double-quotes).
  esc_msg="$(echo -n "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  esc_rel="$(echo -n "$rel" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  entry="{\"severity\":\"$sev\",\"file\":\"$esc_rel\",\"message\":\"$esc_msg\"}"
  if [[ $first -eq 1 ]]; then
    items_json="$entry"
    first=0
  else
    items_json="${items_json},${entry}"
  fi
done

cat <<EOF
{
  "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "checked_files": $total_files,
  "hard_fails": $hard_fails,
  "soft_warns": $soft_warns,
  "issues": [$items_json]
}
EOF

if (( hard_fails > 0 )); then
  exit 1
fi
exit 0
