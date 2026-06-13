---
description: Explicitly re-explore a repo and update its bedrock to the current upstream sha
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

The user wants to fully re-backfill bedrock for repo: $ARGUMENTS

Argument is the repo name (any tracked workspace/ fork).

**Large C++/Bazel repos are special — see step 0 first.**

0. **C++/Bazel scope check.** A large C++/Bazel repo has several backends
   and ~10× the surface area of a Python lib. A single-session full
   backfill is infeasible — it produces mediocre file-list-y bedrock.
   Use the **subsystem-first** approach instead (see the subsystem-first
   backfill design under `claude-designs/`):

   - Ask the user *which subsystems* to cover this session (1-2 max).
     Canonical subsystems: HLO, hlo-passes, service/runtime, PJRT,
     codegen (LLVM IR generation), layout/SPMD, tools.
   - The repo's ramp-up skeleton at `learn/ramp-up/<repo>.md` (if present)
     pins the subsystem map and reading order — start there before
     drafting anything new.
   - For each chosen subsystem: read `BUILD.bazel` + the top
     `README.md` / `CONTRIBUTING.md`, then walk the half-dozen
     highest-line-count files via `Glob` + `Read`. Draft the
     subsystem's section of `architecture.md` only.
   - Update `overview.md` to add one paragraph mentioning the covered
     subsystem. Don't rewrite the whole file in one pass.
   - Update `conventions.md` only if anything new about Bazel / build /
     test / lint surfaced.
   - After all chosen subsystems are covered, bump
     `backfilled_from_sha:` and `last_revised:` on all three bedrock
     files. Write an episode tagged `<repo>, backfill, <subsystem>`.

   Then stop. Don't try to "finish" XLA in one session.

For ordinary Python repos, continue with the
linear flow below.

1. Pull latest:
   !`bash ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/upstream-sync.sh $ARGUMENTS`

2. Read the existing bedrock to see what's there:
   - ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/guides/$ARGUMENTS/overview.md
   - ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/guides/$ARGUMENTS/architecture.md
   - ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/guides/$ARGUMENTS/conventions.md

3. Note the existing `backfilled_from_sha`. Get the current upstream tip:
   !`git -C ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/workspace/$ARGUMENTS rev-parse --short upstream/main`

4. If the existing bedrock looks accurate (small drift, no contradictions), just
   update each bedrock file's frontmatter:
   - Bump `backfilled_from_sha:` to the current sha
   - Bump `last_revised:` to today's date
   - Leave content alone.

5. If the diff between old sha and current sha touches subsystems mentioned in
   the bedrock, RE-EXPLORE those files and update the relevant bedrock sections
   in place. Per CLAUDE.md §7: revise on evidence, not on suspicion.

6. When done updating bedrock, clear the drift report:
   !`rm -f ${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/.drift-reports/$ARGUMENTS.md`

7. Write a short episode noting the drift you addressed and what changed.

Report:
- Old sha → new sha
- Which bedrock files (if any) were substantively rewritten
- Word count delta
- Whether you wrote a follow-up episode
