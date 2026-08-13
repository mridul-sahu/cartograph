#!/usr/bin/env bash
# UserPromptSubmit hook: assembles layered Cartograph context for the current turn.
# Reads JSON from stdin (Claude Code hook contract); prints layered context to stdout.
#
# Priority per plan §9:
#   1. Bedrock for cwd's repo (overview, architecture, conventions)
#   2. Cross-repo seams
#   3. Top-3 topic notes by keyword overlap
#   4. Top-3 non-superseded, non-distilled episodes by keyword overlap (repo-scoped)
#   5. Revision reminder

set -euo pipefail

# Kill switch — the eval harness uses this to measure sessions without
# orientation (injection on vs off). Also handy for debugging hook cost.
[[ "${CARTOGRAPH_INJECT_DISABLE:-0}" == "1" ]] && exit 0

source "$(dirname "$0")/lib/load-config.sh"
source "$(dirname "$0")/lib/note-usage.sh"

RANKER="$(dirname "$0")/lib/rank-notes.py"
# lean (default): top-1 note in full + a menu of the next N-1 (title,
# summary, path) the agent pulls with Read. full: legacy top-3 full bodies.
INJECT_MODE="${CARTOGRAPH_INJECT_MODE:-lean}"
INJECT_TOP="${CARTOGRAPH_INJECT_TOP:-8}"

WORKSPACE="$CARTOGRAPH_ROOT/workspace"
GUIDES="$CARTOGRAPH_ROOT/guides"
EPISODES="$CARTOGRAPH_ROOT/episodes"
# Per-session log of which notes got injected this session — appended to by
# every turn, consumed once at Stop by update-note-usage.sh. The current
# session's log path lives in sessions/.current-session.
SESSION_LOG="$(cat "$CARTOGRAPH_ROOT/sessions/.current-session" 2>/dev/null || true)"

# Helper used at each layer below to record an injection in the session log
# (for end-of-session usage analysis) and bump the per-note counter.
record_injection() {
  # Eval runs set CARTOGRAPH_USAGE_FREEZE=1: they must see normal injection
  # but never write usage counters or the interactive session's log —
  # 54 graded runs would otherwise bury the real usage signal.
  [[ "${CARTOGRAPH_USAGE_FREEZE:-0}" == "1" ]] && return 0
  local note_path="$1"
  # Relative path inside cartograph root for consistent keys.
  local rel="${note_path#$CARTOGRAPH_ROOT/}"
  if [[ -n "$SESSION_LOG" && -f "$SESSION_LOG" ]]; then
    printf '<!-- injected: %s -->\n' "$rel" >> "$SESSION_LOG"
  fi
  note_usage_bump_injected "$rel" >/dev/null 2>&1 || true
}

# 0. Read JSON payload from stdin. Tolerate missing/empty input (manual invocation).
payload="$(cat 2>/dev/null || true)"
prompt=""
hook_cwd=""
session_id=""
if command -v jq >/dev/null 2>&1 && [[ -n "$payload" ]]; then
  prompt="$(echo "$payload" | jq -r '.prompt // .user_prompt // empty' 2>/dev/null || true)"
  hook_cwd="$(echo "$payload" | jq -r '.cwd // empty' 2>/dev/null || true)"
  session_id="$(echo "$payload" | jq -r '.session_id // empty' 2>/dev/null || true)"
fi

# Determine scope. Prefer hook-provided cwd; fall back to actual pwd.
CWD="${hook_cwd:-$(pwd -P)}"

# Resolve realpaths for prefix matching.
real_or_self() { (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }
WORKSPACE_REAL="$(real_or_self "$WORKSPACE")"
CARTOGRAPH_REAL="$(real_or_self "$CARTOGRAPH_ROOT")"

REPO=""
SCOPE="outside"
if [[ "$CWD" == "$WORKSPACE_REAL"/* ]]; then
  REL="${CWD#$WORKSPACE_REAL/}"
  REPO="${REL%%/*}"
  SCOPE="fork"
elif [[ "$CWD" == "$CARTOGRAPH_REAL"/* ]]; then
  SCOPE="cartograph"
fi

# Outside cartograph entirely — no injection.
[[ "$SCOPE" == "outside" ]] && exit 0

# Inside cartograph (the tool's own source) — no injection either; Claude is editing
# Cartograph itself, not navigating a tracked codebase.
[[ "$SCOPE" == "cartograph" ]] && exit 0

# Fork scope. Build the layered injection.
{
  echo "<cartograph-context>"
  echo

  # Layer 1a: identity + discipline reminder (HARD — every turn).
  # The bulk text uses a quoted heredoc (<<'EOF') so backticks inside
  # examples like `rejected: true` and `path/to/file.py:NNN` aren't
  # evaluated as command substitution. The two $REPO references are
  # printed separately above the quoted block.
  echo "[identity] You are in workspace/$REPO operating as ${CARTOGRAPH_GITHUB_USER:-the configured GitHub user}."
  cat <<'EOF'
No Co-Authored-By: Claude trailers. No mention of Cartograph / Claude / Anthropic
(or any CARTOGRAPH_FORBIDDEN_EXTRAS) in commits, branches, PRs, or code
comments. No generic comments — only WHY notes when non-obvious. See
cartograph/CLAUDE.md §5.2.

EOF

  # ── FIRST-TURN PUBLISH GATE — load-bearing ─────────────────────────────
  # Long-running sessions tend to forget to publish episodes until Stop fires.
  # We close that gap by forcing `/loop 20m /checkpoint` setup at session
  # start. The /loop fires /checkpoint every 20 min IN THIS SAME SESSION,
  # giving the agent (with full working context) the chance to write an
  # episode mid-session instead of relying on a Stop-time reconstruction.
  #
  # Detection: grep the current session log for a "/loop" tool-use entry.
  # If absent, this is either the first turn OR the agent hasn't set up
  # the loop yet — either way, surface the instruction.
  loop_set=""
  current_session_log="$(cat "$CARTOGRAPH_ROOT/sessions/.current-session" 2>/dev/null || echo "")"
  if [[ -n "$current_session_log" && -f "$current_session_log" ]]; then
    if grep -qE '^- [0-9:]+  Skill  loop\b|/loop[[:space:]]' "$current_session_log" 2>/dev/null; then
      loop_set="yes"
    fi
  fi
  if [[ -z "$loop_set" ]]; then
    cat <<'EOF'
⚠️  PUBLISH GATE — BEFORE ANSWERING THE USER'S PROMPT, DO THIS:

    Invoke the loop skill to schedule /checkpoint every 20 min:

        /loop 20m /checkpoint

    Why: long sessions lose mid-flow insights when episodes are deferred
    to Stop. /loop 20m /checkpoint fires the /checkpoint slash command
    every 20 minutes IN THIS SAME SESSION, so YOU (with the working
    context) write the episode — not a Stop-time reconstruction from
    the session log.

    This is non-optional discipline. Set it up once, on the first turn,
    then proceed with the user's prompt. After it's set, future turns
    will see "[publish gate] /loop already active" and skip this block.

EOF
  else
    echo "[publish gate] /loop already active — /checkpoint fires every 20 min."
    echo
  fi

  # ── DISCIPLINE — read every turn ─────────────────────────────────────────
  cat <<'EOF'

[DISCIPLINE — read this on every turn]
Cartograph compounds AUTOMATICALLY. The chassis already runs:
  • SessionStart → session-log + drift-check + auto-promote (≥3 episodes
                   on a tag → claude -p drafts a topic; reviewed topics
                   → claude -p folds into bedrock)
  • Stop → claude -p auto-drafts, in background: an episode (if ≥3 edits
                   + none written) AND research/paper notes (if the session
                   consulted external material — WebFetch/WebSearch)
  • UserPromptSubmit → injects bedrock + topics + episodes + research

Your job in this session is to make cartograph BETTER, not just BIGGER.
The hard rules:

  1. SEARCH BEFORE WRITING. The matching content is in the injection
     below. If your insight overlaps, REVISE IT IN PLACE — bump
     last_revised:, add a "## YYYY-MM-DD update:" section, never fork a
     new file with a similar slug. Bedrock is 3 files per repo, ever.
     Topic notes are one slug per topic.

  2. PICK THE RIGHT LAYER (decision table):
       task-driven insight from THIS session → episode (200-600w)
EOF
  echo "       external paper / RFC / design doc     → paper note (papers/$REPO/)"
  echo "       comparison / external context         → research note (research/$REPO/)"
  cat <<'EOF'
       stable mental model                   → revise existing topic note
       cross-repo edge                       → append to guides/seams.md

  3. DEFAULT-APPROVE SEMANTICS. Auto-promotion fires UNLESS:
       • an episode has `rejected: true`        → excluded from /promote
       • a topic has `rejected: true`           → excluded from auto-fold
       • a topic has no `reviewed_by_human:`    → eligible for auto but
                                                  bedrock fold waits for
                                                  human approval

     The human reviewing is opt-out (set rejected: true), not opt-in.

  4. EPISODES are auto-drafted on session-end when you forget. They land
     with `auto_drafted: true` so you can review later. You can preempt
     by writing one yourself before the Stop hook fires.

  5. CITE FILE:LINE. Bedrock + topic notes that don't cite specific
     `path/to/file.py:NNN` anchors don't survive content lint.

  6. See docs/integration.md for the full chassis; docs/revision-discipline.md
     for the decision table; docs/quality-bar.md for content floors.

EOF

  # Layer 1b: bedrock for this repo.
  #
  # Bedrock diet: the full bedrock + seams go out on the FIRST turn of a
  # session and every Nth turn after (compaction insurance); other turns
  # get one title line per file. A model that read the bedrock on turn 1
  # still holds it in context; re-sending ~20k tokens every turn was the
  # single largest interactive cost (claude-designs/cartograph/token-diet).
  # CARTOGRAPH_BEDROCK_REINJECT_EVERY=1 restores the legacy every-turn
  # behavior; a missing session id (manual invocation, /orient) always
  # injects in full.
  BEDROCK_EVERY="${CARTOGRAPH_BEDROCK_REINJECT_EVERY:-15}"
  bedrock_full=1
  turn_file=""
  if [[ -n "$session_id" && "$BEDROCK_EVERY" != "1" ]]; then
    state_dir="$CARTOGRAPH_ROOT/.cartograph/state/inject"
    mkdir -p "$state_dir"
    find "$state_dir" -type f -mtime +7 -delete 2>/dev/null || true
    turn_file="$state_dir/$session_id"
    turns=$(( $(cat "$turn_file" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "$turns" > "$turn_file"
    if (( (turns - 1) % BEDROCK_EVERY != 0 )); then
      bedrock_full=0
    fi
  fi
  case "$prompt" in
    */orient*)
      bedrock_full=1
      [[ -n "$turn_file" ]] && printf '1' > "$turn_file"
      ;;
  esac

  if [[ -d "$GUIDES/$REPO" ]]; then
    if (( bedrock_full )); then
      for f in overview.md architecture.md conventions.md heuristics.md; do
        path="$GUIDES/$REPO/$f"
        if [[ -f "$path" ]]; then
          echo "--- guides/$REPO/$f ---"
          cat "$path"
          echo
        fi
      done
      # Heuristics budget nag: the file is a curated playbook, not a log.
      # Over budget, the session must merge/evict before appending more.
      hpath="$GUIDES/$REPO/heuristics.md"
      if [[ -f "$hpath" ]]; then
        hbudget="$(grep -m1 '^budget_lines:' "$hpath" | grep -oE '[0-9]+' || echo 60)"
        hlines="$(grep -c . "$hpath" || true)"
        if (( hlines > hbudget )); then
          echo "[heuristics] OVER BUDGET: $hlines/$hbudget non-empty lines. Merge or"
          echo "  evict rules in guides/$REPO/heuristics.md before appending new ones."
          echo
        fi
      fi
    else
      echo "[bedrock] Injected in full earlier this session (still in your context):"
      for f in overview.md architecture.md conventions.md heuristics.md; do
        [[ -f "$GUIDES/$REPO/$f" ]] && echo "  - guides/$REPO/$f"
      done
      echo "  - guides/seams.md"
      echo "  Read any of these only if the earlier injection was compacted away;"
      echo "  /orient re-injects everything in full."
      echo
    fi
  fi

  # Layer 1c: drift report if upstream has advanced since last backfill.
  # Full on the same turns as bedrock; a one-line pointer otherwise.
  drift_report="$CARTOGRAPH_REAL/.drift-reports/$REPO.md"
  if [[ -f "$drift_report" ]]; then
    if (( bedrock_full )); then
      echo "--- .drift-reports/$REPO.md ---"
      cat "$drift_report"
      echo
      echo "[important] Bedrock above predates current upstream. If anything in the"
      echo "diff above contradicts the bedrock, update bedrock files in place and"
      echo "bump their backfilled_from_sha frontmatter to the current upstream sha."
      echo
    else
      echo "[drift] .drift-reports/$REPO.md is OPEN (injected in full earlier this"
      echo "  session). Resolve per CLAUDE.md §3b before trusting bedrock claims."
      echo
    fi
  fi

  # Layer 1d: surviving per-topic drift = this session's curation queue.
  # Mechanical re-anchoring (reanchor.py) has already run; what remains
  # needs judgment, and no background agent will do it (token diet).
  topics_drift_dir="$CARTOGRAPH_REAL/.drift-reports/topics/$REPO"
  if [[ -d "$topics_drift_dir" ]]; then
    topic_reports="$(find "$topics_drift_dir" -maxdepth 1 -name '*.md' 2>/dev/null | sort)"
    topic_report_count="$(printf '%s\n' "$topic_reports" | grep -c . 2>/dev/null || echo 0)"
    if (( topic_report_count > 0 )); then
      echo "[drift-work] $topic_report_count topic note(s) have citations needing judgment."
      echo "  Fix the ones touching your task now, and at least one regardless (§4):"
      printf '%s\n' "$topic_reports" | head -3 | while IFS= read -r r; do
        [[ -n "$r" ]] && echo "  - .drift-reports/topics/$REPO/$(basename "$r") -> guides/$REPO/topics/$(basename "$r")"
      done
      (( topic_report_count > 3 )) && echo "  (+$((topic_report_count - 3)) more under .drift-reports/topics/$REPO/)"
      echo "  Each: Read the report + cited regions; revise the note; bump last_revised."
      echo
    fi
  fi

  # Layer 1e: curation agenda for this repo (full turns only) — the
  # deterministic sleep-time analysis (near-dups, decay, coverage gaps,
  # open contradictions). Judgment work for THIS session; nothing in the
  # background will act on it.
  agenda="$CARTOGRAPH_REAL/.cartograph/state/curation-agenda.md"
  if (( bedrock_full )) && [[ -f "$agenda" ]]; then
    agenda_items="$(awk -v repo="## $REPO" '
      $0 ~ "^" repo { grab=1; next }
      /^## / { grab=0 }
      grab && /^- / { print }
    ' "$agenda" | head -3)"
    if [[ -n "$agenda_items" ]]; then
      echo "[curation-agenda] top items for $REPO (full list: .cartograph/state/curation-agenda.md):"
      printf '%s\n' "$agenda_items" | sed 's/^/  /'
      echo
    fi
  fi

  # Layer 2: cross-repo seams (same once-per-session diet as bedrock; the
  # lean turns list it in the bedrock reminder block above).
  if [[ -f "$GUIDES/seams.md" ]] && (( bedrock_full )); then
    echo "--- guides/seams.md ---"
    cat "$GUIDES/seams.md"
    echo
  fi

  # If no prompt text, skip keyword-based layers (no signal to match against).
  if [[ -z "$prompt" ]]; then
    echo "[reminder] If a topic note contradicts the code you read, revise it in place"
    echo "(plan §7). Write an episode at session end if anything was learned."
    echo
    echo "</cartograph-context>"
    exit 0
  fi

  # Extract keywords: lowercase, alnum+underscore only, length >= 4, dedupe, drop stopwords.
  stop='^(the|that|this|with|from|have|been|what|when|where|which|will|would|could|should|about|there|their|then|than|some|like|just|into|over|each|after|before|while|under|above|below|because|though|since|other|same|very|much|more|most|less|only|here|those|these|been|also|such|both|some|many)$'
  keywords="$(printf '%s' "$prompt" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cs 'a-z0-9_' '\n' \
    | awk 'length($0) >= 4' \
    | grep -vxE "$stop" \
    | sort -u)"

  # Cross-layer dedup ledger: every layer appends the note relpaths it
  # emitted; later layers (menus, file-index, BM25) skip anything already
  # surfaced this turn. Cleaned up when the subshell exits.
  emitted_file="$(mktemp "${TMPDIR:-/tmp}/cartograph-emitted.XXXXXX")"
  trap 'rm -f "$emitted_file"' EXIT

  # Session-level dedupe (token diet): notes already surfaced this session
  # (recorded in the session log by record_injection) are skipped on lean
  # turns — the agent already has them in context. Full turns (turn 1,
  # every Nth, /orient) start from a clean ledger, so a compacted session
  # recovers everything at the next full turn.
  if [[ "${CARTOGRAPH_INJECT_DEDUPE:-1}" == "1" ]] && (( ! bedrock_full )) \
     && [[ -n "$SESSION_LOG" && -f "$SESSION_LOG" ]]; then
    grep -oE '<!-- injected: [^>]+ -->' "$SESSION_LOG" 2>/dev/null \
      | sed -E 's/<!-- injected: (.*) -->/\1/' | sort -u >> "$emitted_file" || true
  fi

  bm25_index="$CARTOGRAPH_REAL/.cartograph/index/bm25.json"

  # Run rank-notes.py for one layer and record every emitted note in the
  # session log + usage counters. $1=dir $2=emit-mode $3=label $4=extra args...
  rank_layer() {
    local dir="$1" emit="$2" label="$3"; shift 3
    local before after
    # grep -c prints the count even when it's 0 (exit 1) — ignore the rc,
    # don't `|| echo 0` (that would append a second line and break (( )) ).
    before="$(grep -c . "$emitted_file" 2>/dev/null)" || true
    before="${before:-0}"
    printf '%s\n' "$keywords" | python3 "$RANKER" \
      --root "$CARTOGRAPH_ROOT" --dir "$dir" --emit "$emit" --label "$label" \
      --top "$INJECT_TOP" --index "$bm25_index" \
      --usage-file "$NOTE_USAGE_FILE" --emitted-file "$emitted_file" \
      "$@" 2>/dev/null || true
    after="$(grep -c . "$emitted_file" 2>/dev/null)" || true
    after="${after:-0}"
    if (( after > before )); then
      tail -n "$((after - before))" "$emitted_file" | while IFS= read -r rel; do
        [[ -n "$rel" ]] && record_injection "$CARTOGRAPH_ROOT/$rel"
      done
    fi
  }

  layer_emit="full1+menu"
  layer_top="$INJECT_TOP"
  if [[ "$INJECT_MODE" == "full" ]]; then
    layer_emit="full"
    layer_top=3
  fi
  INJECT_TOP="$layer_top"

  # Layer 3: topic notes — IDF-weighted keyword overlap + usage boost,
  # top-1 in full + a menu of the rest (lean mode). Proven-useful notes
  # rise via the usage boost; notes injected 5+ times and never used sink.
  if [[ -n "$keywords" ]]; then
    rank_layer "guides/$REPO/topics" "$layer_emit" "topic"
  fi

  # Layer 4: episodes (non-superseded, non-distilled, non-rejected,
  # repo-scoped). Same shape as topics.
  if [[ -n "$keywords" ]]; then
    rank_layer "episodes" "$layer_emit" "episode" --recursive --episode-filters --repo "$REPO"
  fi

  # Layer 5: research notes (repo-scoped) — menu only; they exist so the
  # agent UPDATES an existing note instead of starting a duplicate, which
  # the path + summary already enables.
  if [[ -n "$keywords" ]]; then
    research_emit="menu"
    [[ "$INJECT_MODE" == "full" ]] && research_emit="full"
    rank_layer "research/$REPO" "$research_emit" "research"
  fi

  # Layer 5a: path-token reverse-index lookup
  # If the prompt mentions any path-shaped token (foo.py, dir/file.cc, etc.),
  # surface every Cartograph note that already cites it. This is the
  # "/whatknows-without-asking" pass — happens automatically every turn.
  by_file_index="$CARTOGRAPH_REAL/.cartograph/index/by-file.json"
  if [[ -f "$by_file_index" ]]; then
    # Pull path-shaped tokens from the prompt.
    path_tokens="$(printf '%s' "$prompt" \
      | grep -oE '[a-zA-Z0-9_/.\-]+\.(py|pyi|cc|cpp|h|hh|hpp|c|ts|tsx|js|go|rs|bzl)' \
      | sort -u || true)"
    if [[ -n "$path_tokens" ]]; then
      python3 - "$by_file_index" "$emitted_file" <<PY 2>/dev/null
import json, sys
idx = json.loads(open(sys.argv[1]).read())
by_file = idx.get("by_file", {})
try:
    emitted = {l.strip() for l in open(sys.argv[2]) if l.strip()}
except OSError:
    emitted = set()
tokens = """${path_tokens}""".strip().split("\n")
printed_header = False
new_emits = []
LAYER_RANK = {"bedrock": 0, "topic": 1, "episode": 2, "research": 3, "paper": 4, "design": 5, "learn": 6}
for tok in tokens:
    tok = tok.strip()
    if not tok:
        continue
    hits = [(fp, e) for fp, e in by_file.items() if tok in fp]
    if not hits:
        continue
    # Use the most-specific (longest indexed-path) hit per token.
    hits.sort(key=lambda x: -len(x[0]))
    fp, entries = hits[0]
    entries = sorted(entries, key=lambda e: LAYER_RANK.get(e.get("layer") or "", 99))
    entries = [e for e in entries if e["note"] not in emitted]
    if not entries:
        continue
    if not printed_header:
        print("[file-index] notes citing path-shaped tokens in your prompt")
        print("[file-index] (auto-surfaced reverse index — read these before opening the file)")
        printed_header = True
    print(f"  ▸ {tok}  →  {fp}")
    for e in entries[:3]:
        layer = (e.get("layer") or "?")[:7]
        print(f"      [{layer:7}] {e['note']}")
        new_emits.append(e["note"])
if printed_header:
    print()
if new_emits:
    with open(sys.argv[2], "a") as fh:
        fh.writelines(n + "\n" for n in dict.fromkeys(new_emits))
PY
    fi
  fi

  # Layer 5b: BM25 rerank pass (catches semantic matches keyword overlap misses)
  if [[ -f "$bm25_index" ]] && [[ -n "$prompt" ]]; then
    python3 - "$bm25_index" "$REPO" "$CARTOGRAPH_REAL" "$emitted_file" <<PY 2>/dev/null
import json, sys, importlib.util
PROJECT = sys.argv[3]
spec = importlib.util.spec_from_file_location("_bm25", f"{PROJECT}/scripts/build-search-index.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
idx = json.loads(open(sys.argv[1]).read())
repo = sys.argv[2] if sys.argv[2] else None
try:
    emitted = {l.strip() for l in open(sys.argv[4]) if l.strip()}
except OSError:
    emitted = set()
prompt_text = """${prompt//\"/\\\"}"""
hits = mod.bm25_search(idx, prompt_text, k=8, repo=repo)
hits = [h for h in hits if h["path"] not in emitted][:5]
if hits:
    print("[bm25] semantic hits ranked by BM25 (complements keyword overlap above)")
    for h in hits:
        layer = (h.get("layer") or "?")[:7]
        score = h["score"]
        print(f"  {score:5.2f}  [{layer:7}] {h['path']}")
    print()
PY
  fi

  # Layer 6: revision + episode reminder + tools-available
  echo "[reminder] If a topic note contradicts the code you read, revise it in place"
  echo "(plan §7). Write an episode at session end if anything was learned."
  echo "[reminder] If a research note above already covers this topic, UPDATE"
  echo "it in place via /research <repo> <existing-slug> — don't create a duplicate."
  echo
  echo "[tools] Cartograph drill-downs available this turn:"
  echo "  /whatknows <path>   — reverse-index lookup (also fires automatically before Read of workspace files)"
  echo "  /cite <symbol>      — fixed-string grep across all layers, grouped"
  echo "  /find <natural-q>   — BM25 retrieval (use when wording differs from notes)"
  echo "  /queue              — what the chassis is asking you to review"
  if [[ -f "$CARTOGRAPH_REAL/.mcp.json" ]]; then
    echo "  MCP                 — cartograph_search / cartograph_notes_for_file / cartograph_drift (mid-loop callable)"
  fi
  echo
  echo "</cartograph-context>"
}
