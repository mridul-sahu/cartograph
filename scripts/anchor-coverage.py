#!/usr/bin/env python3
"""anchor-coverage — flag topic notes that don't anchor to the files
their related episodes actually touched.

The chassis already enforces a citation-density floor in
``scripts/lint-content.sh`` (≥3 ``path:NNN`` anchors per topic note),
but that floor doesn't check whether the anchors point at the *right*
files. A topic note can satisfy the lint while ignoring its
load-bearing file entirely — which is exactly what the orbax
shakedown session discovered: ``async-checkpoint-flow.md`` cites
``async_checkpointer.py`` many times, but ``async-checkpoint-flow``-
related episodes also touch files (``type_handler_registry.py``,
``async_checkpointer_test.py``) that the topic never names.

This audit closes the gap. For each topic note:

1. Find related episodes — those whose ``distilled_into`` points at
   the topic OR whose ``tags`` contain the topic's slug.
2. Union the related episodes' ``files_touched:`` lists. That's the
   set of files the topic is *implicitly about*, by signal.
3. Check whether the topic body anchors to each of those files (by
   basename, since topic notes use various path shapes).
4. Any file with multi-episode signal that the topic doesn't anchor
   → flagged. The output groups by repo and sorts by gap-count.

Output JSON to ``.cartograph/state/anchor-coverage.json`` and a
human summary to stdout. Surfaces in ``/queue`` as a new section.

Design lineage: the empty-``/whatknows`` insight from
``episodes/2026-05/2026-05-25-whatknows-coverage-gap-signal.md``.
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore
except ImportError:
    sys.stderr.write("anchor-coverage: PyYAML missing. pip install --user pyyaml\n")
    sys.exit(2)


CARTOGRAPH_ROOT = Path(os.environ.get("CARTOGRAPH_ROOT") or Path(__file__).resolve().parent.parent)

_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_ANCHOR_EXTENSIONS = ("py", "pyi", "cc", "cpp", "h", "hh", "hpp", "c", "ts", "tsx", "js", "go", "rs", "bzl")
_ANCHOR_RE = re.compile(
    r"\b((?:[a-zA-Z0-9_./-]+/)?[a-zA-Z0-9_.-]+\.(?:" + "|".join(_ANCHOR_EXTENSIONS) + r"))(?::\d+)?\b"
)
# Files that appear in many unrelated episodes — too noisy to flag as
# "canonical to this topic." Filtered out below.
_NOISE_FLOOR = {"setup.py", "pyproject.toml", "__init__.py"}


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


def topic_anchored_basenames(body: str) -> set[str]:
    """The set of basenames cited anywhere in a topic note's body."""
    out: set[str] = set()
    for match in _ANCHOR_RE.finditer(body):
        path = match.group(1)
        out.add(path.rsplit("/", 1)[-1])
    return out


def audit(root: Path) -> dict[str, Any]:
    # Pass 1 — collect all topics, indexed by repo + slug.
    topics: dict[tuple[str, str], dict[str, Any]] = {}
    for topic_path in (root / "guides").rglob("topics/*.md"):
        fm, body = parse_note(topic_path)
        if fm.get("layer") != "topic":
            continue
        repo = fm.get("repo") or topic_path.parts[-3]
        slug = topic_path.stem
        topics[(repo, slug)] = {
            "path": str(topic_path.relative_to(root)),
            "repo": repo,
            "slug": slug,
            "anchored": topic_anchored_basenames(body),
        }

    # Pre-tokenize topic slugs for substring-token matching against episode tags.
    # Episode tag `multi-host` should attribute to topic `multi-host-coordination`,
    # `safetensor` to `safetensors-sharding-driven-load`, etc. Hyphen-tokens.
    #
    # We drop a stoplist of high-cardinality tokens that match across unrelated
    # topics: repo names (every orbax episode tags `orbax`...), generic checkpoint
    # vocabulary, etc. The orbax shakedown round of audits showed `safetensors_layout.py`
    # leaking into `orbax-export-jax-to-tf` and `emergency-checkpoint` because of
    # bare token overlap on `orbax`/`checkpoint`/`layout` — those false positives
    # made the list noisy. Stoplist filters them at the matching boundary.
    TAG_STOPLIST = {
        # Repo names
        "jax", "xla", "orbax", "tunix", "tokamax",
        # High-cardinality structural words that match almost everything
        "checkpoint", "checkpointing", "layout", "flow", "save", "load",
        "test", "tests", "api", "v1", "v2", "core",
        "performance", "perf", "bench", "benchmark", "benchmarks",
        # Common composite suffixes
        "based", "driven", "aware",
    }

    def tokens(s: str) -> set[str]:
        return {
            t for t in re.split(r"[-_/.]+", s.lower())
            if len(t) >= 4 and t not in TAG_STOPLIST
        }

    topic_tokens: dict[tuple[str, str], set[str]] = {
        key: tokens(slug) for key, (repo, slug) in (
            ((r, s), (r, s)) for (r, s) in topics
        )
    }

    # Pass 2 — walk episodes, attribute their files_touched lists to topics.
    episode_files_by_topic: dict[tuple[str, str], dict[str, int]] = defaultdict(lambda: defaultdict(int))
    episodes_dir = root / "episodes"
    if episodes_dir.is_dir():
        for ep_path in episodes_dir.rglob("*.md"):
            fm, _ = parse_note(ep_path)
            if fm.get("layer") != "episode":
                continue
            repo = fm.get("repo")
            files = fm.get("files_touched") or []
            if not isinstance(files, list):
                continue
            tags = fm.get("tags") or []
            distilled = fm.get("distilled_into")
            attributed: set[tuple[str, str]] = set()
            # Attribute via distilled_into (most precise).
            if isinstance(distilled, str) and "/topics/" in distilled:
                m = re.search(r"guides/([^/]+)/topics/([^.]+)\.md", distilled)
                if m:
                    attributed.add((m.group(1), m.group(2)))
            # Attribute via token overlap between episode tags and topic slug.
            # Episode tag `safetensor` shares the token `safetensor` with topic
            # `safetensors-sharding-driven-load` → attributed. Tighter than full
            # substring (which would over-attribute) and looser than exact match
            # (which would under-attribute, as the orbax shakedown showed).
            if isinstance(tags, list) and repo:
                episode_tag_tokens: set[str] = set()
                for tag in tags:
                    if isinstance(tag, str):
                        episode_tag_tokens |= tokens(tag)
                if episode_tag_tokens:
                    for (tr, ts), t_toks in topic_tokens.items():
                        if tr != repo:
                            continue
                        # Require ≥1 strong token overlap (length ≥4) to attribute.
                        if episode_tag_tokens & t_toks:
                            attributed.add((tr, ts))
            for key in attributed:
                for f in files:
                    if not isinstance(f, str) or not f.strip():
                        continue
                    basename = f.strip().rsplit("/", 1)[-1]
                    if basename in _NOISE_FLOOR:
                        continue
                    if not any(basename.endswith("." + ext) for ext in _ANCHOR_EXTENSIONS):
                        continue
                    episode_files_by_topic[key][basename] += 1

    # Load the suppress list — (repo, slug) pairs and (repo, slug, file)
    # triples that claude has already evaluated as false positives via
    # anchor-fix.sh's no-op verdict. The audit re-runs every session, so
    # without persistent suppression a no-op would just reappear.
    suppress_pairs: set[tuple[str, str]] = set()
    suppress_files: set[tuple[str, str, str]] = set()
    suppress_path = root / ".cartograph" / "state" / "anchor-suppress.json"
    if suppress_path.is_file():
        try:
            sup = json.loads(suppress_path.read_text(encoding="utf-8"))
            for entry in sup.get("topics") or []:
                suppress_pairs.add((entry.get("repo") or "", entry.get("slug") or ""))
            for entry in sup.get("files") or []:
                suppress_files.add((entry.get("repo") or "", entry.get("slug") or "", entry.get("file") or ""))
        except (OSError, json.JSONDecodeError):
            pass

    # Pass 3 — diff: for each topic, which canonical-signal files aren't anchored?
    gaps_by_repo: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for key, file_counts in episode_files_by_topic.items():
        topic = topics.get(key)
        if not topic:
            continue
        if (topic["repo"], topic["slug"]) in suppress_pairs:
            continue
        missing = []
        for basename, episode_count in sorted(file_counts.items(), key=lambda x: -x[1]):
            # Floor: need ≥1 episode citing the file. The corpus is small enough
            # that a single-episode signal is meaningful; we'll re-tune to ≥2 when
            # the corpus grows past ~200 episodes per repo.
            if episode_count < 1:
                continue
            if (topic["repo"], topic["slug"], basename) in suppress_files:
                continue
            if basename not in topic["anchored"]:
                missing.append({"file": basename, "episode_signal": episode_count})
        if not missing:
            continue
        gaps_by_repo[topic["repo"]].append({
            "topic_path": topic["path"],
            "slug": topic["slug"],
            "anchored_count": len(topic["anchored"]),
            "missing": missing,
        })

    # Sort gaps within each repo by total missing-count desc.
    for repo, gaps in gaps_by_repo.items():
        gaps.sort(key=lambda g: -len(g["missing"]))

    total_gaps = sum(len(g) for g in gaps_by_repo.values())
    return {
        "schema": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "topics_audited": len(topics),
        "total_gaps": total_gaps,
        "gaps_by_repo": dict(sorted(gaps_by_repo.items())),
    }


def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="anchor-coverage")
    ap.add_argument("--root", default=str(CARTOGRAPH_ROOT))
    ap.add_argument("--out", default=None)
    ap.add_argument("--human", action="store_true", help="Human-readable summary on stdout (default: JSON)")
    args = ap.parse_args(argv)

    root = Path(args.root).resolve()
    if not root.is_dir():
        sys.stderr.write(f"anchor-coverage: root {root} not found\n")
        return 2

    result = audit(root)
    out_path = Path(args.out) if args.out else root / ".cartograph" / "state" / "anchor-coverage.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    if args.human:
        print(f"anchor-coverage — {result['topics_audited']} topics audited, {result['total_gaps']} with gaps")
        for repo, gaps in result["gaps_by_repo"].items():
            if not gaps:
                continue
            print(f"\n▸ {repo} ({len(gaps)} topics with anchor gaps)")
            for gap in gaps[:10]:
                missing = ", ".join(f"{m['file']}×{m['episode_signal']}" for m in gap["missing"][:4])
                print(f"    {gap['slug']:40} missing: {missing}")
            if len(gaps) > 10:
                print(f"    + {len(gaps) - 10} more")
    else:
        print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
