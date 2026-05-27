---
description: Walk a topic note, check if cited files have changed, flag stale sections
allowed-tools: Read, Edit, Bash, Glob, Grep
---

The user wants to revise (or check for staleness) the Cartograph topic note for: $ARGUMENTS

Steps per plan §7 revision discipline, with the diff-aware +
worknote-lease upgrades (see `claude-designs/cartograph/diff-aware-revise/`
and `claude-designs/cartograph/worknote-lease/`):

1. **Acquire a worknote lease** so a parallel agent doesn't stomp:

   !`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/worknote.sh acquire "revise-$ARGUMENTS" --intent "/revise $ARGUMENTS"`

   If this prints `worknote: lease busy → ...` (exit 75), STOP. Another
   agent is already revising this topic. Report the lease to the user
   and offer to release it (`worknote.sh release revise-$ARGUMENTS`) if
   it's stale.

2. Locate the topic note. It will be at
   `${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/guides/<repo>/topics/$ARGUMENTS.md` for one of the
   tracked repos. If the argument doesn't directly resolve, glob for it:
   !`find ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/guides -type f -name "*$(echo "$ARGUMENTS" | tr '/' '-')*.md" -path '*/topics/*' 2>/dev/null | head -5`

3. **Check for pre-computed per-citation drift.** If
   `.drift-reports/topics/<repo>/<slug>.md` exists, read it FIRST — it
   already lists which citations changed and where the relevant commits live.

   !`find ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/.drift-reports/topics -name "*$ARGUMENTS*" 2>/dev/null | head -3`

4. Read the topic note. Note its `last_revised` date and any file paths
   cited in the body (look for `path/to/file.py:line` patterns).

5. For citations NOT pre-flagged by the topic-drift report, run the
   safety-net `git log` check:
   - `cd` into the fork's workspace dir
   - `git log --oneline --since=<last_revised> -- <file>`
   - If commits exist, read the diff with `git log -p -- <file>` since
     `last_revised`

6. For each section of the topic note, decide:
   - **Still accurate** — leave alone
   - **Adds nuance not contradicted** — leave alone
   - **Contradicted by current code** — revise in place

7. If you revise:
   - Edit the topic note in place
   - Bump `last_revised: <today>` in the frontmatter
   - Write a short episode noting what changed and why
   - Release the lease

8. If nothing needs revising, say so clearly. A confidence-bump without
   substantive change is not a revision. Release the lease.

9. **Always release the lease before declaring done:**

   !`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/worknote.sh release "revise-$ARGUMENTS"`

Report what you found and what you did (or didn't) change.
