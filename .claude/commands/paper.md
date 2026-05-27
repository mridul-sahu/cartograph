---
description: Create a manual paper note (when Stop-hook auto-draft didn't fire)
allowed-tools: Bash, Write, Read
---

The user wants to add a paper note. Args: `<repo> <slug>` from $ARGUMENTS

Use this when:
- You read an external paper, RFC, blog post, or design doc that informs
  your work but the Stop hook didn't auto-draft a paper note (no
  WebFetch/WebSearch was logged).
- You want to record the paper before the session ends so the chassis
  has it next time.

Steps:

1. Parse `$ARGUMENTS` as `<repo> <slug>`. Validate repo in
   jax/xla/orbax/tunix/tokamax.

2. Path: `${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/papers/<repo>/<slug>/notes.md`.

3. Today's date:
   !`date +%Y-%m-%d`

4. Create directory + write `notes.md`:

```markdown
---
layer: paper
repo: <repo>
slug: <slug>
last_revised: <today>
auto_drafted: false
url: <paper-url-if-known>
authors:
tags: [<tags>]
---

# <Paper title>

## What problem it addresses

(2-3 sentences.)

## Key claims / techniques

## How it relates to our work in <repo>

(The bridge that justifies keeping this note. What seam does it touch?
What topic note might it inform? What design decision does it support
or contradict?)

## What to do with this

(Cite, ignore, or implement. Be specific.)
```

5. If a PDF was attached locally, it should live at
   `papers/<repo>/<slug>/<filename>.pdf` (gitignored from the public
   repo per the per-fork .gitignore; the notes.md is what's tracked).

6. Tell the user the note is created.
