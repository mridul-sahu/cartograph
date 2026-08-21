---
description: Distill episodes sharing a tag into a new or existing topic note, then fold to bedrock (runs automatically; also invocable by hand)
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

Distill the episodes tagged: $ARGUMENTS

This procedure is the AUTOMATIC promotion path. Sessions run it on their
own when the distillation contract fires (SessionStart injection or the
post-edit signal); a human typing `/promote <tag>` is just invoking the
same steps early. Never ask permission to run it; never wait for review.

0. **Acquire a worknote lease** so a parallel agent doesn't stomp:

   !`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/worknote.sh acquire "promote-$ARGUMENTS" --intent "distill $ARGUMENTS"`

   If the lease is busy (exit 75), STOP — another session is already
   distilling this tag. Release the lease at the end (step 7).

1. Find ALL episodes carrying this tag (the tag IS the topic slug — if
   the tag is a bad topic name, retag the episodes first, then distill):
   !`grep -lE "tags:.*\b$ARGUMENTS\b" ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/episodes/**/*.md 2>/dev/null`

   Episodes already distilled into a DIFFERENT topic still count: use
   them as source material, but do not restamp their `distilled_into:`.
   Skip only episodes already distilled into `topics/$ARGUMENTS.md`.

2. Read each matching episode, and determine the dominant repo from
   their frontmatter `repo:` field. (External-project repos like
   `kernels` are fine: the topic lands under `guides/<project>/topics/`
   and is reachable via `cartograph_search`.)

3. **Dedup BEFORE creating anything — merging beats a new file.** List
   `guides/<repo>/topics/` and search for overlap:
   !`ls ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/guides/*/topics/ 2>/dev/null`

   Also run a concept search (`/find $ARGUMENTS` or `cartograph_search`).
   If an existing topic already covers this ground — even under a
   different slug — MERGE into it: weave the new insights into its body,
   append the new episodes to its `distilled_from:`, bump
   `last_revised:`, and stamp the sources' `distilled_into:` with the
   EXISTING topic's path. Only when nothing covers the ground do you
   create `guides/<repo>/topics/$ARGUMENTS.md`:

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

(Synthesize the episodes. Cite specific `path/to/file.py:NNN` anchors.)

## Related

(Links that make the knowledge graph navigable: sibling topic notes this
one touches, `guides/seams.md` entries if cross-repo, and the bedrock
section it feeds. At least one link — an unlinked topic is an orphan.)

## Open questions / known gaps
```

4. For each source episode whose `distilled_into:` is still unset (`~`),
   set it to the topic's path. Leave episodes already distilled
   elsewhere untouched.

5. **Fold to bedrock NOW — no review gate.** Pick the ONE most relevant
   bedrock file (`overview` / `architecture` / `conventions`), add or
   refresh a 1-3 sentence reference cross-linked to the topic note under
   the right section, bump its `last_revised:`, and stamp
   `folded_into_bedrock: <bedrock path>` in the topic's frontmatter.
   Surgical only: never restructure bedrock during a fold.

   External projects have ONE lightweight bedrock file:
   `guides/<project>/overview.md` (frontmatter `external: true`). Fold
   there; create it with that frontmatter if it doesn't exist yet.

6. Say in one line what happened ("distilled N episodes into <topic>
   (merged|new), folded into <bedrock file>"). Do not ask for review;
   the human vetoes by setting `rejected: true` if ever needed.

7. **Release the lease**:

   !`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/worknote.sh release "promote-$ARGUMENTS"`

If fewer than 2 undistilled-under-this-tag episodes exist, say so and
release the lease — distillation needs enough signal to be worth doing.
