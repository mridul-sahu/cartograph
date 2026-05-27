---
description: Mid-session publish checkpoint — fired by /loop. Forces an introspection: have you learned anything in the last interval that should become an episode?
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

The /loop has fired /checkpoint. This is your scheduled mid-session
publish prompt — designed to keep insights from rotting in the
session's working memory until Stop fires (which, in long sessions,
may not happen for hours).

# Step 1: read the audit

Run the checkpoint audit:

!`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/checkpoint.sh`

# Step 2: introspect

Based on the audit above, decide HONESTLY:

- **Did you learn something durable since the last checkpoint?**
  - A gotcha you debugged
  - A subsystem you finally understood
  - A bedrock or topic note that turned out to be wrong (or right in a
    non-obvious way)
  - A surprise — code that worked differently than the bedrock claimed
  - A cross-repo seam you noticed

- **Or was the work purely mechanical?**
  - A rename, a formatting pass, a copy/paste
  - Following a script you've followed before
  - Routine bug fixes with no new insight

# Step 3a: if learned → WRITE THE EPISODE NOW

Don't defer. Don't say "I'll write one at the end" — the end may not
come for hours, and by then the working context that made the insight
feel concrete is gone. The episode you write NOW reflects what you
actually know; the episode you write at Stop is a reconstruction from
the session log.

```
/episode <short-kebab-slug>
```

The bar (per `CLAUDE.md` §5):
- 200–600 words
- Frontmatter must include `auto_drafted: false`, `reviewed_by_human: ~`, `rejected: false`
- Tags so future promotion can find it
- A specific WHY, not a summary

After writing, return to the user's original task. Don't announce the
episode unless asked.

# Step 3b: if NOT learned → say so in one line, continue

Output a one-line note like:

```
[checkpoint] no durable insight in this interval (5 mechanical edits to <area>); continuing
```

Then resume the user's task. This isn't optional reporting — the
one-liner is the discipline. It forces the introspection even when
the answer is "nothing".

# Why this exists

Long sessions without checkpoints lose insights. The Stop hook's
auto-draft is a fallback, not a primary — a fallback reconstruction
from the session log can't match what the session-context agent
knows in the moment. `/loop 20m /checkpoint` makes the
introspection deterministic at the cost of one short interruption
every 20 minutes.

If you find yourself skipping checkpoints by ignoring the /loop fire
or always answering "no insight", that's a discipline failure — fix
it by writing the episode you've been avoiding.
