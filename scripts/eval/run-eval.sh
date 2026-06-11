#!/usr/bin/env bash
# scripts/eval/run-eval.sh — golden-question eval: does Cartograph's
# orientation injection measurably help?
#
# For each question in scripts/eval/golden/<repo>.jsonl, runs a headless
# `claude -p` session rooted in workspace/<repo> under two arms:
#   on  — normal orientation (UserPromptSubmit injection fires)
#   off — CARTOGRAPH_INJECT_DISABLE=1 (no injection; same tools)
# Grades each answer against the question's expect_all regex groups and
# appends one JSONL record per run to .cartograph/eval/results-<ts>.jsonl,
# then prints a per-arm summary (score, turns, duration).
#
# This is the regression suite for every retrieval/injection change: run
# it before and after, compare the arms. Without it, tuning is vibes.
#
# Usage:
#   scripts/eval/run-eval.sh [--repo <repo>] [--arm on|off|both]
#                            [--limit N] [--model <model>]
#
# Runs are sequential and read-only (--allowedTools Read,Grep,Glob).
# CARTOGRAPH_HEADLESS=1 is set so SessionStart/Stop hooks skip their heavy
# and self-spawning paths — an eval run must never enqueue curation work.

set -uo pipefail

source "$(dirname "$0")/../lib/load-config.sh"

GOLDEN_DIR="$CARTOGRAPH_ROOT/scripts/eval/golden"
OUT_DIR="$CARTOGRAPH_ROOT/.cartograph/eval"
WORKSPACE="$CARTOGRAPH_ROOT/workspace"
MAX_TURNS="${CARTOGRAPH_EVAL_MAX_TURNS:-30}"
TIMEOUT_S="${CARTOGRAPH_EVAL_TIMEOUT:-300}"

repo_filter=""
arm="both"
limit=0
model=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)  repo_filter="$2"; shift 2 ;;
    --arm)   arm="$2"; shift 2 ;;
    --limit) limit="$2"; shift 2 ;;
    --model) model="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v claude >/dev/null 2>&1 || { echo "claude CLI not found" >&2; exit 78; }
[[ -d "$GOLDEN_DIR" ]] || { echo "no golden questions at $GOLDEN_DIR" >&2; exit 1; }

mkdir -p "$OUT_DIR"
ts="$(date -u +%Y%m%d-%H%M%S)"
results="$OUT_DIR/results-$ts.jsonl"

arms=()
case "$arm" in
  on)   arms=(on) ;;
  off)  arms=(off) ;;
  both) arms=(on off) ;;
  *) echo "bad --arm: $arm" >&2; exit 2 ;;
esac

# Collect questions (optionally repo-filtered / limited).
questions="$(cat "$GOLDEN_DIR"/*.jsonl 2>/dev/null | grep -v '^\s*$')"
if [[ -n "$repo_filter" ]]; then
  questions="$(printf '%s\n' "$questions" | grep -F "\"repo\": \"$repo_filter\"" || true)"
fi
if (( limit > 0 )); then
  questions="$(printf '%s\n' "$questions" | head -n "$limit")"
fi
[[ -z "$questions" ]] && { echo "no questions matched" >&2; exit 1; }

n_total="$(printf '%s\n' "$questions" | grep -c .)"
echo "[eval] $n_total questions × ${#arms[@]} arm(s) → $results"

run_one() {  # $1=question-json $2=arm
  local qjson="$1" qarm="$2"
  local qid qrepo qtext
  qid="$(printf '%s' "$qjson" | jq -r '.id')"
  qrepo="$(printf '%s' "$qjson" | jq -r '.repo')"
  qtext="$(printf '%s' "$qjson" | jq -r '.question')"

  local cwd="$WORKSPACE/$qrepo"
  [[ -d "$cwd" ]] || { echo "[eval] skip $qid — no workspace/$qrepo" >&2; return 0; }

  local disable=0
  [[ "$qarm" == "off" ]] && disable=1

  local model_args=()
  [[ -n "$model" ]] && model_args=(--model "$model")

  local started ended out rc
  started="$(date +%s)"
  out="$(cd "$cwd" && \
    CARTOGRAPH_HEADLESS=1 CARTOGRAPH_USAGE_FREEZE=1 CARTOGRAPH_INJECT_DISABLE="$disable" \
    timeout "$TIMEOUT_S" claude -p "$qtext" \
      --output-format json --max-turns "$MAX_TURNS" \
      --allowedTools "Read,Grep,Glob" \
      ${model_args[@]+"${model_args[@]}"} 2>/dev/null)" || rc=$?
  ended="$(date +%s)"

  QJSON="$qjson" OUT="$out" ARM="$qarm" WALL="$((ended - started))" \
    python3 - "$results" <<'PY' 2>/dev/null || \
    echo "[eval] $qid/$qarm — grade/parse failure" >&2
import json, os, re, sys
q = json.loads(os.environ["QJSON"])
raw = os.environ.get("OUT", "")
try:
    resp = json.loads(raw)
except ValueError:
    resp = {}
answer = resp.get("result") or ""
# Refusals are not answers. An exhausted usage limit or an overload error
# comes back as plausible result text and silently poisons the baseline
# (observed 2026-06-10: 6 questions "failed" both arms with "You've hit
# your session limit"). Flag, don't grade.
ERROR_SHAPES = (
    r"hit your session limit",
    r"rate.?limit",
    r"overloaded",
    r"usage limit",
    r"api error",
)
run_error = next((p for p in ERROR_SHAPES if re.search(p, answer[:200], re.IGNORECASE)), None)
groups = q.get("expect_all", [])
hit = sum(
    1 for grp in groups
    if any(re.search(rx, answer, re.IGNORECASE) for rx in grp)
)
rec = {
    "id": q["id"],
    "repo": q["repo"],
    "arm": os.environ["ARM"],
    "error": run_error,
    "score": None if run_error else (round(hit / len(groups), 3) if groups else 0.0),
    "pass": (not run_error) and bool(groups) and hit == len(groups),
    "num_turns": resp.get("num_turns"),
    "duration_ms": resp.get("duration_ms"),
    "wall_s": int(os.environ["WALL"]),
    "cost_usd": resp.get("total_cost_usd"),
    "answered": bool(answer),
    # Diagnosis lifeline: a 2-turn run scoring 0 reads very differently
    # if the snippet is a rate-limit apology vs a confident wrong answer.
    "answer_head": answer[:400],
}
with open(sys.argv[1], "a") as fh:
    fh.write(json.dumps(rec) + "\n")
if run_error:
    print(f"[eval] {rec['id']:14s} {rec['arm']:3s} ERROR ({run_error}) — not graded")
else:
    print(f"[eval] {rec['id']:14s} {rec['arm']:3s} score={rec['score']:.2f} "
          f"turns={rec['num_turns']} wall={rec['wall_s']}s")
PY
}

while IFS= read -r q; do
  [[ -z "$q" ]] && continue
  for a in "${arms[@]}"; do
    run_one "$q" "$a"
  done
done <<<"$questions"

echo
echo "[eval] summary ($results):"
python3 - "$results" <<'PY'
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
by_arm = collections.defaultdict(list)
errored = 0
for r in rows:
    if r.get("error"):
        errored += 1
        continue
    by_arm[r["arm"]].append(r)
for arm, rs in sorted(by_arm.items()):
    n = len(rs)
    mean = lambda k: sum(r[k] or 0 for r in rs) / n if n else 0
    print(f"  arm={arm:3s} n={n:3d} mean_score={mean('score'):.2f} "
          f"pass_rate={sum(r['pass'] for r in rs)/n:.0%} "
          f"mean_turns={mean('num_turns'):.1f} mean_wall={mean('wall_s'):.0f}s")
if errored:
    print(f"  ({errored} errored run(s) excluded — rerun those questions)")
PY
