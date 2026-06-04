---
description: Drain the batched-curation queue with one headless agent (fold/promote/episode/research)
allowed-tools: Bash
---

The user wants to run the pending Cartograph curation now instead of waiting for
the server's debounced drain.

First show what is queued:

!`${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/curate.sh list`

If the queue is empty, tell the user there is nothing to curate and stop.

Otherwise drain it. This hands the WHOLE pending queue to ONE headless agent
under the global concurrency cap (it is a no-op if an agent is already running):

!`${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/curate.sh drain`

Then report a one-line summary of what was folded / promoted / drafted, based on
the agent's output.
