---
description: Resolve the repo-level bedrock drift (the "stale" badge) with everything pre-staged
argument-hint: <repo>
---

Run the bedrock drift resolution for the repo given in `$ARGUMENTS` (or,
if empty, the repo of the current working directory under `workspace/`).

1. Run: `bash $CLAUDE_PROJECT_DIR/scripts/resolve-drift.sh <repo>`
2. The output stages the drift report, every bedrock passage citing a
   changed file, and the upstream diff for each. Verify each claim
   against its diff: most survive; revise the ones that are
   contradicted, directly in `guides/<repo>/{overview,architecture,conventions}.md`.
3. Complete the closing checklist the script prints (sha bump in all
   three files, delete the report, commit + push, episode note if a
   contradiction was real).

Judgment stays with you; do not rubber-stamp. A claim is contradicted
only when the diff changes what the passage asserts, not when lines
moved. If everything is additive, this whole flow is sha-bump + commit.
