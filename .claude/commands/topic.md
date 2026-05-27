---
description: Scaffold a fresh topic note (when /promote doesn't apply — no episodes yet)
allowed-tools: Bash, Write, Read
---

The user wants to start a topic note from scratch. Args: `<repo> <slug>` from $ARGUMENTS

Use this when:
- You've read enough code in one session to have a coherent mental model of
  a subsystem, but no episodes-with-shared-tag chain to feed `/promote`.
- You're writing the canonical doc for a system the human asked about
  directly.

Steps:

1. Parse `$ARGUMENTS` as `<repo> <slug>` (space-separated). Validate:
   - repo is one of jax/xla/orbax/tunix/tokamax
   - slug is `[a-z0-9][a-z0-9-]*`

2. Today's date:
   !`date +%Y-%m-%d`

3. Path: `${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/guides/<repo>/topics/<slug>.md`.
   If it exists, STOP and tell the user — don't overwrite. Suggest
   `/revise <slug>` instead.

4. Scaffold with this frontmatter and section structure:

```markdown
---
layer: topic
repo: <repo>
topic: <slug>
last_revised: <today>
reviewed_by_human:
distilled_from: []
supersedes: []
---

# <Topic title — what this is about>

## Summary

(2-3 sentences. The distilled mental model.)

## Detail

(Synthesize what you've read. Cite specific code paths in `path/to/file.py:NNN`
form — the chassis lint requires ≥3 anchors.)

## Open questions / known gaps

(Things this note doesn't yet cover.)
```

5. Fill in the body from what you actually know. Don't ship a stub —
   minimum 800 words per the content lint floor, with ≥3 file:line anchors.

6. Tell the user the topic is drafted and suggest they review. The
   chassis auto-fold to bedrock won't fire until they set
   `reviewed_by_human: <date>`.
