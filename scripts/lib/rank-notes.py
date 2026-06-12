#!/usr/bin/env python3
"""Rank cartograph notes for orientation injection.

Replaces the per-keyword grep loops in inject-context.sh with one pass:
IDF-weighted keyword overlap (df table from the BM25 index), a usage
boost/penalty from note-usage.json, cross-layer dedup via an emitted-paths
file, and direct emission of either full note bodies or a compact menu
(title + summary + path) the agent can follow with Read.

Scoring: sum of idf(kw) over keywords present in the note (whole-word,
case-insensitive), plus 0.5 * usage_boost. idf comes from the BM25 index
df table so corpus-common words (checkpoint, jax, ...) stop dominating
rare discriminative ones. Keywords absent from the index get max idf —
they can only match notes newer than the index, which is exactly when
they matter.

Usage boost: +2 if used_count >= 6, +1 if >= 1, -1 if injected >= 5 and
never used (the negative-feedback signal), else 0.
"""

import argparse
import json
import math
import pathlib
import re
import sys

SUMMARY_MAX = 220


def read_text(path: pathlib.Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def split_frontmatter(text: str) -> tuple[str, str]:
    """Return (frontmatter, body); frontmatter empty if absent."""
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            return text[4:end], text[end + 4 :]
    return "", text


def fm_field(frontmatter: str, field: str) -> str:
    m = re.search(rf"^{field}:[ \t]*(.*)$", frontmatter, re.MULTILINE)
    return m.group(1).strip() if m else ""


def summary_of(frontmatter: str, body: str) -> str:
    explicit = fm_field(frontmatter, "summary")
    if explicit and explicit not in ("~", '""', "''"):
        return explicit[:SUMMARY_MAX]
    for para in re.split(r"\n\s*\n", body):
        para = para.strip()
        if not para or para.startswith(("#", "<!--", "---", "```", ">")):
            continue
        return re.sub(r"\s+", " ", para)[:SUMMARY_MAX]
    return ""


def title_of(frontmatter: str, body: str, rel: str) -> str:
    m = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
    if m:
        return m.group(1).strip()
    topic = fm_field(frontmatter, "topic")
    return topic if topic else pathlib.Path(rel).stem


def idf_table(index_path: str) -> tuple[dict, int]:
    try:
        idx = json.loads(pathlib.Path(index_path).read_text())
        return idx.get("df", {}), int(idx.get("N", 0)) or 1
    except (OSError, ValueError):
        return {}, 1


def idf(term: str, df: dict, n: int) -> float:
    d = df.get(term, 0)
    return math.log(1 + (n - d + 0.5) / (d + 0.5))


def usage_boost(rel: str, usage: dict) -> int:
    entry = usage.get("notes", {}).get(rel, {})
    used = entry.get("used_count", 0)
    injected = entry.get("injected_count", 0)
    if used >= 6:
        return 2
    if used >= 1:
        return 1
    if injected >= 5:
        return -1
    return 0


def episode_excluded(frontmatter: str, repo: str) -> bool:
    if re.search(r"^superseded_by:[ \t]*[^~\s]", frontmatter, re.MULTILINE):
        return True
    if re.search(r"^distilled_into:[ \t]*[^~\s]", frontmatter, re.MULTILINE):
        return True
    if re.search(r"^rejected:[ \t]*true", frontmatter, re.MULTILINE):
        return True
    ep_repo = fm_field(frontmatter, "repo")
    if repo and ep_repo and ep_repo != repo:
        return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--dir", required=True, help="note dir relative to root")
    ap.add_argument("--recursive", action="store_true")
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--emit", choices=["menu", "full", "full1+menu"], default="full1+menu")
    ap.add_argument("--label", default="notes")
    ap.add_argument("--episode-filters", action="store_true")
    ap.add_argument("--repo", default="")
    ap.add_argument("--index", default="")
    ap.add_argument("--usage-file", default="")
    ap.add_argument("--emitted-file", default="", help="dedup ledger; skip + append")
    args = ap.parse_args()

    root = pathlib.Path(args.root)
    note_dir = root / args.dir
    if not note_dir.is_dir():
        return 0

    keywords = [k.strip() for k in sys.stdin.read().split("\n") if k.strip()]
    if not keywords:
        return 0

    df, n_docs = idf_table(args.index) if args.index else ({}, 1)
    usage = {}
    if args.usage_file:
        try:
            usage = json.loads(pathlib.Path(args.usage_file).read_text())
        except (OSError, ValueError):
            usage = {}

    already = set()
    if args.emitted_file:
        try:
            already = {
                line.strip()
                for line in pathlib.Path(args.emitted_file).read_text().splitlines()
                if line.strip()
            }
        except OSError:
            pass

    pattern = "**/*.md" if args.recursive else "*.md"
    scored = []
    for path in sorted(note_dir.glob(pattern)):
        rel = str(path.relative_to(root))
        if rel in already:
            continue
        text = read_text(path)
        if not text:
            continue
        frontmatter, body = split_frontmatter(text)
        # Rejected notes never inject, regardless of layer.
        if re.search(r"^rejected:[ \t]*true", frontmatter, re.MULTILINE):
            continue
        if args.episode_filters and episode_excluded(frontmatter, args.repo):
            continue
        lower = text.lower()
        score = 0.0
        for kw in keywords:
            if re.search(rf"(?<![a-z0-9_]){re.escape(kw)}(?![a-z0-9_])", lower):
                score += idf(kw, df, n_docs)
        if score <= 0:
            continue
        score += 0.5 * usage_boost(rel, usage)
        scored.append((score, rel, path, frontmatter, body))

    scored.sort(key=lambda t: (-t[0], t[1]))
    top = scored[: args.top]
    if not top:
        return 0

    emitted = []
    out = sys.stdout

    def emit_full(rel: str, text: str) -> None:
        out.write(f"--- {rel} ---\n{text}\n\n")
        emitted.append(rel)

    def emit_menu(items) -> None:
        if not items:
            return
        out.write(
            f"[{args.label} menu] keyword-matched, most-relevant first — "
            "Read the path before re-deriving anything it covers:\n"
        )
        for score, rel, _path, frontmatter, body in items:
            title = title_of(frontmatter, body, rel)
            summary = summary_of(frontmatter, body)
            out.write(f"  • {rel} — {title}")
            if summary:
                out.write(f" :: {summary}")
            out.write("\n")
            emitted.append(rel)
        out.write("\n")

    if args.emit == "full":
        for _score, rel, path, _fm, _body in top:
            emit_full(rel, read_text(path))
    elif args.emit == "menu":
        emit_menu(top)
    else:  # full1+menu
        first = top[0]
        emit_full(first[1], read_text(first[2]))
        emit_menu(top[1:])

    if args.emitted_file and emitted:
        with open(args.emitted_file, "a", encoding="utf-8") as fh:
            fh.writelines(rel + "\n" for rel in emitted)
    return 0


if __name__ == "__main__":
    sys.exit(main())
