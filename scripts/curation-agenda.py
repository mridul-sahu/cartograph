#!/usr/bin/env python3
"""Zero-token sleep-time compute: compute the curation AGENDA, not the answers.

The consolidation work an agent-memory system needs (merge near-duplicate
notes, retire dead ones, cover hot-but-undocumented code, resolve open
contradictions) is usually done with background LLM passes. Under the
token diet the analysis is deterministic and only the JUDGMENT is
deferred to the next active session. This script computes four agendas:

  near-dups       tf-idf cosine over topic + research notes per repo;
                  pairs above threshold are merge candidates
  decay           notes injected repeatedly, never used, not revised in
                  months (from note-usage.json) — evict/renew candidates
  coverage gaps   files hot in recent upstream commits with no citing
                  note (git log vs the by-file reverse index)
  contradictions  open `## contradiction:` blocks in notes

Output: .cartograph/state/curation-agenda.md (whole corpus) — the
orientation injection surfaces the current repo's top items on full
turns. Runs from maintenance.sh nightly; safe to run any time.

Usage: curation-agenda.py [--days 45] [--sim 0.55]
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = ROOT / "workspace"
GUIDES = ROOT / "guides"
RESEARCH = ROOT / "research"
STATE = ROOT / ".cartograph" / "state"
OUT = STATE / "curation-agenda.md"

WORD_RE = re.compile(r"[a-z0-9_]{4,}")
CONTRA_RE = re.compile(r"^##\s*contradiction:", re.MULTILINE | re.IGNORECASE)


def repos() -> list[str]:
    return sorted(
        d.name for d in WORKSPACE.iterdir()
        if d.is_dir() and (d / ".git").is_dir()
    ) if WORKSPACE.is_dir() else []


def body_of(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return re.sub(r"^---.*?\n---\s*\n", "", text, count=1, flags=re.DOTALL)


def near_dups(repo: str, threshold: float) -> list[str]:
    notes: dict[str, Counter] = {}
    for base in (GUIDES / repo / "topics", RESEARCH / repo):
        if not base.is_dir():
            continue
        for p in sorted(base.glob("*.md")):
            toks = Counter(WORD_RE.findall(body_of(p).lower()))
            if toks:
                notes[str(p.relative_to(ROOT))] = toks
    if len(notes) < 2:
        return []
    df: Counter = Counter()
    for toks in notes.values():
        df.update(toks.keys())
    n = len(notes)
    vecs: dict[str, dict[str, float]] = {}
    for rel, toks in notes.items():
        vec = {t: (1 + math.log(c)) * math.log(n / df[t]) for t, c in toks.items() if df[t] < n}
        norm = math.sqrt(sum(w * w for w in vec.values())) or 1.0
        vecs[rel] = {t: w / norm for t, w in vec.items()}
    rels = sorted(vecs)
    out = []
    for i, a in enumerate(rels):
        va = vecs[a]
        for b in rels[i + 1:]:
            vb = vecs[b]
            small, large = (va, vb) if len(va) < len(vb) else (vb, va)
            sim = sum(w * large.get(t, 0.0) for t, w in small.items())
            if sim >= threshold:
                out.append(f"merge candidates (cos {sim:.2f}): `{a}` + `{b}`")
    return out


def decay_candidates(stale_days: int = 60) -> dict[str, list[str]]:
    usage_path = STATE / "note-usage.json"
    try:
        usage = json.loads(usage_path.read_text())["notes"]
    except (OSError, KeyError, json.JSONDecodeError):
        return {}
    cutoff = time.time() - stale_days * 86400
    out: dict[str, list[str]] = {}
    for rel, u in sorted(usage.items()):
        if u.get("injected_count", 0) < 3 or u.get("used_count", 0) > 0:
            continue
        try:
            last = time.mktime(time.strptime(u.get("last_injected", "1970-01-01"), "%Y-%m-%d"))
        except ValueError:
            continue
        if last > cutoff or not (ROOT / rel).is_file():
            continue
        m = re.search(r"(?:guides|research|episodes)/([^/]+)/", rel)
        repo = m.group(1) if m and (WORKSPACE / m.group(1)).is_dir() else "_global"
        out.setdefault(repo, []).append(
            f"decay: `{rel}` injected {u['injected_count']}x, never used, "
            f"last surfaced {u.get('last_injected')} — renew or reject"
        )
    return out


def coverage_gaps(repo: str, days: int) -> list[str]:
    fork = WORKSPACE / repo
    try:
        log = subprocess.run(
            ["git", "-C", str(fork), "log", f"--since={days}.days",
             "--name-only", "--pretty=format:"],
            capture_output=True, text=True, timeout=120,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    hot = Counter(
        line for line in log.splitlines()
        if line.endswith((".py", ".cc", ".h", ".ts", ".go")) and "test" not in line
    )
    try:
        by_file = json.loads(
            (ROOT / ".cartograph" / "index" / "by-file.json").read_text()
        ).get("by_file", {})
    except (OSError, json.JSONDecodeError):
        by_file = {}
    cited = set(by_file.keys())
    out = []
    for path, touches in hot.most_common(30):
        if touches < 5:
            break
        if not any(path.endswith(c) or c.endswith(path) for c in cited):
            out.append(f"gap: `{path}` touched {touches}x in {days}d, no citing note")
        if len(out) >= 5:
            break
    return out


def contradictions(repo: str) -> list[str]:
    out = []
    for base in (GUIDES / repo, GUIDES / repo / "topics", RESEARCH / repo):
        if not base.is_dir():
            continue
        for p in sorted(base.glob("*.md")):
            hits = len(CONTRA_RE.findall(body_of(p)))
            if hits:
                out.append(
                    f"contradiction: `{p.relative_to(ROOT)}` has {hits} open "
                    "block(s) — resolve or confirm still open"
                )
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--days", type=int, default=45)
    ap.add_argument("--sim", type=float, default=0.55)
    args = ap.parse_args()

    decay = decay_candidates()
    lines = [
        "# Curation agenda (computed deterministically — zero tokens)",
        "",
        f"Generated {time.strftime('%Y-%m-%d %H:%M')}Z. Each item needs an",
        "active session's judgment; nothing here acts on its own.",
        "",
    ]
    total = 0
    for repo in repos():
        items = (
            near_dups(repo, args.sim)
            + decay.get(repo, [])
            + coverage_gaps(repo, args.days)
            + contradictions(repo)
        )
        if not items:
            continue
        lines.append(f"## {repo} ({len(items)})")
        lines.append("")
        lines += [f"- {i}" for i in items]
        lines.append("")
        total += len(items)
    if decay.get("_global"):
        lines.append(f"## cross-repo ({len(decay['_global'])})")
        lines.append("")
        lines += [f"- {i}" for i in decay["_global"]]
        lines.append("")

    STATE.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"curation-agenda: {total} item(s) -> {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    main()
