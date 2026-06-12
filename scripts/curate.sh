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
#   curate.sh enqueue anchor   <repo> <topic-slug>
#   curate.sh enqueue review   <repo|episodes> <slug>
#   curate.sh drain        # batch-process everything queued (1 agent)
#   curate.sh list         # show pending tasks
#   curate.sh log [n]      # show the last n batch outcomes (default 5)
#
# Per-task accounting: every drain writes a manifest to
# .cartograph/curate-log/<stamp>.batch and the agent reports each task to
# <stamp>.results. Tasks the agent didn't report as `done` keep their .task
# file and retry next drain; the miss is recorded in errors.log.

set -uo pipefail

# shellcheck source=lib/headless.sh
source "$(dirname "$0")/lib/headless.sh"   # also sets CARTOGRAPH_ROOT
# shellcheck source=lib/errors.sh
source "$(dirname "$0")/lib/errors.sh"

QUEUE_DIR="$CARTOGRAPH_ROOT/.cartograph/curation-queue"
CURATE_LOG_DIR="$CARTOGRAPH_ROOT/.cartograph/curate-log"

_cg_sanitize() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-'; }

# Record a task idempotently. The filename is the dedup key (so re-enqueuing
# the same topic is a no-op); the body carries the pipe-delimited args.
cg_enqueue() {
  local kind="${1:-}" a="${2:-}" b="${3:-}"
  [[ -n "$kind" && -n "$a" && -n "$b" ]] || {
    echo "curate enqueue: need <kind> <arg1> <arg2>" >&2; return 2
  }
  case "$kind" in
    fold|promote|episode|research|anchor|review) : ;;
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
  local n="$1" kind="$2" a="$3" b="$4" today="$5" key="$6"
  echo "### Task $n — $kind (task key: \`$key\`)"
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
    review)
      cat <<EOF
Auto-review one pending note for quality and bloat. Locate it first:
- if \`$a\` is \`episodes\`: the note is the unique Glob match of \`episodes/*/$b.md\`;
- otherwise it is \`guides/$a/topics/$b.md\`.
Read it fully, then judge it. APPROVE unless you find a CONCRETE defect:
  - factual contradiction with what the cited code actually does (spot-check
    1-2 of its file:NNN anchors against workspace/);
  - hallucinated function/API names;
  - missing critical anchors (a note about file X citing nothing in X);
  - stub / TODO / placeholder content;
  - trivially-obvious insight (restates what any reader of the file sees);
  - NEAR-DUPLICATE bloat: Grep episodes/ and guides/*/topics/ for the note's
    key terms — if another non-rejected note already covers the SAME insight
    (not merely the same subsystem), this one is redundant.
Then act, in this order:
1. ALWAYS write the opinion file \`.cartograph/jobs/opinion-<key>.json\`,
   where <key> is the note's repo-relative path with every \`/\` replaced by
   \`_\` and the trailing \`.md\` stripped
   (e.g. episodes/2026-06/foo.md → opinion-episodes_2026-06_foo.json).
   Single-line JSON, exactly these fields:
   {"status":"done","verdict":"approve|reject","reason":"<one sentence>","confidence":"high|medium|low","auto_review":true,"finished_at":"<UTC ISO8601>"}
2. AUTO-ACT only at high confidence (otherwise the opinion file is the only
   output — leave the note untouched):
   - reject + high → set \`rejected: true\` and add
     \`review_notes: <reason> (auto-review $today)\` in the note's
     frontmatter. NEVER delete the file.
   - near-duplicate + high → on the WEAKER of the pair set
     \`superseded_by: <repo-relative-path-of-the-better-note>\`. Weaker =
     fewer verified anchors / shallower insight. Both files stay on disk.
Be CONSERVATIVE: when in doubt, verdict approve at low confidence. Style
complaints are never defects.
EOF
      ;;
    anchor)
      cat <<EOF
Add missing canonical-file anchors to the topic note \`guides/$a/topics/$b.md\`.
- Read \`.cartograph/state/anchor-coverage.json\` and find the entry under
  \`gaps_by_repo.$a\` whose \`slug\` is \`$b\` — its \`missing\` list names the
  files that related episodes touched but the topic never cites.
- Read the topic note. For each missing file: if the topic body discusses that
  file's subsystem, add a \`path:NNN\` anchor where the claim lives (verify the
  line number against \`workspace/$a/\`). If it does not, skip it — false
  positive; say so in your results detail.
- Bump \`last_revised: $today\` only if at least one anchor was added.
EOF
      ;;
  esac
  echo
}

# Hand the whole queue to ONE headless agent.
cg_drain() {
  cg_autospawn_guard            # no-op unless inside an agent / kill switch on
  mkdir -p "$QUEUE_DIR" "$CURATE_LOG_DIR"

  # Drop accounting files past the 30-day history window.
  find "$CURATE_LOG_DIR" -maxdepth 1 -type f \
    \( -name '*.batch' -o -name '*.results' \) -mtime +30 -delete 2>/dev/null || true

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

  # Per-task accounting: manifest (what we handed over) + results (what the
  # agent reports back, one line per task). The pair is the batch's record.
  local stamp manifest results
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  manifest="$CURATE_LOG_DIR/$stamp.batch"
  results="$CURATE_LOG_DIR/$stamp.results"
  : > "$manifest"
  for f in "${tasks[@]}"; do basename "$f" .task >> "$manifest"; done

  local today; today="$(date +%Y-%m-%d)"
  local prompt; prompt="$(mktemp -t cartograph-curate.XXXXXX)"
  {
    cat <<EOF
You are doing ONE batched curation pass for a knowledge base, from the repo
root. Complete every task below in this single session. Read the files each
task names; make SURGICAL, conservative edits; set the stated frontmatter
marker on each so it is not repeated. Do NOT run any background jobs, do NOT
invoke \`claude\`, and do NOT run scripts/auto-promote.sh or scripts/curate.sh.

## Per-task result reporting (mandatory, for EVERY task)

As you finish (or give up on) each task, append EXACTLY ONE line for it to
this results file (absolute path):

  $results

Line format — three tab-separated fields:

  <task-key>	done|failed	<one-line detail>

Append via Bash with a real tab, e.g.:

  printf '%s\tdone\t%s\n' '<task-key>' 'what you changed' >> '$results'

Report \`done\` only when the task's edits actually landed on disk; report
\`failed\` with the reason otherwise. A task with no results line is treated
as failed and will be retried in a later pass.

EOF
    local n=0 kind a b key
    for f in "${tasks[@]}"; do
      IFS='|' read -r kind a b < "$f"
      key="$(basename "$f" .task)"
      n=$((n + 1))
      _cg_task_block "$n" "$kind" "$a" "$b" "$today" "$key"
    done
    cat <<EOF
## After all tasks
Confirm every task has its line in \`$results\`. Then run
\`bash scripts/lint-content.sh --human\` and report any NEW breakage you
introduced, plus a one-line summary per task (what you changed, or why you
skipped it).
EOF
  } > "$prompt"

  echo "curate: draining ${#tasks[@]} task(s) via ONE headless agent (batch $stamp)" >&2
  local flags="${CARTOGRAPH_CURATE_CLAUDE_FLAGS:---print --output-format text --permission-mode acceptEdits --allowedTools Read,Edit,Write,Glob,Grep,Bash}"
  local rc=0
  # $flags is an intentional word-split flag list (per-flag tokens for the CLI).
  # shellcheck disable=SC2086
  cg_headless_run curate-drain -- $flags < "$prompt" || rc=$?
  rm -f "$prompt"

  if (( rc == 75 || rc == 77 )); then
    echo "curate: drain deferred/refused (rc=$rc) — queue kept for next interval" >&2
    rm -f "$manifest" "$results"   # batch never ran — no history to keep
    return 0
  fi

  # Drain ran. Settle per task: a `done` results line clears the .task file;
  # `failed` or missing keeps it (it retries next drain) and is recorded.
  local key done_n=0 kept_n=0
  for f in "${tasks[@]}"; do
    key="$(basename "$f" .task)"
    if [[ -f "$results" ]] \
       && awk -F'\t' -v k="$key" '$1==k && $2=="done"{found=1} END{exit !found}' \
            "$results" 2>/dev/null; then
      rm -f "$f"
      done_n=$((done_n + 1))
    else
      kept_n=$((kept_n + 1))
      cg_log_error curate "task $key failed-or-unreported (batch $stamp) — kept for retry"
    fi
  done
  echo "curate: batch $stamp settled — $done_n done, $kept_n kept for retry" >&2
  return "$rc"
}

# Human-readable view of the last n batches (manifest joined with results).
cg_log_show() {
  local n="${1:-5}"
  local batches=() b
  while IFS= read -r b; do batches+=("$b"); done \
    < <(find "$CURATE_LOG_DIR" -maxdepth 1 -name '*.batch' -type f 2>/dev/null \
        | sort -r | head -n "$n")
  if (( ${#batches[@]} == 0 )); then
    echo "curate log: no batches recorded under $CURATE_LOG_DIR"
    return 0
  fi
  local results key line status detail count
  for b in "${batches[@]}"; do
    results="${b%.batch}.results"
    count="$(wc -l < "$b" | tr -d ' ')"
    echo "batch $(basename "$b" .batch) — $count task(s)"
    while IFS= read -r key; do
      [[ -z "$key" ]] && continue
      line=""
      [[ -f "$results" ]] \
        && line="$(awk -F'\t' -v k="$key" '$1==k{print; exit}' "$results" 2>/dev/null)"
      if [[ -n "$line" ]]; then
        status="$(printf '%s\n' "$line" | cut -f2)"
        detail="$(printf '%s\n' "$line" | cut -f3-)"
        printf '  %-11s %-46s %s\n' "$status" "$key" "$detail"
      else
        printf '  %-11s %s\n' "unreported" "$key"
      fi
    done < "$b"
  done
}

cmd="${1:-}"
case "$cmd" in
  enqueue) shift; cg_enqueue "${1:-}" "${2:-}" "${3:-}" ;;
  drain)   cg_drain ;;
  list)    find "$QUEUE_DIR" -maxdepth 1 -name '*.task' -type f 2>/dev/null | sort ;;
  count)   find "$QUEUE_DIR" -maxdepth 1 -name '*.task' -type f 2>/dev/null | wc -l | tr -d ' ' ;;
  log)     shift; cg_log_show "${1:-5}" ;;
  *) echo "usage: curate.sh {enqueue <kind> <a> <b>|drain|list|count|log [n]}" >&2; exit 2 ;;
esac
