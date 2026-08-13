#!/usr/bin/env python3
"""Retrieval-only eval: score the injection against golden questions, no LLM.

The full harness (run-eval.sh) grades LLM answers and costs dozens of
model runs. This scores the RETRIEVAL layer alone: for each golden
question, run the same ranking the orientation hook runs (rank-notes.py
over topics, episodes, research) and check how many of the question's
`expect_all` evidence groups appear anywhere in the emitted content. If
the injected notes contain the evidence, a competent session can answer;
if they don't, no amount of prompting fixes it.

Metrics per repo: mean group coverage (fraction of expect_all groups
present in the injection output) and full-coverage rate (questions whose
groups were all present). Run after ANY retrieval change (ranking,
injection shape, note edits) and diff against the committed baseline:

  python3 scripts/eval/retrieval-eval.py [repo ...] [--update-baseline]

Baseline: scripts/eval/retrieval-baseline.json. Zero tokens spent.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS = ROOT / "scripts"
GOLDEN = Path(__file__).resolve().parent / "golden"
BASELINE = Path(__file__).resolve().parent / "retrieval-baseline.json"

STOPWORDS = set(
    "the that this with from have been what when where which will would could "
    "should about there their then than some like just into over each after "
    "before while under above below because though since other same very much "
    "more most less only here those these also such both many".split()
)


def keywords_of(question: str) -> str:
    toks = re.findall(r"[a-z0-9_]+", question.lower())
    return "\n".join(sorted({t for t in toks if len(t) >= 4 and t not in STOPWORDS}))


def rank_output(repo: str, kws: str) -> str:
    """Run the same layers the orientation hook runs; concatenated output."""
    layers = [
        (f"guides/{repo}/topics", "topic", []),
        ("episodes", "episode", ["--recursive", "--episode-filters", "--repo", repo]),
        (f"research/{repo}", "research", []),
    ]
    chunks = []
    for d, label, extra in layers:
        r = subprocess.run(
            [sys.executable, str(SCRIPTS / "lib" / "rank-notes.py"),
             "--root", str(ROOT), "--dir", d, "--emit", "full1+menu",
             "--label", label, "--top", "8",
             "--index", str(ROOT / ".cartograph" / "index" / "bm25.json"),
             *extra],
            input=kws, capture_output=True, text=True, timeout=60,
        )
        chunks.append(r.stdout)
    return "\n".join(chunks).lower()


def score_repo(repo: str) -> dict:
    golden = GOLDEN / f"{repo}.jsonl"
    if not golden.is_file():
        return {}
    rows = []
    for line in golden.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        q = json.loads(line)
        out = rank_output(repo, keywords_of(q["question"]))
        groups = q.get("expect_all", [])
        hit_groups = sum(
            1 for group in groups
            if any(term.lower() in out for term in group)
        )
        rows.append({
            "id": q["id"],
            "groups": len(groups),
            "hit": hit_groups,
        })
    if not rows:
        return {}
    coverage = sum(r["hit"] for r in rows) / max(1, sum(r["groups"] for r in rows))
    full = sum(1 for r in rows if r["hit"] == r["groups"])
    return {
        "questions": len(rows),
        "group_coverage": round(coverage, 3),
        "full_coverage": full,
        "per_question": {r["id"]: f'{r["hit"]}/{r["groups"]}' for r in rows},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("repos", nargs="*", help="default: every golden file")
    ap.add_argument("--update-baseline", action="store_true")
    args = ap.parse_args()

    repos = args.repos or sorted(p.stem for p in GOLDEN.glob("*.jsonl"))
    results = {r: score_repo(r) for r in repos}
    results = {r: v for r, v in results.items() if v}

    baseline = {}
    if BASELINE.is_file():
        try:
            baseline = json.loads(BASELINE.read_text())
        except json.JSONDecodeError:
            baseline = {}

    regressed = False
    for repo, res in results.items():
        base = baseline.get(repo, {})
        delta = ""
        if base:
            diff = res["group_coverage"] - base.get("group_coverage", 0)
            delta = f" (baseline {base.get('group_coverage')}, {'+' if diff >= 0 else ''}{diff:.3f})"
            if diff < -0.05:
                regressed = True
                delta += "  <-- REGRESSION"
        print(
            f"{repo}: coverage {res['group_coverage']}{delta}, "
            f"full {res['full_coverage']}/{res['questions']}"
        )

    if args.update_baseline:
        BASELINE.write_text(json.dumps(results, indent=2) + "\n")
        print(f"baseline updated: {BASELINE.relative_to(ROOT)}")
    return 1 if regressed else 0


if __name__ == "__main__":
    sys.exit(main())
