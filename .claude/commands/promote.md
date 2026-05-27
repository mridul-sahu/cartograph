---
description: Consolidate episodes sharing a tag into a single topic note
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

The user wants to promote episodes tagged with: $ARGUMENTS

Steps per plan §8 promotion workflow:

0. **Acquire a worknote lease** so a parallel agent (or auto-promote)
   doesn't stomp:

   !`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/worknote.sh acquire "promote-$ARGUMENTS" --intent "/promote $ARGUMENTS"`

   If the lease is busy (exit 75), STOP. Another agent is already
   promoting this tag. Release the lease at the end (step 7).

1. Find all episodes with this tag that are NOT yet distilled:
   !`grep -lE "tags:.*\b$ARGUMENTS\b" ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/episodes/**/*.md 2>/dev/null | xargs -I{} grep -L "^distilled_into:[[:space:]]*[^~[:space:]]" {} 2>/dev/null`

2. Read each matching episode.

3. Determine the dominant repo from the episodes' frontmatter `repo:` field.
   (If episodes span multiple repos, ask the user which one to promote into.)

4. Draft `${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/guides/<repo>/topics/$ARGUMENTS.md`:

```markdown
---
layer: topic
repo: <repo>
topic: $ARGUMENTS
last_revised: <today>
reviewed_by_human:
distilled_from:
  - <relative path to each source episode>
supersedes: []
---

# <Topic title — what this is about>

## Summary

(2-3 sentences. The distilled insight from the episodes.)

## Detail

(Synthesize the episodes. Cite specific code paths. Cross-reference other
topic notes or guides where useful.)

## Open questions / known gaps

(Things the episodes touched on but didn't fully resolve.)
```

5. For each source episode, edit its frontmatter to set:
   `distilled_into: guides/<repo>/topics/$ARGUMENTS.md`

6. Tell the user the topic note is drafted. Suggest they review and, if
   blessed, set `reviewed_by_human: <today>` in the frontmatter.

7. **Release the lease**:

   !`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/worknote.sh release "promote-$ARGUMENTS"`

If fewer than 2 undistilled episodes exist for this tag, say so — promotion
needs enough signal to be worth doing — and release the lease.
