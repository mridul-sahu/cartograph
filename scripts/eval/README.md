# Eval harness — does the injection actually help?

The regression suite for Cartograph's core hypothesis ("orientation makes
sessions faster and more correct"). Golden questions per repo, each graded
against regex groups; every question runs as a headless `claude -p` session
rooted in `workspace/<repo>` under two arms:

- **on** — normal orientation injection
- **off** — `CARTOGRAPH_INJECT_DISABLE=1`, same tools, no injection

```
scripts/eval/run-eval.sh                  # everything, both arms
scripts/eval/run-eval.sh --repo orbax     # one repo
scripts/eval/run-eval.sh --arm on --limit 5
```

Results append to `.cartograph/eval/results-<ts>.jsonl` (one record per
run: score, pass, num_turns, duration, cost) and a per-arm summary prints
at the end. The interesting deltas: `mean_score` / `pass_rate` (does the
injection improve correctness) and `mean_turns` / `mean_wall` (does it
reduce exploration).

Run this **before and after any retrieval or injection change**. A change
that cuts tokens but drops the on-arm pass rate is a regression, not a win.

## Golden questions (`golden/<repo>.jsonl`)

One JSON object per line:

```json
{"id": "orbax-01", "repo": "orbax", "question": "...",
 "expect_all": [["regexA1", "regexA2"], ["regexB1"]]}
```

`expect_all` semantics: every group must have ≥1 case-insensitive regex
match in the answer. Groups test distinct facts (symbol, module, behavior);
regexes avoid words echoed from the question so answers can't pass on echo.

Questions must stay answerable from repo knowledge alone — they're phrased
as plain developer questions and never mention Cartograph or the guides.
When bedrock gets revised in a way that invalidates a question, fix the
question in the same commit.

Runs are sequential, read-only (`--allowedTools Read,Grep,Glob`), and set
`CARTOGRAPH_HEADLESS=1` so SessionStart/Stop hooks skip heavy and
self-spawning paths — an eval run never enqueues curation work.

**Run evals on a quiet machine.** Concurrent agent fan-outs contend for
API throughput and degrade eval sessions into 1-2-turn no-exploration
answers that score 0 on both arms — measured 2026-06-10: the same
question scored 0.00/2 turns under contention and 1.00/12 turns alone.
Contaminated runs look plausible in aggregate; check `answer_head` and
`num_turns` before trusting any baseline.
