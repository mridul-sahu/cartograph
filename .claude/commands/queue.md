---
description: Show the cartograph review queue — auto-drafted, stale, drifted, in-flight
allowed-tools: Bash
---

The user wants to see what's in the cartograph review queue.

Run the queue script:

!`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/queue.sh`

The queue surfaces:

- Auto-drafted episodes that haven't been reviewed
- Topic notes auto-promoted but not yet blessed (`reviewed_by_human:` absent)
- Topics aged >90 days without revision (freshness debt)
- Per-repo and per-topic drift reports
- Active worknote leases (parallel-agent coordination)
- Episodes with empty tags (lint debt)

Empty sections are suppressed. To bless an item: set
`reviewed_by_human: $(date +%Y-%m-%d)` in its frontmatter. To dismiss:
set `rejected: true`.
