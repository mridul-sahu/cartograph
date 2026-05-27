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

source "$(dirname "$0")/lib/load-config.sh"
source "$(dirname "$0")/lib/note-usage.sh"

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
if command -v jq >/dev/null 2>&1 && [[ -n "$payload" ]]; then
  prompt="$(echo "$payload" | jq -r '.prompt // .user_prompt // empty' 2>/dev/null || true)"
  hook_cwd="$(echo "$payload" | jq -r '.cwd // empty' 2>/dev/null || true)"
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

  # Layer 1b: bedrock for this repo
  if [[ -d "$GUIDES/$REPO" ]]; then
    for f in overview.md architecture.md conventions.md; do
      path="$GUIDES/$REPO/$f"
      if [[ -f "$path" ]]; then
        echo "--- guides/$REPO/$f ---"
        cat "$path"
        echo
      fi
    done
  fi

  # Layer 1c: drift report if upstream has advanced since last backfill
  drift_report="$CARTOGRAPH_REAL/.drift-reports/$REPO.md"
  if [[ -f "$drift_report" ]]; then
    echo "--- .drift-reports/$REPO.md ---"
    cat "$drift_report"
    echo
    echo "[important] Bedrock above predates current upstream. If anything in the"
    echo "diff above contradicts the bedrock, update bedrock files in place and"
    echo "bump their backfilled_from_sha frontmatter to the current upstream sha."
    echo
  fi

  # Layer 2: cross-repo seams
  if [[ -f "$GUIDES/seams.md" ]]; then
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

  # Layer 3: top-3 topic notes by keyword hit count + usage boost.
  # Notes that got injected AND whose cited files were Read'd in past sessions
  # earn a small additive boost — proven-useful notes rise above equally-
  # relevant-by-keyword peers. See scripts/lib/note-usage.sh for the boost shape.
  TOPICS_DIR="$GUIDES/$REPO/topics"
  if [[ -d "$TOPICS_DIR" ]] && [[ -n "$keywords" ]]; then
    best_topics="$(
      for topic in "$TOPICS_DIR"/*.md; do
        [[ -f "$topic" ]] || continue
        score=0
        while IFS= read -r kw; do
          [[ -z "$kw" ]] && continue
          if grep -iqw -- "$kw" "$topic" 2>/dev/null; then
            score=$((score + 1))
          fi
        done <<<"$keywords"
        if (( score > 0 )); then
          rel="${topic#$CARTOGRAPH_ROOT/}"
          boost="$(note_usage_score_boost "$rel" 2>/dev/null || echo 0)"
          printf '%d\t%s\n' "$((score + boost))" "$topic"
        fi
      done | sort -rn -k1,1 | head -3 | cut -f2
    )"
    if [[ -n "$best_topics" ]]; then
      while IFS= read -r t; do
        [[ -z "$t" ]] && continue
        rel="${t#$CARTOGRAPH_REAL/}"
        echo "--- $rel ---"
        cat "$t"
        echo
        record_injection "$t"
      done <<<"$best_topics"
    fi
  fi

  # Layer 4: top-3 episodes (non-superseded, non-distilled, repo-scoped, keyword-matched)
  if [[ -d "$EPISODES" ]] && [[ -n "$keywords" ]]; then
    best_episodes="$(
      while IFS= read -r -d '' ep; do
        # Filter: skip if explicitly retired
        if grep -qE '^superseded_by:[[:space:]]*[^~[:space:]]' "$ep" 2>/dev/null; then continue; fi
        if grep -qE '^distilled_into:[[:space:]]*[^~[:space:]]' "$ep" 2>/dev/null; then continue; fi
        # Filter: only if repo matches (frontmatter `repo: <REPO>`); accept if no repo field
        if grep -qE '^repo:' "$ep" 2>/dev/null; then
          if ! grep -qE "^repo:[[:space:]]*$REPO\b" "$ep" 2>/dev/null; then continue; fi
        fi
        score=0
        while IFS= read -r kw; do
          [[ -z "$kw" ]] && continue
          if grep -iqw -- "$kw" "$ep" 2>/dev/null; then
            score=$((score + 1))
          fi
        done <<<"$keywords"
        if (( score > 0 )); then
          # Tiebreak by filename (YYYY-MM-DD prefix sorts as recency).
          printf '%d\t%s\t%s\n' "$score" "$(basename "$ep")" "$ep"
        fi
      done < <(find "$EPISODES" -type f -name '*.md' -print0 2>/dev/null) \
      | sort -rn -k1,1 -k2,2 | head -3 | cut -f3
    )"
    if [[ -n "$best_episodes" ]]; then
      while IFS= read -r e; do
        [[ -z "$e" ]] && continue
        rel="${e#$CARTOGRAPH_REAL/}"
        echo "--- $rel ---"
        cat "$e"
        echo
      done <<<"$best_episodes"
    fi
  fi

  # Layer 5: top-3 research notes by keyword overlap (repo-scoped)
  # Research notes are intermediate exploratory notes (external context,
  # tool comparisons, design rationale) — surfacing them avoids the trap
  # of starting a brand-new research note when an existing one already
  # covers the topic.
  RESEARCH_DIR="$CARTOGRAPH_ROOT/research/$REPO"
  if [[ -d "$RESEARCH_DIR" ]] && [[ -n "$keywords" ]]; then
    best_research="$(
      for note in "$RESEARCH_DIR"/*.md; do
        [[ -f "$note" ]] || continue
        score=0
        while IFS= read -r kw; do
          [[ -z "$kw" ]] && continue
          if grep -iqw -- "$kw" "$note" 2>/dev/null; then
            score=$((score + 1))
          fi
        done <<<"$keywords"
        if (( score > 0 )); then
          printf '%d\t%s\n' "$score" "$note"
        fi
      done | sort -rn -k1,1 | head -3 | cut -f2
    )"
    if [[ -n "$best_research" ]]; then
      echo "[research notes] existing notes that already cover keywords in your prompt"
      echo "[research notes] — UPDATE these in place instead of writing a new note."
      while IFS= read -r r; do
        [[ -z "$r" ]] && continue
        rel="${r#$CARTOGRAPH_REAL/}"
        echo "--- $rel ---"
        cat "$r"
        echo
      done <<<"$best_research"
    fi
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
      python3 - "$by_file_index" <<PY 2>/dev/null
import json, sys
idx = json.loads(open(sys.argv[1]).read())
by_file = idx.get("by_file", {})
tokens = """${path_tokens}""".strip().split("\n")
printed_header = False
LAYER_RANK = {"bedrock": 0, "topic": 1, "episode": 2, "research": 3, "paper": 4, "design": 5, "learn": 6}
for tok in tokens:
    tok = tok.strip()
    if not tok:
        continue
    hits = [(fp, e) for fp, e in by_file.items() if tok in fp]
    if not hits:
        continue
    if not printed_header:
        print("[file-index] notes citing path-shaped tokens in your prompt")
        print("[file-index] (auto-surfaced reverse index — read these before opening the file)")
        printed_header = True
    # Use the most-specific (longest indexed-path) hit per token.
    hits.sort(key=lambda x: -len(x[0]))
    fp, entries = hits[0]
    print(f"  ▸ {tok}  →  {fp}")
    entries = sorted(entries, key=lambda e: LAYER_RANK.get(e.get("layer") or "", 99))
    for e in entries[:3]:
        layer = (e.get("layer") or "?")[:7]
        print(f"      [{layer:7}] {e['note']}")
if printed_header:
    print()
PY
    fi
  fi

  # Layer 5b: BM25 rerank pass (catches semantic matches keyword overlap misses)
  bm25_index="$CARTOGRAPH_REAL/.cartograph/index/bm25.json"
  if [[ -f "$bm25_index" ]] && [[ -n "$prompt" ]]; then
    python3 - "$bm25_index" "$REPO" "$CARTOGRAPH_REAL" <<PY 2>/dev/null
import json, sys, importlib.util
PROJECT = sys.argv[3]
spec = importlib.util.spec_from_file_location("_bm25", f"{PROJECT}/scripts/build-search-index.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
idx = json.loads(open(sys.argv[1]).read())
repo = sys.argv[2] if sys.argv[2] else None
prompt_text = """${prompt//\"/\\\"}"""
hits = mod.bm25_search(idx, prompt_text, k=5, repo=repo)
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
