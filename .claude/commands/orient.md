---
description: Re-run the Cartograph orientation hook and show what context would be injected
allowed-tools: Bash
---

The user wants to see what Cartograph would inject for the current cwd.

Run the orientation hook directly with an empty prompt and show me the output:

!`echo '{}' | ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/inject-context.sh`

Summarize: which scope is the user in (fork / cartograph / outside), what guides
exist for the repo, and whether any topic notes or episodes would be injected.
