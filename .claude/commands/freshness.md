---
description: Show upstream sha and age for each tracked fork
allowed-tools: Bash
---

Show per-fork upstream freshness:

!`for d in "${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"/workspace/*/; do [[ -d "$d/.git" ]] || continue; repo="$(basename "$d")"; sha="$(git -C "$d" rev-parse --short upstream/main 2>/dev/null || echo 'unfetched')"; head="$(git -C "$d" rev-parse --short HEAD 2>/dev/null)"; branch="$(git -C "$d" symbolic-ref --short HEAD 2>/dev/null || echo 'DETACHED')"; ahead=$(git -C "$d" rev-list --count upstream/main..HEAD 2>/dev/null || echo "?"); behind=$(git -C "$d" rev-list --count HEAD..upstream/main 2>/dev/null || echo "?"); printf "%-10s branch=%s head=%s upstream=%s (ahead=%s behind=%s)\n" "$repo" "$branch" "$head" "$sha" "$ahead" "$behind"; done`

Summarize: which forks are behind upstream, which (if any) have local commits
ahead. Suggest running `./scripts/upstream-sync.sh <repo>` for ones behind.
