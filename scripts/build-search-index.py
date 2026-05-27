#!/usr/bin/env python3
"""build-search-index — BM25 index over Cartograph notes.

Walks the corpus, tokenizes title + frontmatter values + lead paragraph
of each note, writes a BM25-ready index to ``.cartograph/index/bm25.json``.

This is the first step of the semantic-search design
(claude-designs/cartograph/semantic-search/). Pure Python, no model
dependency. ~80% of what neural embedding retrieval would give us, at
zero infra cost. The embedding upgrade path stays open; this is the
"do the cheap thing first" version.

Schema::

    {
      "schema": 1,
      "generated_at": "...",
      "docs": [
        {"path": "guides/jax/topics/sharding.md",
         "layer": "topic", "repo": "jax",
         "text": "raw concatenated text", "len": 387}
      ],
      "df": {"sharding": 7, "pjit": 4, ...},      # document frequency
      "avgdl": 412.0,                              # average doc length
      "N": 247                                     # total docs
    }

The query side (``cartograph_search.py``) reads this and computes BM25
scores. Index is regenerated cheaply on every SessionStart by the
existing build-file-index pass — wire-up identical.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore
except ImportError:
    sys.stderr.write("build-search-index: PyYAML missing. pip install --user pyyaml\n")
    sys.exit(2)


CARTOGRAPH_ROOT = Path(os.environ.get("CARTOGRAPH_ROOT") or Path(__file__).resolve().parent.parent)
CONTENT_DIRS = ["guides", "episodes", "research", "papers", "designs", "learn", "diary", "claude-designs"]
SKIP_DIRS = {"node_modules", "dist", ".git", "__pycache__", ".cartograph"}

_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_TOKEN_RE = re.compile(r"[a-z0-9_]+")
# Stopwords pulled from the inject-context.sh list, plus a few extras
# that bloat the corpus without carrying signal in a code/docs context.
_STOP = frozenset(
    """the that this with from have been what when where which will would could
    should about there their then than some like just into over each after before
    while under above below because though since other same very much more most
    less only here those these also such both many they them was were what who whom
    whose how why use uses used using one two three any all not but our its
    them they were are has had said make made way also however even still rest""".split()
)


def iter_notes(root: Path) -> list[Path]:
    out: list[Path] = []
    for sub in CONTENT_DIRS:
        base = root / sub
        if not base.is_dir():
            continue
        for path in base.rglob("*.md"):
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            out.append(path)
    return out


def parse_note(path: Path) -> tuple[dict[str, Any], str]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}, ""
    m = _FM_RE.match(text)
    if not m:
        return {}, text
    try:
        fm = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        return {}, text[m.end():]
    return (fm if isinstance(fm, dict) else {}), text[m.end():]


def lead_paragraph(body: str) -> str:
    """Take the first ~600 chars of non-frontmatter prose for indexing."""
    # Strip code fences — they're noise for retrieval.
    body = re.sub(r"```.*?```", " ", body, flags=re.DOTALL)
    body = re.sub(r"`[^`]*`", " ", body)
    body = body.strip()
    return body[:600]


def fm_text(fm: dict[str, Any]) -> str:
    """Flatten frontmatter scalars/lists into a single string for indexing."""
    pieces: list[str] = []
    for k, v in fm.items():
        if k in ("layer", "schema", "supersedes", "superseded_by", "distilled_into", "distilled_from"):
            continue
        if isinstance(v, str):
            pieces.append(v)
        elif isinstance(v, list):
            pieces.extend(str(item) for item in v if isinstance(item, (str, int, float)))
    return " ".join(pieces)


def tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN_RE.findall(text.lower()) if len(t) >= 3 and t not in _STOP]


def _infer_layer(rel: str) -> str | None:
    if rel.startswith("guides/") and "/topics/" in rel:
        return "topic"
    if rel.startswith("guides/") and rel.endswith(("overview.md", "architecture.md", "conventions.md", "seams.md")):
        return "bedrock"
    if rel.startswith("episodes/"):
        return "episode"
    if rel.startswith("research/"):
        return "research"
    if rel.startswith("papers/"):
        return "paper"
    if rel.startswith("designs/") or rel.startswith("claude-designs/"):
        return "design"
    if rel.startswith("learn/"):
        return "learn"
    if rel.startswith("diary/"):
        return "diary"
    return None


def _infer_repo(rel: str) -> str | None:
    parts = rel.split("/", 3)
    if parts[0] in ("guides", "research", "papers", "designs", "claude-designs") and len(parts) >= 2:
        return parts[1] if not parts[1].endswith(".md") else None
    return None


def build_index(root: Path) -> dict[str, Any]:
    docs: list[dict[str, Any]] = []
    df: Counter[str] = Counter()
    for note in iter_notes(root):
        fm, body = parse_note(note)
        rel = str(note.relative_to(root))
        title = ""
        if isinstance(fm.get("topic"), str):
            title = fm["topic"]
        if not title:
            m = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
            if m:
                title = m.group(1).strip()
        combined = " ".join([title, fm_text(fm), lead_paragraph(body)])
        tokens = tokenize(combined)
        if not tokens:
            continue
        tf = Counter(tokens)
        docs.append({
            "path": rel,
            "title": title or rel,
            "layer": fm.get("layer") or _infer_layer(rel),
            "repo": fm.get("repo") or _infer_repo(rel),
            "tf": tf,
            "len": sum(tf.values()),
        })
        for token in tf:
            df[token] += 1
    avgdl = sum(d["len"] for d in docs) / max(1, len(docs))
    # Serialize term frequencies as dict for JSON.
    out_docs = [
        {
            "path": d["path"],
            "title": d["title"],
            "layer": d["layer"],
            "repo": d["repo"],
            "tf": dict(d["tf"]),
            "len": d["len"],
        }
        for d in docs
    ]
    return {
        "schema": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "N": len(out_docs),
        "avgdl": avgdl,
        "df": dict(df),
        "docs": out_docs,
    }


def bm25_search(index: dict[str, Any], query: str, k: int = 10, repo: str | None = None, layer: str | None = None) -> list[dict[str, Any]]:
    """Standard BM25 scoring (k1=1.5, b=0.75)."""
    k1, b = 1.5, 0.75
    N = index["N"]
    avgdl = index["avgdl"]
    df = index["df"]
    q_tokens = [t for t in tokenize(query) if t in df]
    if not q_tokens:
        return []
    hits = []
    for doc in index["docs"]:
        if repo and doc.get("repo") != repo:
            continue
        if layer and doc.get("layer") != layer:
            continue
        score = 0.0
        dl = doc["len"]
        tf = doc["tf"]
        for q in q_tokens:
            f = tf.get(q, 0)
            if f == 0:
                continue
            n = df.get(q, 1)
            idf = math.log(1 + (N - n + 0.5) / (n + 0.5))
            score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / max(1.0, avgdl)))
        if score > 0:
            hits.append({
                "path": doc["path"],
                "title": doc["title"],
                "layer": doc["layer"],
                "repo": doc["repo"],
                "score": round(score, 3),
            })
    hits.sort(key=lambda h: h["score"], reverse=True)
    return hits[:k]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="build-search-index")
    ap.add_argument("--root", default=str(CARTOGRAPH_ROOT))
    ap.add_argument("--out", default=None)
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--query", default=None, help="Run a one-off search instead of writing the index")
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--repo", default=None)
    ap.add_argument("--layer", default=None)
    args = ap.parse_args(argv)

    root = Path(args.root).resolve()
    if not root.is_dir():
        sys.stderr.write(f"build-search-index: root {root} not found\n")
        return 2

    out_path = Path(args.out) if args.out else root / ".cartograph" / "index" / "bm25.json"

    if args.query:
        if not out_path.is_file():
            sys.stderr.write(f"build-search-index: {out_path} not built yet; run without --query first\n")
            return 2
        index = json.loads(out_path.read_text(encoding="utf-8"))
        hits = bm25_search(index, args.query, args.k, args.repo, args.layer)
        if not hits:
            print(f"no matches for {args.query!r}")
            return 0
        for h in hits:
            print(f"  {h['score']:6.2f}  [{h['layer'] or '?':7}] {h['path']}")
            if h["title"] and h["title"] != h["path"]:
                print(f"          {h['title']}")
        return 0

    index = build_index(root)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(index) + "\n", encoding="utf-8")
    if not args.quiet:
        sys.stderr.write(
            f"[bm25] indexed {index['N']} docs, {len(index['df'])} unique terms, avgdl={index['avgdl']:.0f} → {out_path}\n"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
