#!/usr/bin/env python3
"""Validate note frontmatter across all content layers.

A single malformed frontmatter block degrades the whole retrieval pipeline
silently — the indexers skip or mis-parse the note and it stops being
injectable. This runs at SessionStart (before the index builds) and from
maintenance, reporting problems instead of letting them rot.

Checks per note:
  - frontmatter block present and delimited (--- ... ---)
  - parses line-by-line as `key: value` (tolerates block lists / multiline
    values; flags tab-indented keys and unclosed blocks)
  - layer-specific required fields:
      episode: layer, date, tags
      topic (guides/*/topics/): layer, topic, last_revised

Exit 0 always (observational); problems go to stdout and, when
--errors-log is passed, one summary line is appended in the
ISO8601<TAB>script<TAB>message format of .cartograph/errors.log.
"""

import argparse
import datetime
import pathlib
import re
import sys

CONTENT_DIRS = ("guides", "episodes", "research", "papers", "research_papers", "learn")

REQUIRED = {
    "episode": ("layer", "date", "tags"),
    "topic": ("layer", "topic", "last_revised"),
}


def classify(rel: str) -> str | None:
    if rel.startswith("episodes/"):
        return "episode"
    if rel.startswith("guides/") and "/topics/" in rel:
        return "topic"
    return None


def check_note(path: pathlib.Path, rel: str) -> list[str]:
    problems: list[str] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return [f"unreadable: {exc}"]

    if not text.startswith("---\n"):
        kind = classify(rel)
        if kind:  # bedrock/research without frontmatter is tolerated
            problems.append("missing frontmatter block")
        return problems

    end = text.find("\n---", 4)
    if end == -1:
        return ["unclosed frontmatter block"]

    fm = text[4:end]
    keys = set()
    for i, line in enumerate(fm.splitlines(), start=2):
        if not line.strip() or line.startswith("#"):
            continue
        if line.startswith("\t"):
            problems.append(f"line {i}: tab-indented (YAML requires spaces)")
            continue
        if line.startswith(" "):  # continuation of a block list / nested map
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):(\s|$)", line)
        if not m:
            problems.append(f"line {i}: not `key: value` — {line[:60]!r}")
            continue
        keys.add(m.group(1))

    kind = classify(rel)
    if kind:
        for field in REQUIRED[kind]:
            if field not in keys:
                problems.append(f"missing required field `{field}:` ({kind})")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--errors-log", default="")
    args = ap.parse_args()

    root = pathlib.Path(args.root).resolve()
    bad: dict[str, list[str]] = {}
    n_checked = 0
    for sub in CONTENT_DIRS:
        base = root / sub
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.md")):
            rel = str(path.relative_to(root))
            n_checked += 1
            problems = check_note(path, rel)
            if problems:
                bad[rel] = problems

    if bad and not args.quiet:
        print(f"[frontmatter] {len(bad)} of {n_checked} notes have problems:")
        for rel, problems in bad.items():
            for p in problems:
                print(f"  {rel}: {p}")
    elif not args.quiet:
        print(f"[frontmatter] {n_checked} notes OK")

    if bad and args.errors_log:
        log = pathlib.Path(args.errors_log)
        log.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
        worst = next(iter(bad))
        with log.open("a") as fh:
            fh.write(
                f"{ts}\tvalidate-frontmatter\t{len(bad)} notes with "
                f"frontmatter problems (first: {worst})\n"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
