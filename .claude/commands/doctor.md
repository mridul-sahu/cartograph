---
description: Verify identity config and Cartograph setup across all forks
allowed-tools: Bash
---

Run the Cartograph doctor:

!`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/doctor.sh`

If it reports problems, summarize them and suggest specific fixes (which
config setting is wrong, which hook is missing, which guide stub doesn't exist).
