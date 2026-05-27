---
description: Print Cartograph metrics — bedrock freshness, review ratio, drift status, recent activity
allowed-tools: Bash
---

Run the metrics snapshot in human-readable form:

!`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/metrics.sh --human`

Summarize: which repos are fresh vs drifted, what fraction of topic notes
are reviewed_by_human, episode count, anything that looks unhealthy.
