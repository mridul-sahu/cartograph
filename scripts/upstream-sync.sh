#!/usr/bin/env bash
# Pre-session: fetch upstream for the fork at cwd; fast-forward the tracked
# branch ONLY if safe (on tracked branch + clean tree + ff-possible); then
# push the synced branch to the fork's origin so origin/<branch> never lags
# the local checkout (opt out with CARTOGRAPH_SYNC_PUSH=0).
# Intended to run as a Claude Code SessionStart hook from
# cartograph/.claude/settings.json. Safe to run anywhere — exits cleanly if
# cwd is not inside a workspace/<repo>/.
#
# Manual use: scripts/upstream-sync.sh [<repo>]
#   With no arg, infers repo from cwd. With an arg, syncs that specific fork.

set -euo pipefail

# Derive paths from the script's own location so this works wherever cartograph
# is cloned. Env overrides still win.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
WORKSPACE="${CARTOGRAPH_WORKSPACE:-$CARTOGRAPH_ROOT/workspace}"

# 1. Resolve which fork to operate on.
if [[ $# -ge 1 ]]; then
  REPO="$1"
  FORK_DIR="$WORKSPACE/$REPO"
else
  CWD="$(pwd -P)"
  WORKSPACE_REAL="$(cd "$WORKSPACE" 2>/dev/null && pwd -P || echo "$WORKSPACE")"
  if [[ "$CWD" != "$WORKSPACE_REAL"/* ]]; then
    exit 0  # Not in a fork; silent no-op.
  fi
  REL="${CWD#$WORKSPACE_REAL/}"
  REPO="${REL%%/*}"
  FORK_DIR="$WORKSPACE_REAL/$REPO"
fi

if [[ ! -d "$FORK_DIR/.git" ]]; then
  echo "upstream-sync: $FORK_DIR is not a git repo; skipping" >&2
  exit 0
fi

cd "$FORK_DIR"

# 2. Verify upstream remote exists.
if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "upstream-sync: no 'upstream' remote in $REPO; skipping" >&2
  exit 0
fi

# 3. Fetch + determine tracked branch.
#    Chicken-and-egg: upstream/HEAD doesn't exist until we've fetched.
#    Strategy: if upstream/HEAD is known, fetch just that branch (fast path).
#              Otherwise, fetch all upstream refs, then auto-set HEAD.
pre_sha=""
if git symbolic-ref --quiet refs/remotes/upstream/HEAD >/dev/null 2>&1; then
  TRACKED_BRANCH="$(git symbolic-ref --short refs/remotes/upstream/HEAD | sed 's#^upstream/##')"
  pre_sha="$(git rev-parse "upstream/$TRACKED_BRANCH" 2>/dev/null || echo "")"
  echo "upstream-sync: $REPO ← upstream/$TRACKED_BRANCH"
  if ! git fetch --quiet upstream "$TRACKED_BRANCH"; then
    echo "upstream-sync: fetch failed" >&2
    exit 0
  fi
else
  echo "upstream-sync: $REPO ← initial upstream fetch (resolving default branch)"
  if ! git fetch --quiet upstream; then
    echo "upstream-sync: fetch failed" >&2
    exit 0
  fi
  git remote set-head upstream --auto >/dev/null 2>&1 || true
  TRACKED_BRANCH=""
  if git symbolic-ref --quiet refs/remotes/upstream/HEAD >/dev/null 2>&1; then
    TRACKED_BRANCH="$(git symbolic-ref --short refs/remotes/upstream/HEAD | sed 's#^upstream/##')"
  fi
  [[ -z "$TRACKED_BRANCH" ]] && TRACKED_BRANCH="main"
fi

post_sha="$(git rev-parse "upstream/$TRACKED_BRANCH")"

# 4. Report new commits.
if [[ -n "$pre_sha" && "$pre_sha" != "$post_sha" ]]; then
  new_count="$(git rev-list --count "$pre_sha".."$post_sha")"
  echo "upstream-sync: $new_count new upstream commit(s)"
  git log --oneline --no-decorate -n 5 "$pre_sha".."$post_sha" | sed 's/^/  /'
elif [[ -z "$pre_sha" ]]; then
  echo "upstream-sync: upstream/$TRACKED_BRANCH at $(git rev-parse --short "$post_sha")"
else
  echo "upstream-sync: already up to date"
fi

# 5. Fast-forward the local tracked branch only if safe.
current_branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo DETACHED)"
if [[ "$current_branch" != "$TRACKED_BRANCH" ]]; then
  echo "upstream-sync: on '$current_branch' (not '$TRACKED_BRANCH'); skipping merge"
  exit 0
fi

if ! git diff --quiet --ignore-submodules HEAD || ! git diff --cached --quiet --ignore-submodules; then
  echo "upstream-sync: working tree has changes; skipping merge"
  exit 0
fi

if [[ "$(git rev-parse HEAD)" == "$post_sha" ]]; then
  : # Already at upstream tip — nothing to merge, but step 6 still syncs origin.
elif git merge-base --is-ancestor HEAD "upstream/$TRACKED_BRANCH"; then
  git merge --ff-only --quiet "upstream/$TRACKED_BRANCH"
  echo "upstream-sync: fast-forwarded $TRACKED_BRANCH to upstream/$TRACKED_BRANCH"
else
  ahead="$(git rev-list --count "upstream/$TRACKED_BRANCH"..HEAD)"
  echo "upstream-sync: local $TRACKED_BRANCH is $ahead commit(s) ahead of upstream; skipping merge"
fi

# 6. Keep the fork's origin in sync with the local copy. upstream-sync
#    fast-forwards the local branch but the fork's origin/<branch> would
#    otherwise lag behind — push so they never diverge. Fast-forward push
#    only (never --force); if origin has diverged, skip and report.
#    Opt out with CARTOGRAPH_SYNC_PUSH=0.
if [[ "${CARTOGRAPH_SYNC_PUSH:-1}" != "0" ]] && git remote get-url origin >/dev/null 2>&1; then
  git fetch --quiet origin "$TRACKED_BRANCH" 2>/dev/null || true
  head_sha="$(git rev-parse HEAD)"
  if git rev-parse --verify --quiet "origin/$TRACKED_BRANCH" >/dev/null; then
    origin_sha="$(git rev-parse "origin/$TRACKED_BRANCH")"
    if [[ "$origin_sha" == "$head_sha" ]]; then
      : # origin already matches the local copy.
    elif git merge-base --is-ancestor "origin/$TRACKED_BRANCH" HEAD; then
      n="$(git rev-list --count "origin/$TRACKED_BRANCH"..HEAD)"
      if git push --quiet origin "$TRACKED_BRANCH"; then
        echo "upstream-sync: pushed $n commit(s) to origin/$TRACKED_BRANCH"
      else
        echo "upstream-sync: push to origin/$TRACKED_BRANCH failed; push manually" >&2
      fi
    else
      echo "upstream-sync: origin/$TRACKED_BRANCH has diverged from local; not pushing"
    fi
  elif git push --quiet -u origin "$TRACKED_BRANCH"; then
    echo "upstream-sync: pushed $TRACKED_BRANCH to origin (new branch)"
  fi
fi

# After every pull, run drift-check for this repo. Writes .drift-reports/<repo>.md
# if the bedrock's backfilled_from_sha is behind the new upstream tip.
if [[ -x "$CARTOGRAPH_ROOT/scripts/drift-check.sh" ]]; then
  "$CARTOGRAPH_ROOT/scripts/drift-check.sh" "$REPO" || true
fi

exit 0
