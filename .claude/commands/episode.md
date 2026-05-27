---
description: Create a new episode for this session (200-600 words, captures durable insight)
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

The user wants to write a Cartograph episode. The title hint is: $ARGUMENTS

Steps:

1. Determine the current repo from cwd (must be inside `workspace/<repo>/`).
2. Today's date:
   !`date +%Y-%m-%d`
3. Files touched in this session (best-effort, last 4 hours under the fork):
   !`find $(pwd) -type f -mmin -240 -not -path '*/.git/*' \( -name '*.py' -o -name '*.cc' -o -name '*.h' -o -name '*.md' \) 2>/dev/null | head -20`
4. Episode path:
   `${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/episodes/YYYY-MM/YYYY-MM-DD-<slug>.md`

5. Use the slug from the title argument (lowercase, hyphenated). Write the episode
   with this frontmatter:

```markdown
---
layer: episode
date: <today>
repo: <repo>
files_touched:
  - <path>
tags: [<keywords from the task>]
superseded_by: ~
distilled_into: ~
---

# <title>

## What the task was

## Files that mattered

## The surprise / insight

## What I'd tell a future Claude session
```

6. Fill in the body based on this session's actual work. 200-600 words. Be specific.
   No generic filler. Reference code with `path/to/file.py:line` form.
7. Save and confirm the path.

If the session was trivial (formatting, renames, no insight), say so and skip
writing — quality > quantity.
