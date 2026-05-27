---
description: Show every Cartograph note citing the given file path
allowed-tools: Bash
---

The user wants to see every Cartograph note that cites a file path: $ARGUMENTS

The reverse file-path index is at `.cartograph/index/by-file.json` and is
rebuilt at every SessionStart. If it's missing or stale, rebuild it first.

1. Run the lookup (substring match against indexed paths):

!`python3 ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/build-file-index.py --lookup "$ARGUMENTS"`

2. Read the highest-priority hits (bedrock and topic notes citing this
   file) BEFORE opening the file in the workspace. That is the
   "what do we already know" pass — it is the whole point of
   `/whatknows` per CLAUDE.md §1a.

3. If the listing is empty, fall back to `/cite $ARGUMENTS` for a body
   grep across all layers (the index only carries `path:NNN`-shaped
   anchors and `files_touched:` frontmatter; informal mentions need grep).
