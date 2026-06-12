#!/usr/bin/env python3
"""build-file-index — reverse map from cited code-files to notes.

Walks the corpus, pulls every ``files_touched:`` list entry and every
``path/to/file.{py,cc,h,...}[:NNN]`` anchor out of note bodies, and
writes ``.cartograph/index/by-file.json`` mapping cited paths back to
the notes that cite them.

Powers ``/whatknows <path>``. Cheap enough to rebuild on every
SessionStart (a few hundred markdown files, sub-second run).

Design: ``claude-designs/cartograph/file-reverse-index/README.md``.

Schema::

    {
      "schema": 1,
      "generated_at": "2026-05-25T10:23:00Z",
      "by_file": {
        "orbax/_src/checkpointers/async_checkpointer.py": [
          {"note": "guides/orbax/topics/async-save.md",
           "anchors": [412, 487],
           "layer": "topic",
           "source": "body"},
          {"note": "episodes/2026-04/2026-04-12-async-hang.md",
           "anchors": [412],
           "layer": "episode",
           "source": "frontmatter"}
        ]
      }
    }
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore
except ImportError:
    sys.stderr.write("build-file-index: PyYAML missing. pip install --user pyyaml\n")
    sys.exit(2)


CARTOGRAPH_ROOT = Path(os.environ.get("CARTOGRAPH_ROOT") or Path(__file__).resolve().parent.parent)
CONTENT_DIRS = ["guides", "episodes", "research", "papers", "research_papers", "designs", "learn", "diary", "claude-designs"]
SKIP_DIRS = {"node_modules", "dist", ".git", "__pycache__", ".cartograph"}

_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
# Citation anchors: any path-shaped token ending in a known code extension,
# optionally followed by ``:NNN``. Pinched from lint-content.sh.
_ANCHOR_EXTENSIONS = ("py", "pyi", "cc", "cpp", "h", "hh", "hpp", "c", "ts", "tsx", "js", "go", "rs", "bzl")
_ANCHOR_RE = re.compile(
    r"\b((?:[a-zA-Z0-9_./-]+/)?[a-zA-Z0-9_.-]+\.(?:" + "|".join(_ANCHOR_EXTENSIONS) + r"))(?::(\d+))?\b"
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
    if not isinstance(fm, dict):
        return {}, text[m.end():]
    return fm, text[m.end():]


def extract_files_touched(fm: dict[str, Any]) -> list[str]:
    v = fm.get("files_touched")
    if not isinstance(v, list):
        return []
    return [str(item).strip() for item in v if isinstance(item, str) and item.strip()]


def extract_code_refs_text(fm: dict[str, Any]) -> str:
    """Flatten a ``code_refs`` frontmatter field (the paper-note /
    research_papers "where it lives in real code" schema) into a text blob so
    the anchor regex pulls ``path.py:NNN`` refs out of it exactly as it does
    from the body. Entries may be plain strings or dicts carrying the path
    under a common key."""
    v = fm.get("code_refs")
    if not isinstance(v, list):
        return ""
    parts: list[str] = []
    for item in v:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            for k in ("path", "file", "ref", "code", "location"):
                if isinstance(item.get(k), str):
                    parts.append(item[k])
                    break
    return "\n".join(parts)


def extract_body_anchors(body: str) -> dict[str, set[int]]:
    """Return {path: set(line_numbers)}; line_numbers empty set if cited without :NNN."""
    out: dict[str, set[int]] = {}
    for match in _ANCHOR_RE.finditer(body):
        path, line = match.group(1), match.group(2)
        # Skip obvious noise: a bare ``foo.py`` with no slash that's a single dict word
        # is probably real; ``a.bzl`` style names with no slash also fine. We accept all.
        bucket = out.setdefault(path, set())
        if line:
            try:
                bucket.add(int(line))
            except ValueError:
                continue
    return out


def build_index(root: Path) -> dict[str, Any]:
    by_file: dict[str, list[dict[str, Any]]] = {}
    by_repo: dict[str, set[str]] = {}

    for note in iter_notes(root):
        fm, body = parse_note(note)
        rel_note = str(note.relative_to(root))
        # Anti-bloat: rejected notes don't belong in the reverse index —
        # pre-Read augmentation would surface known-bad notes next to the
        # file they mis-describe. (Superseded episodes stay: their anchors
        # still locate code, and the superseding note may cite less.)
        if fm.get("rejected") is True or str(fm.get("rejected", "")).strip() == "true":
            continue
        layer = fm.get("layer") or _infer_layer(rel_note)
        repo = fm.get("repo") or _infer_repo(rel_note)

        # frontmatter files_touched
        for fp in extract_files_touched(fm):
            entry = {
                "note": rel_note,
                "layer": layer,
                "source": "frontmatter",
                "anchors": [],
            }
            by_file.setdefault(fp, []).append(entry)
            if repo:
                by_repo.setdefault(repo, set()).add(fp)

        # frontmatter code_refs (paper-note / research_papers schema): same
        # ``path.py:NNN`` shape as body anchors, declared in frontmatter instead
        # of cited inline. This is what makes /whatknows surface a paper note
        # for the code it points at.
        for path, lines in extract_body_anchors(extract_code_refs_text(fm)).items():
            if path.endswith(".md"):
                continue
            entry = {
                "note": rel_note,
                "layer": layer,
                "source": "frontmatter",
                "anchors": sorted(lines),
            }
            by_file.setdefault(path, []).append(entry)
            if repo:
                by_repo.setdefault(repo, set()).add(path)

        # body anchors
        for path, lines in extract_body_anchors(body).items():
            # Skip self-references to cartograph's own content (e.g. ``foo.md`` cited within a note)
            if path.endswith(".md"):
                continue
            entry = {
                "note": rel_note,
                "layer": layer,
                "source": "body",
                "anchors": sorted(lines),
            }
            by_file.setdefault(path, []).append(entry)
            if repo:
                by_repo.setdefault(repo, set()).add(path)

    # Collapse duplicates (same note cites same file via both frontmatter and body)
    for key, entries in by_file.items():
        merged: dict[str, dict[str, Any]] = {}
        for e in entries:
            merged_entry = merged.get(e["note"])
            if merged_entry is None:
                merged[e["note"]] = {
                    "note": e["note"],
                    "layer": e["layer"],
                    "anchors": list(e["anchors"]),
                    "sources": [e["source"]],
                }
            else:
                merged_entry["anchors"] = sorted(set(merged_entry["anchors"]) | set(e["anchors"]))
                if e["source"] not in merged_entry["sources"]:
                    merged_entry["sources"].append(e["source"])
        # Sort by layer priority then by note path
        layer_rank = {"bedrock": 0, "topic": 1, "episode": 2, "research": 3, "paper": 4, "design": 5, "learn": 6}
        by_file[key] = sorted(
            merged.values(),
            key=lambda x: (layer_rank.get(str(x.get("layer", "")), 99), x["note"]),
        )

    return {
        "schema": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "by_file": dict(sorted(by_file.items())),
        "by_repo": {k: sorted(v) for k, v in sorted(by_repo.items())},
    }


def lookup_paths(index: dict[str, Any], needle: str) -> list[tuple[str, list[dict[str, Any]]]]:
    """Bidirectional path lookup against the reverse index.

    A topic note may cite a code file as the bare basename
    (``async_checkpointer.py``) or with any prefix
    (``_src/checkpointers/async_checkpointer.py``,
    ``checkpoint/orbax/checkpoint/_src/...``). Different agents will pass
    different shapes of the same file. Match when:

    1. needle is a substring of an indexed path (catches agent queries
       that are shorter than indexed paths), OR
    2. an indexed path is a substring of needle (catches the inverse —
       e.g. agent passes ``orbax/_src/...`` but index has ``_src/...``), OR
    3. the basename matches (catches the bare-basename case).

    This was a one-way ``needle in path`` test originally — that missed
    every note when the agent's query carried an extra upstream-style
    prefix the index hadn't seen. Discovered by the orbax shakedown
    session 2026-05-25.
    """
    needle = needle.strip()
    if not needle:
        return []
    needle_base = needle.rsplit("/", 1)[-1]
    hits: list[tuple[str, list[dict[str, Any]]]] = []
    seen: set[str] = set()
    for path, entries in index.get("by_file", {}).items():
        path_base = path.rsplit("/", 1)[-1]
        matched = (
            needle in path
            or path in needle
            or path_base == needle_base
        )
        if matched and path not in seen:
            seen.add(path)
            hits.append((path, entries))
    # Rank: longer indexed paths first (more specific match is better signal).
    hits.sort(key=lambda pe: -len(pe[0]))
    return hits


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
    if rel.startswith("research_papers/"):
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


def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="build-file-index")
    ap.add_argument("--root", default=str(CARTOGRAPH_ROOT))
    ap.add_argument("--out", default=None, help="Override output path (default: <root>/.cartograph/index/by-file.json)")
    ap.add_argument("--lookup", default=None, help="Print entries for this file path and exit (no write)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    root = Path(args.root).resolve()
    if not root.is_dir():
        sys.stderr.write(f"build-file-index: root {root} not found\n")
        return 2

    index = build_index(root)

    if args.lookup:
        needle = args.lookup
        hits = lookup_paths(index, needle)
        if not hits:
            print(f"no notes reference {needle!r}")
            return 0
        for path, entries in hits:
            print(f"\n▸ {path}")
            for e in entries:
                anchors = ":" + ",".join(str(a) for a in e["anchors"]) if e["anchors"] else ""
                src = "+".join(e.get("sources", []))
                print(f"    [{e['layer'] or '?':7}] {e['note']}{anchors}  ({src})")
        return 0

    out_path = Path(args.out) if args.out else root / ".cartograph" / "index" / "by-file.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    if not args.quiet:
        total_files = len(index["by_file"])
        total_entries = sum(len(v) for v in index["by_file"].values())
        sys.stderr.write(
            f"[file-index] indexed {total_files} unique paths, {total_entries} citations → {out_path}\n"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
