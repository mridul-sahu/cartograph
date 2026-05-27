---
description: Grep across all Cartograph layers for a symbol or path, grouped output
allowed-tools: Bash
---

The user wants to find every mention of `$ARGUMENTS` across Cartograph
content, grouped by layer (bedrock → topic → episode → research → paper
→ design → learn → diary).

Run the cite script:

!`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/cite.sh "$ARGUMENTS"`

Use this mid-task — when reading code throws up an unfamiliar symbol
or file. Complementary to `/whatknows` (which is indexed and answers
"what do we know about this *file path*"); `/cite` is a fixed-string
grep that works on any token.

Each layer is capped at 10 hits; pipe through `rg` directly if you
need regex or more output.
