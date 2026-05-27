---
description: Start a learn/drafts entry — pre-publication essay outline
allowed-tools: Bash, Write, Read
---

The user wants to start a learn/drafts essay. Slug: $ARGUMENTS

Drafts are essay-shaped outlines on the path to becoming
walkthroughs or academy-style posts. They differ from episodes
(per-session insight) and topic notes (stable mental model) by being
*narrative* — they explain a concept to a reader new to the codebase.

Steps:

1. Validate slug: `[a-z0-9][a-z0-9-]*`

2. Path: `${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/learn/drafts/<slug>.md`. If it exists,
   STOP and tell the user — suggest editing it directly instead.

3. Today's date:
   !`date +%Y-%m-%d`

4. Scaffold:

```markdown
---
layer: draft
slug: <slug>
last_revised: <today>
target: walkthrough | academy-post | unknown
status: outline | in-progress | ready-for-promotion
---

# <Title — what the reader will learn>

## Hook

(The opening 2-3 sentences that justify reading.)

## The mental model

(The structuring metaphor or framework that organizes the rest.)

## Walk

(Section-by-section walk. Code snippets with `path:NNN` anchors so the
chassis lint passes.)

## Where to go next

(Pointers into related topic notes, walkthroughs, or external papers.)
```

5. Fill in the outline as far as the session's understanding allows.
   Don't ship a stub — minimum 1500 words is the lint floor for
   anything that ends up under `learn/`.

6. Tell the user the draft is started.
