---
description: Append a cross-repo seam entry to guides/seams.md
allowed-tools: Read, Edit, Write, Bash, Glob, Grep
---

The user wants to record a cross-repo seam. The argument format is:
`<src-repo> <dst-repo> <one-line description>`

Argument: $ARGUMENTS

Steps:

1. Parse the argument into src, dst, and description.

2. Read the current `${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/guides/seams.md`. If it doesn't
   exist, create it with this skeleton:

```markdown
---
layer: bedrock
last_revised: <today>
---

# Cross-repo seams

> Every interaction point between tracked repos. One section per src→dst pair.
> Cited code paths use `<repo>/path/to/file.py:line` form.
```

3. Append (or update the existing section for) this src→dst pair:

```markdown
## <src-repo> → <dst-repo>

(description, with specific file paths on both sides if you have them)
```

4. Update the frontmatter's `last_revised: <today>`.

5. Confirm the entry was added. If the seam already existed, show the
   updated section.

If you don't have enough information to write a useful entry, ask the user
for the specific file paths or call paths involved.
