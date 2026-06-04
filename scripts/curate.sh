#!/usr/bin/env bash
# scripts/curate.sh — the batched-curation queue + drain.
#
# Replaces the old "one nohup `claude -p` per item" fan-out. Hooks now
# ENQUEUE work (eligibility already decided by the caller); a single drain
# hands the WHOLE pending queue to ONE headless agent, under the global cap
# in lib/headless.sh. N agents → 1.
#
# Usage:
#   curate.sh enqueue fold     <repo> <topic-slug>
#   curate.sh enqueue promote  <repo> <tag>
#   curate.sh enqueue episode  <repo> <session-log-relpath>
#   curate.sh enqueue research <repo> <session-log-relpath>
#   curate.sh drain        # batch-process everything queued (1 agent)
#   curate.sh list         # show pending tasks

set -uo pipefail

# shellcheck source=lib/headless.sh
source "$(dirname "$0")/lib/headless.sh"   # also sets CARTOGRAPH_ROOT

QUEUE_DIR="$CARTOGRAPH_ROOT/.cartograph/curation-queue"

_cg_sanitize() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-'; }

# Record a task idempotently. The filename is the dedup key (so re-enqueuing
# the same topic is a no-op); the body carries the pipe-delimited args.
cg_enqueue() {
  local kind="${1:-}" a="${2:-}" b="${3:-}"
  [[ -n "$kind" && -n "$a" && -n "$b" ]] || {
    echo "curate enqueue: need <kind> <arg1> <arg2>" >&2; return 2
  }
  case "$kind" in
    fold|promote|episode|research) : ;;
    *) echo "curate: unknown kind '$kind'" >&2; return 2 ;;
  esac
  mkdir -p "$QUEUE_DIR"
  local key="${kind}__$(_cg_sanitize "$a")__$(_cg_sanitize "$b")"
  local file="$QUEUE_DIR/$key.task"
  [[ -f "$file" ]] && return 0          # already queued
  printf '%s|%s|%s\n' "$kind" "$a" "$b" > "$file"
}

# Append one task's instruction block to the batched prompt (stdout).
_cg_task_block() {
  local n="$1" kind="$2" a="$3" b="$4" today="$5"
  echo "### Task $n — $kind"
  echo
  case "$kind" in
    fold)
      cat <<EOF
Fold the topic note \`guides/$a/topics/$b.md\` into the SINGLE most relevant
bedrock file among \`guides/$a/{overview,architecture,conventions}.md\`.
- Read the topic note and the three bedrock files first.
- Surgical only: add ONE bullet / a 1–3 sentence reference (cross-linked to
  the topic note), or a short new subsection if nothing fits. Do NOT rewrite or
  restructure existing bedrock, and do NOT touch the other two bedrock files or
  the topic note body. If the topic CONTRADICTS bedrock, fix the contradicted
  sentence in place and add the reference.
- Bump \`last_revised: $today\` in the bedrock file you edit (leave its other
  frontmatter untouched).
- Then set \`folded_into_bedrock: $today\` in the topic note's frontmatter so it
  is not folded again.
EOF
      ;;
    promote)
      cat <<EOF
Distill the non-distilled, non-rejected episodes in repo \`$a\` tagged \`$b\`
into \`guides/$a/topics/$b.md\` (find them with Grep over episodes/). Revise the
topic note in place if it already exists — do not fork a v2.
- 1000–1500 words covering the COMMON insight; cite file:line anchors that
  appear in ≥2 source episodes; end with a "When to revise this note" section.
- Frontmatter: layer: topic, repo: $a, topic: $b, last_revised: $today,
  reviewed_by_human: ~, rejected: false, auto_promoted: true.
- Then set \`distilled_into: guides/$a/topics/$b.md\` on each source episode's
  frontmatter.
EOF
      ;;
    episode)
      cat <<EOF
Draft an episode for repo \`$a\` from the session log \`$b\` (read it first).
- Write to \`episodes/$(date +%Y-%m)/$today-$a-<slug>.md\` with frontmatter
  including \`auto_drafted: true\`, \`reviewed_by_human: ~\`, \`rejected: false\`,
  and \`source_session: $b\`.
- Be conservative: if the session was trivial, write 1–2 paragraphs saying so;
  do not invent details. Sections: what the task was / what I learned / what to
  tell a future session.
EOF
      ;;
    research)
      cat <<EOF
If the session log \`$b\` (repo \`$a\`) consulted external material worth
keeping, draft a research or paper note under \`research/$a/\` or \`papers/$a/\`
with \`auto_drafted: true\` in frontmatter. If the fetches were incidental,
write nothing for this task and say so in your summary.
EOF
      ;;
  esac
  echo
}

# Hand the whole queue to ONE headless agent.
cg_drain() {
  cg_autospawn_guard            # no-op unless inside an agent / kill switch on
  mkdir -p "$QUEUE_DIR"

  local tasks=() f
  while IFS= read -r f; do tasks+=("$f"); done \
    < <(find "$QUEUE_DIR" -maxdepth 1 -name '*.task' -type f 2>/dev/null | sort)
  (( ${#tasks[@]} == 0 )) && return 0

  # Cap one agent's session to a sane batch; the rest drain next interval.
  local batch_max="${CARTOGRAPH_CURATE_BATCH_MAX:-8}"
  local total="${#tasks[@]}"
  if (( total > batch_max )); then
    tasks=("${tasks[@]:0:batch_max}")
    echo "curate: $total queued; batching $batch_max this pass, rest next interval" >&2
  fi

  local today; today="$(date +%Y-%m-%d)"
  local prompt; prompt="$(mktemp -t cartograph-curate.XXXXXX)"
  {
    cat <<EOF
You are doing ONE batched curation pass for a knowledge base, from the repo
root. Complete every task below in this single session. Read the files each
task names; make SURGICAL, conservative edits; set the stated frontmatter
marker on each so it is not repeated. Do NOT run any background jobs, do NOT
invoke \`claude\`, and do NOT run scripts/auto-promote.sh or scripts/curate.sh.

EOF
    local n=0 kind a b
    for f in "${tasks[@]}"; do
      IFS='|' read -r kind a b < "$f"
      n=$((n + 1))
      _cg_task_block "$n" "$kind" "$a" "$b" "$today"
    done
    cat <<EOF
## After all tasks
Run \`bash scripts/lint-content.sh --human\` and report any NEW breakage you
introduced. Then print a one-line summary per task (what you changed, or why
you skipped it).
EOF
  } > "$prompt"

  echo "curate: draining ${#tasks[@]} task(s) via ONE headless agent" >&2
  local flags="${CARTOGRAPH_CURATE_CLAUDE_FLAGS:---print --output-format text --permission-mode acceptEdits --allowedTools Read,Edit,Write,Glob,Grep,Bash}"
  local rc=0
  # $flags is an intentional word-split flag list (per-flag tokens for the CLI).
  # shellcheck disable=SC2086
  cg_headless_run curate-drain -- $flags < "$prompt" || rc=$?
  rm -f "$prompt"

  if (( rc == 75 || rc == 77 )); then
    echo "curate: drain deferred/refused (rc=$rc) — queue kept for next interval" >&2
    return 0
  fi
  # Drain ran. Clear processed tasks; the frontmatter markers the agent set
  # stop re-enqueue, and anything still eligible is re-queued next SessionStart.
  for f in "${tasks[@]}"; do rm -f "$f"; done
  return "$rc"
}

cmd="${1:-}"
case "$cmd" in
  enqueue) shift; cg_enqueue "${1:-}" "${2:-}" "${3:-}" ;;
  drain)   cg_drain ;;
  list)    find "$QUEUE_DIR" -maxdepth 1 -name '*.task' -type f 2>/dev/null | sort ;;
  count)   find "$QUEUE_DIR" -maxdepth 1 -name '*.task' -type f 2>/dev/null | wc -l | tr -d ' ' ;;
  *) echo "usage: curate.sh {enqueue <kind> <a> <b>|drain|list|count}" >&2; exit 2 ;;
esac
