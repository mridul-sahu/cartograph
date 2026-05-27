---
description: Pin a note to the home-page bookmarks list (agent-side equivalent of the UI button)
allowed-tools: Bash
---

The user wants to pin a note for quick access on Home. Path: $ARGUMENTS

Bookmarks live at `.cartograph/state/bookmarks.json` (gitignored, local).
The same store backs the Home page's "Pinned" card.

!`curl -fsS -X POST -H 'content-type: application/json' --data "{\"path\":\"$ARGUMENTS\",\"title\":\"$ARGUMENTS\"}" http://127.0.0.1:47777/api/bookmarks 2>&1 | head -3 || echo "(server not running — start with: just up or python3 scripts/serve.py)"`

If the path was already pinned, this toggles it off. To see the current
list: `curl http://127.0.0.1:47777/api/bookmarks` or open Home.
