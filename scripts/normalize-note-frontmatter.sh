#!/usr/bin/env bash
# scripts/normalize-note-frontmatter.sh — PostToolUse:Write|Edit hook.
#
# Whenever the agent writes or edits a cartograph note (episodes/,
# guides/<r>/topics/, guides/<r>/<bedrock>.md, research/, papers/),
# ensure the review-queue fields are present in frontmatter:
#
#   episodes / topics / research / papers:
#     auto_drafted     — true if the chassis drafted it; default false
#     reviewed_by_human — set to ~ (null) when missing
#     rejected         — default false
#     superseded_by    — default ~
#     distilled_into   — episodes only; default ~
#
# Without these, the bulk-review queue silently misses items. The agent
# can author a minimal template per CLAUDE.md §5 and the hook still
# normalizes — discipline doesn't depend on the agent remembering every
# field every time.
#
# Hook contract:
#   stdin  — JSON payload (tool_input.file_path)
#   stdout — silent
#   exit 0 — always.

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"

payload="$(cat 2>/dev/null || true)"
[[ -z "$payload" ]] && exit 0

path=""
if command -v jq >/dev/null 2>&1; then
  path="$(echo "$payload" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)"
else
  path="$(python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    ti = data.get('tool_input', {})
    print(ti.get('file_path') or ti.get('path') or '')
except Exception:
    pass
" <<<"$payload" 2>/dev/null)"
fi

[[ -z "$path" ]] && exit 0
[[ -f "$path" ]] || exit 0

# Only normalize files under known cartograph note directories. Path
# can be absolute or relative — normalize via realpath when possible.
abs="$(cd "$(dirname "$path")" 2>/dev/null && pwd -P)/$(basename "$path")" || abs="$path"

case "$abs" in
  "$CARTOGRAPH_ROOT"/episodes/*.md|"$CARTOGRAPH_ROOT"/episodes/*/*.md) layer="episode" ;;
  "$CARTOGRAPH_ROOT"/guides/*/topics/*.md) layer="topic" ;;
  "$CARTOGRAPH_ROOT"/guides/*/overview.md|"$CARTOGRAPH_ROOT"/guides/*/architecture.md|"$CARTOGRAPH_ROOT"/guides/*/conventions.md) layer="bedrock" ;;
  "$CARTOGRAPH_ROOT"/research/*/*.md) layer="research" ;;
  "$CARTOGRAPH_ROOT"/papers/*/*/notes.md) layer="paper" ;;
  *) exit 0 ;;
esac

python3 - "$abs" "$layer" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
layer = sys.argv[2]

# Required fields per layer. Order matters for nice output.
REQUIRED = {
    "episode":  [("auto_drafted", "false"), ("reviewed_by_human", "~"),
                 ("rejected", "false"), ("superseded_by", "~"),
                 ("distilled_into", "~")],
    "topic":    [("auto_promoted", "false"), ("reviewed_by_human", "~"),
                 ("rejected", "false"), ("folded_into_bedrock", "~")],
    "bedrock":  [("reviewed_by_human", "~"), ("rejected", "false")],
    "research": [("auto_drafted", "false"), ("reviewed_by_human", "~"),
                 ("rejected", "false")],
    "paper":    [("auto_drafted", "false"), ("reviewed_by_human", "~"),
                 ("rejected", "false")],
}
needed = REQUIRED.get(layer)
if not needed:
    sys.exit(0)

try:
    text = path.read_text(encoding="utf-8")
except OSError:
    sys.exit(0)

# Detect frontmatter — must start with --- on line 1.
m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
if not m:
    # File without frontmatter — leave alone. The author may still be
    # mid-draft. Anchor-coverage + linters will flag the absence.
    sys.exit(0)

fm_text = m.group(1)
fm_end = m.end()
fm_lines = fm_text.split("\n")

# Existing field names (top-level keys only).
existing = set()
for ln in fm_lines:
    fm = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):", ln)
    if fm:
        existing.add(fm.group(1))

missing = [(k, v) for k, v in needed if k not in existing]
if not missing:
    sys.exit(0)

# Append missing fields to the end of the frontmatter block, preserving
# order. Insert before the closing ---.
new_fm_lines = list(fm_lines)
# Trim trailing empty lines in fm so we don't accumulate blanks.
while new_fm_lines and not new_fm_lines[-1].strip():
    new_fm_lines.pop()
for k, v in missing:
    new_fm_lines.append(f"{k}: {v}")
new_fm_text = "\n".join(new_fm_lines)
new_text = "---\n" + new_fm_text + "\n---\n" + text[fm_end:]

# Atomic write.
tmp = path.with_suffix(path.suffix + ".tmp")
tmp.write_text(new_text, encoding="utf-8")
tmp.replace(path)
PY

exit 0
