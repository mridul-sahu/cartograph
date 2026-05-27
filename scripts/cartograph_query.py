#!/usr/bin/env python3
"""cartograph_query — structured query over the corpus.

Reads every markdown file under the content dirs (``guides/``,
``episodes/``, ``research/``, ``papers/``, ``designs/``, ``learn/``,
``diary/``), parses YAML frontmatter, applies AND-combined filter
expressions, and prints matching paths (default) or JSON.

This is the foundation under several other Cartograph features
(``/queue``, ``diary.sh``, ``build-file-index.py``). Design:
``claude-designs/cartograph/query-cli/README.md``.

Usage examples::

    cartograph_query layer=topic repo=orbax !reviewed_by_human
    cartograph_query layer=episode auto_drafted=true !reviewed_by_human --format json
    cartograph_query files_touched=async_checkpointer.py
    cartograph_query layer=topic 'last_revised<2026-02-01' --limit 20
    cartograph_query contains=barrier layer=topic

Filter forms:

* ``key=value`` — equality (lists match if value is in the list)
* ``key=a,b,c`` — OR within a key
* ``key>VAL`` / ``key<VAL`` / ``key>=VAL`` / ``key<=VAL`` — comparison
  (lex for strings, ISO date for date-shaped values)
* ``!key`` — key absent OR null/``~``/empty
* ``key=true`` / ``key=false`` — bool-coerce (present-and-non-null vs absent-or-null)
* ``files_touched=<substr>`` — substring match against any list entry
* ``has_anchor=<path:line>`` — body grep for the citation form
* ``contains=<word>`` — body grep fallback (word-aware)

Output:

* default — one path per line, sorted lex
* ``--format json`` — array of ``{path, frontmatter, ...}`` records
* ``--format tsv`` — tab-separated ``path\\tlayer\\trepo\\tdate``
* ``--limit N`` — cap result count
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore
except ImportError:
    sys.stderr.write(
        "cartograph_query: PyYAML missing. Install with: pip install --user pyyaml\n"
    )
    sys.exit(2)


CARTOGRAPH_ROOT = Path(os.environ.get("CARTOGRAPH_ROOT") or Path(__file__).resolve().parent.parent)
CONTENT_DIRS = ["guides", "episodes", "research", "papers", "designs", "learn", "diary", "claude-designs"]
SKIP_DIRS = {"node_modules", "dist", ".git", "__pycache__", ".cartograph"}

_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def iter_notes(root: Path) -> list[Path]:
    """Walk content dirs, yield every .md file."""
    results: list[Path] = []
    for sub in CONTENT_DIRS:
        base = root / sub
        if not base.is_dir():
            continue
        for path in base.rglob("*.md"):
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            results.append(path)
    return results


def parse_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    """Return (frontmatter_dict, body). Empty dict if no frontmatter."""
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


def is_null(v: Any) -> bool:
    """Whether a frontmatter value should be treated as absent.

    Treats None, empty string, '~', and empty list/dict as null.
    Lint-encouraged shape: explicit ``~`` for nulls.
    """
    if v is None:
        return True
    if isinstance(v, str) and v.strip() in ("", "~"):
        return True
    if isinstance(v, (list, dict)) and not v:
        return True
    return False


def to_bool(v: Any) -> bool:
    """True if value is present-and-not-null and truthy.

    Strings 'false', 'no', '0' are falsy; everything else truthy.
    """
    if is_null(v):
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() not in ("false", "no", "0", "off")
    return bool(v)


def coerce_date(v: Any) -> str | None:
    """Normalize date-shaped values to ISO 8601 string, else None."""
    if is_null(v):
        return None
    if isinstance(v, (date, datetime)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, str):
        s = v.strip()
        if re.match(r"^\d{4}-\d{2}-\d{2}", s):
            return s[:10]
    return None


def value_contains(v: Any, needle: str) -> bool:
    """True if needle is a substring of any scalar inside v (recursing into lists)."""
    if isinstance(v, list):
        return any(value_contains(item, needle) for item in v)
    if isinstance(v, str):
        return needle.lower() in v.lower()
    return False


_FILTER_RE = re.compile(r"^(!?)([a-zA-Z_][a-zA-Z0-9_]*)\s*([<>!=]=?|=)?\s*(.*)$")


class Filter:
    __slots__ = ("negate", "key", "op", "value")

    def __init__(self, negate: bool, key: str, op: str, value: str):
        self.negate = negate
        self.key = key
        self.op = op
        self.value = value

    @classmethod
    def parse(cls, expr: str) -> "Filter":
        m = _FILTER_RE.match(expr)
        if not m:
            raise ValueError(f"unrecognised filter: {expr!r}")
        neg, key, op, value = m.groups()
        return cls(bool(neg), key, op or "", value or "")

    def matches(self, fm: dict[str, Any], body: str) -> bool:
        # `!key` — true iff key is absent or null
        if self.negate and not self.op:
            return is_null(fm.get(self.key))

        if self.key == "contains":
            return bool(re.search(rf"\b{re.escape(self.value)}\b", body, re.IGNORECASE))

        if self.key == "has_anchor":
            return self.value in body

        v = fm.get(self.key)

        # files_touched substring is a common-enough special case
        if self.key == "files_touched" and self.op == "=":
            return value_contains(v, self.value)

        if self.op == "=":
            # Bool coercion shortcut
            if self.value.lower() in ("true", "false"):
                want_true = self.value.lower() == "true"
                return to_bool(v) == want_true
            # OR-within-key: a,b,c
            alts = [a.strip() for a in self.value.split(",") if a.strip()]
            if not alts:
                return False
            if isinstance(v, list):
                hay = [str(x).strip() for x in v]
                return any(a in hay for a in alts)
            if v is None:
                return False
            return str(v).strip() in alts

        if self.op in ("<", "<=", ">", ">="):
            # Comparison filters never match a note where the key is null/absent —
            # otherwise `last_revised<X` would match every note without that field.
            if is_null(v):
                return False
            # Date-aware if value looks like a date; else lex string compare.
            want_iso = coerce_date(self.value) or self.value
            have = coerce_date(v) or str(v)
            ops = {
                "<": lambda a, b: a < b,
                "<=": lambda a, b: a <= b,
                ">": lambda a, b: a > b,
                ">=": lambda a, b: a >= b,
            }
            return ops[self.op](have, want_iso)

        if self.op in ("!=",):
            return str(v).strip() != self.value

        raise ValueError(f"unsupported operator {self.op!r} in filter {self.key!r}")


def match_all(filters: list[Filter], fm: dict[str, Any], body: str) -> bool:
    for f in filters:
        try:
            if not f.matches(fm, body):
                return False
        except Exception:
            return False
    return True


def summary_record(path: Path, fm: dict[str, Any], rel: str) -> dict[str, Any]:
    return {
        "path": rel,
        "layer": fm.get("layer"),
        "repo": fm.get("repo"),
        "slug": fm.get("slug") or fm.get("topic"),
        "date": fm.get("date"),
        "last_revised": fm.get("last_revised"),
        "reviewed_by_human": fm.get("reviewed_by_human"),
        "auto_drafted": fm.get("auto_drafted"),
        "rejected": fm.get("rejected"),
        "tags": fm.get("tags"),
        "files_touched": fm.get("files_touched"),
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="cartograph_query", description=__doc__.split("\n\n")[0])
    ap.add_argument("filters", nargs="*", help="filter expressions")
    ap.add_argument("--format", choices=("paths", "json", "tsv"), default="paths")
    ap.add_argument("--limit", type=int, default=0, help="cap result count (0 = no cap)")
    ap.add_argument("--root", default=str(CARTOGRAPH_ROOT))
    args = ap.parse_args(argv)

    root = Path(args.root).resolve()
    if not root.is_dir():
        sys.stderr.write(f"cartograph_query: root {root} not found\n")
        return 2

    try:
        filters = [Filter.parse(f) for f in args.filters]
    except ValueError as exc:
        sys.stderr.write(f"cartograph_query: {exc}\n")
        return 2

    hits: list[tuple[Path, dict[str, Any]]] = []
    for path in iter_notes(root):
        fm, body = parse_frontmatter(path)
        if match_all(filters, fm, body):
            hits.append((path, fm))

    hits.sort(key=lambda pf: str(pf[0]))
    if args.limit:
        hits = hits[: args.limit]

    if args.format == "paths":
        for path, _ in hits:
            print(path.relative_to(root))
    elif args.format == "tsv":
        for path, fm in hits:
            rel = str(path.relative_to(root))
            print(f"{rel}\t{fm.get('layer','')}\t{fm.get('repo','')}\t{fm.get('date') or fm.get('last_revised','')}")
    else:
        records = [summary_record(p, fm, str(p.relative_to(root))) for p, fm in hits]
        print(json.dumps(records, default=str, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
