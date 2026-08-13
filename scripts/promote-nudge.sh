#!/usr/bin/env bash
# scripts/promote-nudge.sh — PostToolUse:Write|Edit hook.
#
# Promotion candidates used to surface only at the NEXT SessionStart,
# which is the worst moment: the session that just wrote the
# threshold-crossing episode is the one holding all the source insights
# in context. This hook fires right after an episode lands and, when one
# of its tags now has enough non-distilled episodes, nudges the CURRENT
# session to /promote while the context is warm. Detection only — no
# spawns, no queue writes.

set -uo pipefail

[[ "${CARTOGRAPH_INJECT_DISABLE:-0}" == "1" ]] && exit 0

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
EPISODES="$CARTOGRAPH_ROOT/episodes"
threshold="${CARTOGRAPH_AUTO_PROMOTE_EPISODES:-3}"

payload="$(cat 2>/dev/null || true)"
[[ -z "$payload" ]] && exit 0
path="$(printf '%s' "$payload" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('tool_input', {}).get('file_path', ''))
except Exception:
    pass
" 2>/dev/null)"

case "$path" in
  "$EPISODES"/*.md|*/episodes/*.md) ;;
  *) exit 0 ;;
esac
[[ -f "$path" ]] || exit 0

python3 - "$EPISODES" "$path" "$threshold" <<'PY'
import re
import sys
from pathlib import Path

episodes_dir, written, threshold = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])

def frontmatter(p: Path) -> str:
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    return m.group(1) if m else ""

def tags_of(fm: str) -> set[str]:
    m = re.search(r"^tags:\s*\[([^\]]*)\]", fm, re.MULTILINE)
    return {t.strip() for t in m.group(1).split(",") if t.strip()} if m else set()

def eligible(fm: str) -> bool:
    if re.search(r"^rejected:\s*true", fm, re.MULTILINE):
        return False
    if re.search(r"^distilled_into:\s*[^~\s]", fm, re.MULTILINE):
        return False
    return True

fm = frontmatter(written)
my_tags = tags_of(fm)
if not my_tags or not eligible(fm):
    sys.exit(0)

counts = {t: 0 for t in my_tags}
repo = ""
m = re.search(r"^repo:\s*(\S+)", fm, re.MULTILINE)
if m:
    repo = m.group(1)
for p in episodes_dir.rglob("*.md"):
    other = frontmatter(p)
    if not eligible(other):
        continue
    for t in my_tags & tags_of(other):
        counts[t] += 1

ripe = sorted(t for t, c in counts.items() if c >= threshold)
if not ripe:
    sys.exit(0)

print("[promote-nudge] The episode you just wrote pushed these tags to the")
print(f"promotion threshold ({threshold}+ non-distilled episodes):")
for t in ripe:
    print(f"  - /promote {t}   ({counts[t]} episodes{', repo ' + repo if repo else ''})")
print("Promote NOW while the source insights are in your context — the next")
print("session would have to re-read every episode cold.")
PY

exit 0
