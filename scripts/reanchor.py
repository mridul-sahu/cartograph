#!/usr/bin/env python3
"""Deterministic re-anchoring of `path:NNN` citations in cartograph notes.

Most drift is bookkeeping: upstream inserted or removed lines above a
cited region, so every anchor below the edit is off by a constant, while
the cited content itself is unchanged. Resolving that never needs a
model. This script remaps such anchors mechanically:

  1. For each note with an open per-topic drift report (or each bedrock
     guide when the repo-level report is open), determine the baseline:
     the commit the anchors were written against. Bedrock records it
     exactly (`backfilled_from_sha`); topic notes get the last `main`
     commit on or before their `last_revised` date.
  2. For each cited file, diff baseline content against the current
     worktree with difflib. A cited line inside an `equal` block maps to
     its new position by offset arithmetic; the mapped line is textually
     identical by construction, so the rewrite is safe. A cited line
     inside a changed block is genuine drift and is left alone.
  3. Rewrite remapped anchors in the note body. Frontmatter is never
     touched: `last_revised` remains a human-verification date.

After a pass, re-run `topic-drift.sh <repo>`: reports whose flags were
pure shifts regenerate empty and close; what remains is real drift for
the active session to review (CLAUDE.md §4). No tokens are spent
anywhere in this path.

Usage:
  reanchor.py <repo> [--all-notes] [--dry-run] [-v]

  --all-notes  process every topic note + bedrock guide, not just those
               with open drift reports.
"""

from __future__ import annotations

import argparse
import difflib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = ROOT / "workspace"
GUIDES = ROOT / "guides"
DRIFT_TOPICS = ROOT / ".drift-reports" / "topics"
DRIFT_REPO = ROOT / ".drift-reports"

# Mirrors topic-drift.sh's extractor: path.ext:NNN with a code extension.
ANCHOR_RE = re.compile(
    r"([a-zA-Z0-9_./-]+\.(?:py|pyi|cc|cpp|h|hh|hpp|c|ts|tsx|js|go|rs|bzl)):(\d+)(?!\d)"
)
FM_RE = re.compile(r"^---\s*$")


def git(fork: Path, *args: str) -> str:
    r = subprocess.run(
        ["git", "-C", str(fork), *args],
        capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()[:200]}")
    return r.stdout


def frontmatter(text: str) -> dict[str, str]:
    lines = text.splitlines()
    if not lines or not FM_RE.match(lines[0]):
        return {}
    fm: dict[str, str] = {}
    for line in lines[1:]:
        if FM_RE.match(line):
            break
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$", line)
        if m:
            fm[m.group(1)] = m.group(2).strip().strip("\"'")
    return fm


def body_start(text: str) -> int:
    """Character offset where the body (post-frontmatter) begins."""
    lines = text.splitlines(keepends=True)
    if not lines or not FM_RE.match(lines[0].rstrip("\n")):
        return 0
    offset = len(lines[0])
    for line in lines[1:]:
        offset += len(line)
        if FM_RE.match(line.rstrip("\n")):
            return offset
    return 0


class Fork:
    """Suffix-resolution + baseline file cache for one workspace fork."""

    def __init__(self, repo: str):
        self.dir = WORKSPACE / repo
        if not (self.dir / ".git").is_dir():
            raise SystemExit(f"reanchor: workspace/{repo} is not a git repo")
        self._suffix: dict[str, list[str]] = {}
        for tracked in git(self.dir, "ls-files").splitlines():
            self._suffix.setdefault(Path(tracked).name, []).append(tracked)
        self._old_cache: dict[tuple[str, str], list[str] | None] = {}
        self._new_cache: dict[str, list[str] | None] = {}
        self._opcode_cache: dict[tuple[str, str], list | None] = {}

    def resolve(self, cited: str) -> tuple[str | None, str]:
        """Cited path -> (unique repo-relative path, reason-if-None)."""
        if (self.dir / cited).is_file():
            return cited, ""
        candidates = [
            p for p in self._suffix.get(Path(cited).name, [])
            if p == cited or p.endswith("/" + cited)
        ]
        if len(candidates) == 1:
            return candidates[0], ""
        if not candidates:
            return None, "file deleted/renamed upstream"
        return None, f"short citation is ambiguous ({len(candidates)} candidates); cite a fuller path"

    def baseline_commit(self, fm: dict[str, str]) -> str | None:
        sha = fm.get("backfilled_from_sha", "")
        if re.fullmatch(r"[0-9a-f]{7,40}", sha):
            return sha
        date = fm.get("last_revised", "")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            return None
        out = git(
            self.dir, "rev-list", "-1",
            f"--before={date}T23:59:59", "main",
        ).strip()
        return out or None

    def old_lines(self, commit: str, path: str) -> list[str] | None:
        key = (commit, path)
        if key not in self._old_cache:
            try:
                self._old_cache[key] = git(
                    self.dir, "show", f"{commit}:{path}"
                ).splitlines()
            except RuntimeError:
                self._old_cache[key] = None
        return self._old_cache[key]

    def new_lines(self, path: str) -> list[str] | None:
        if path not in self._new_cache:
            try:
                self._new_cache[path] = (
                    (self.dir / path)
                    .read_text(encoding="utf-8", errors="replace")
                    .splitlines()
                )
            except OSError:
                self._new_cache[path] = None
        return self._new_cache[path]

    def map_line(self, commit: str, path: str, line: int) -> int | None:
        """Old 1-based line -> new 1-based line, only via an equal block."""
        key = (commit, path)
        if key not in self._opcode_cache:
            old = self.old_lines(commit, path)
            new = self.new_lines(path)
            if old is None or new is None:
                self._opcode_cache[key] = None
            else:
                self._opcode_cache[key] = difflib.SequenceMatcher(
                    None, old, new, autojunk=False
                ).get_opcodes()
        ops = self._opcode_cache[key]
        if ops is None:
            return None
        idx = line - 1
        for tag, a1, a2, b1, b2 in ops:
            if tag == "equal" and a1 <= idx < a2:
                return b1 + (idx - a1) + 1
        return None


def notes_for_repo(repo: str, all_notes: bool) -> list[Path]:
    picked: list[Path] = []
    topics = GUIDES / repo / "topics"
    if all_notes:
        picked += sorted(topics.glob("*.md"))
        picked += [
            GUIDES / repo / f
            for f in ("overview.md", "architecture.md", "conventions.md")
            if (GUIDES / repo / f).is_file()
        ]
        return picked
    report_dir = DRIFT_TOPICS / repo
    if report_dir.is_dir():
        for report in sorted(report_dir.glob("*.md")):
            note = topics / report.name
            if note.is_file():
                picked.append(note)
    if (DRIFT_REPO / f"{repo}.md").is_file():
        picked += [
            GUIDES / repo / f
            for f in ("overview.md", "architecture.md", "conventions.md")
            if (GUIDES / repo / f).is_file()
        ]
    return picked


def reanchor_note(
    fork: Fork, note: Path, *, dry_run: bool, verbose: bool
) -> tuple[int, int, list[str]]:
    """Returns (anchors_remapped, anchors_left_flagged, problem_lines)."""
    text = note.read_text(encoding="utf-8")
    fm = frontmatter(text)
    commit = fork.baseline_commit(fm)
    if commit is None:
        if verbose:
            print(f"  {note.name}: no baseline (missing sha/date); skipped")
        return (0, 0, [])

    start = body_start(text)
    head, body = text[:start], text[start:]

    # cited path -> {old_line -> new_line}; built first, applied in one
    # regex pass so chained renumbering (45->52 while 52->60) cannot
    # cascade. `problems` collects citations no mechanical pass can fix:
    # these are the report's true content.
    remap: dict[str, dict[int, int]] = {}
    problems: list[str] = []
    anchors = sorted(set(ANCHOR_RE.findall(body)))
    # Note-local disambiguation: a short cite (`type_handlers.py:80`) is
    # almost always shorthand for a full path the same note cites
    # elsewhere. Only unique-within-the-note basenames qualify.
    local_by_name: dict[str, set[str]] = {}
    for cited, _ in anchors:
        r, _why = fork.resolve(cited)
        if r is not None:
            local_by_name.setdefault(Path(r).name, set()).add(r)
    for cited, line_s in anchors:
        line = int(line_s)
        resolved, why = fork.resolve(cited)
        if resolved is None and "ambiguous" in why:
            local = local_by_name.get(Path(cited).name, set())
            if len(local) == 1:
                resolved, why = next(iter(local)), ""
        if resolved is None:
            problems.append(f"{cited}:{line}    {why}")
            continue
        new_line = fork.map_line(commit, resolved, line)
        if new_line is None:
            problems.append(f"{cited}:{line}    cited line's content changed since baseline")
            if verbose:
                print(f"  {note.name}: {cited}:{line} content changed; left for review")
        elif new_line != line:
            remap.setdefault(cited, {})[line] = new_line

    unmapped = len(problems)
    if not remap:
        return (0, unmapped, problems)

    moved = sum(len(v) for v in remap.values())

    def sub(m: re.Match) -> str:
        cited, line = m.group(1), int(m.group(2))
        new = remap.get(cited, {}).get(line)
        return f"{cited}:{new}" if new is not None else m.group(0)

    new_body = ANCHOR_RE.sub(sub, body)
    if not dry_run and new_body != body:
        note.write_text(head + new_body, encoding="utf-8")
    print(
        f"  {note.relative_to(ROOT)}: {moved} anchor(s) remapped"
        f"{' (dry-run)' if dry_run else ''}, {unmapped} left for review"
    )
    return (moved, unmapped, problems)


def rewrite_report(
    repo: str, note: Path, problems: list[str], *, dry_run: bool
) -> bool:
    """Filter the per-topic drift report down to citations needing judgment.

    topic-drift.sh is deliberately broad (a ±15-line window near any
    change flags a citation). After re-anchoring, the only citations that
    matter are the ones no mechanical pass could resolve. The report is
    rewritten to exactly that set, and deleted when the set is empty, so
    'report open' always means 'a human (the active session) must read
    something'. Returns True when the report was closed.
    """
    report = DRIFT_TOPICS / repo / note.name
    if not report.is_file():
        return False
    if dry_run:
        return not problems
    if not problems:
        report.unlink()
        print(f"  closed {report.relative_to(ROOT)} (all flags were line shifts)")
        return True
    fm = frontmatter(note.read_text(encoding="utf-8"))
    slug = note.stem
    lines = [
        f"# Drift: {repo}/topics/{slug}.md",
        "",
        f"Last revised {fm.get('last_revised', '?')}. Mechanically re-anchored;"
        " the citations below could NOT be resolved without judgment.",
        "",
        f"## Citations needing review ({len(problems)})",
        "",
    ]
    lines += [f"- `{p}`" for p in problems]
    lines += [
        "",
        "## What to do",
        "",
        "Read each cited region. If the note's claims are contradicted,",
        "revise per CLAUDE.md §4 and bump `last_revised:`. Ambiguous short",
        "citations just need the fuller path written into the note.",
        "",
        f"Use `/revise {slug}` — it reads this report and pre-stages diffs.",
    ]
    report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("repo")
    ap.add_argument("--all-notes", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    fork = Fork(args.repo)
    notes = notes_for_repo(args.repo, args.all_notes)
    if not notes:
        print(f"reanchor: no notes to process for {args.repo}")
        return 0

    total_moved = total_left = closed = 0
    for note in notes:
        moved, left, problems = reanchor_note(
            fork, note, dry_run=args.dry_run, verbose=args.verbose
        )
        total_moved += moved
        total_left += left
        if note.parent.name == "topics":
            if rewrite_report(args.repo, note, problems, dry_run=args.dry_run):
                closed += 1
    print(
        f"reanchor: {args.repo}: {total_moved} anchor(s) remapped across "
        f"{len(notes)} note(s); {closed} report(s) closed; "
        f"{total_left} citation(s) need human review"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
