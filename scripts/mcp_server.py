#!/usr/bin/env python3
"""cartograph MCP server — the cross-session gateway to the corpus.

Registered at USER scope, so every Claude session on this machine
(rudrite/kernels, academy, anywhere) can query cartograph and capture
work back into it, not just sessions rooted under cartograph/.

Read tools:

* ``cartograph_search(query, repo?, layer?, k=10)`` — BM25-ranked retrieval.
* ``cartograph_notes_for_file(path)`` — reverse file-path index lookup.
* ``cartograph_drift(repo, anchor?)`` — drift report state.
* ``cartograph_bedrock(repo, file?)`` — a tracked repo's bedrock, for
  orienting a session that runs outside the injection.

Write tool:

* ``cartograph_capture(kind, project, title, body, ...)`` — file an
  episode or research note from an external project. Captures land with
  ``auto_drafted: true`` (they enter the review queue) and a
  ``captured_from`` provenance field; the serve daemon's auto-commit
  loop pushes them, and the indexes are rebuilt on write so the note is
  searchable immediately.

These tools *augment* Claude's native ``Read`` / ``Grep`` / ``Glob``;
they don't wrap them. Reverse indexes, ranked retrieval, and a
schema-correct capture path aren't reproducible with grep alone.

Run::

    python3 scripts/mcp_server.py        # stdio server, Claude Code wires this in

Registered twice on purpose: project-scope via ``.mcp.json`` (ships with
the repo) and user-scope on this machine (``claude mcp add -s user``)
so external sessions get it too. Same server; Claude Code dedupes by name.

Design: ``claude-designs/cartograph/mcp-surface/README.md``.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

# MCP stdio server using the official Python SDK. Keep imports lazy-friendly
# so a missing `mcp` package gives a clean error.
try:
    from mcp.server.fastmcp import FastMCP  # type: ignore
except ImportError:
    sys.stderr.write(
        "cartograph_mcp: `mcp` package missing. Install with: pip install --user mcp\n"
        "Or skip MCP entirely — every tool here also exists as a slash command (/find, /whatknows, /queue).\n"
    )
    sys.exit(2)


CARTOGRAPH_ROOT = Path(os.environ.get("CARTOGRAPH_ROOT") or Path(__file__).resolve().parent.parent)
mcp = FastMCP("cartograph")


def _load_index(name: str) -> dict[str, Any]:
    p = CARTOGRAPH_ROOT / ".cartograph" / "index" / f"{name}.json"
    if not p.is_file():
        raise FileNotFoundError(
            f"{p} not built. Run scripts/build-{'file' if name == 'by-file' else 'search'}-index.py"
        )
    return json.loads(p.read_text(encoding="utf-8"))


@mcp.tool()
def cartograph_search(query: str, repo: str | None = None, layer: str | None = None, k: int = 10) -> dict[str, Any]:
    """**Call this before grepping.** BM25-ranked retrieval over all Cartograph notes.

    Use this whenever:
      - the user prompt is conceptual / fuzzy ("how does X handle Y on Z")
      - you'd otherwise type ``rg "<topic>" guides/ episodes/ research/``
      - the orientation injection didn't surface anything obviously relevant

    Searches title + frontmatter values + lead paragraph of every note
    (bedrock / topic / episode / research / paper / design / learn /
    diary). Optionally narrow with ``repo`` and ``layer``.

    Returns ``{hits: [{path, title, layer, repo, score}], generated_at}``.
    """
    # Inline import so the BM25 module isn't loaded on cold start until used.
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "_bm25", CARTOGRAPH_ROOT / "scripts" / "build-search-index.py"
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    idx = _load_index("bm25")
    hits = mod.bm25_search(idx, query, k, repo, layer)
    return {"query": query, "hits": hits, "generated_at": idx.get("generated_at")}


@mcp.tool()
def cartograph_notes_for_file(path: str) -> dict[str, Any]:
    """**Call this BEFORE Read of any workspace file.** Reverse file-index lookup.

    Returns every Cartograph note (bedrock / topic / episode / learn /
    research / paper / design) that cites the given file. The topic note
    almost always explains the file better than re-deriving from code.

    The ``path`` may be full (``orbax/_src/checkpointers/foo.py``), a
    basename (``foo.py``), or any substring.

    The PreToolUse:Read hook already fires this automatically — but call
    it explicitly when:
      - you're choosing which file to open next
      - the orientation injection's file-index pass missed a path you care about
      - you want a wider net than the auto-pass (top-3) returned

    Returns ``{hits: [{path, entries: [{note, layer, anchors, sources}]}], total}``.
    """
    idx = _load_index("by-file")
    needle = (path or "").strip()
    if not needle:
        return {"hits": [], "generated_at": idx.get("generated_at")}
    hits = []
    for fp, entries in idx.get("by_file", {}).items():
        if needle in fp:
            hits.append({"path": fp, "entries": entries})
    hits.sort(key=lambda h: h["path"])
    return {"hits": hits[:50], "total": len(hits), "generated_at": idx.get("generated_at")}


@mcp.tool()
def cartograph_drift(repo: str, anchor: str | None = None) -> dict[str, Any]:
    """**Call before trusting any topic note.** Drift state for a repo.

    Call this whenever you are about to:
      - rely on a topic note's claim in a recommendation
      - extend or `/revise` a topic note
      - propose a change touching a cited line

    With no ``anchor``: returns the per-repo drift report (if upstream
    has advanced past the bedrock's ``backfilled_from_sha``) plus the
    list of any open per-topic drift reports under
    ``.drift-reports/topics/<repo>/``.

    With ``anchor=path:NNN``: scans the per-topic drift reports for
    that exact citation and returns the matching topic slugs — useful
    when you're considering re-using a cited line in your output.
    """
    repo_report = CARTOGRAPH_ROOT / ".drift-reports" / f"{repo}.md"
    topic_dir = CARTOGRAPH_ROOT / ".drift-reports" / "topics" / repo

    out: dict[str, Any] = {"repo": repo}
    if repo_report.is_file():
        out["repo_report"] = repo_report.read_text(encoding="utf-8", errors="replace")
    else:
        out["repo_report"] = None
    open_topics: list[str] = []
    if topic_dir.is_dir():
        for p in sorted(topic_dir.glob("*.md")):
            open_topics.append(str(p.relative_to(CARTOGRAPH_ROOT)))
    out["open_topic_drifts"] = open_topics

    if anchor:
        matching = []
        pattern = re.escape(anchor)
        if topic_dir.is_dir():
            for p in topic_dir.glob("*.md"):
                if re.search(pattern, p.read_text(encoding="utf-8", errors="replace")):
                    matching.append(str(p.relative_to(CARTOGRAPH_ROOT)))
        out["anchor"] = anchor
        out["topics_citing_anchor"] = matching

    return out


@mcp.tool()
def cartograph_bedrock(repo: str, file: str = "overview") -> dict[str, Any]:
    """**Call this to orient on a tracked repo from OUTSIDE cartograph.**

    Sessions rooted under cartograph/workspace get bedrock injected every
    turn; sessions elsewhere (rudrite/kernels, academy, ...) don't. This
    returns the bedrock text so any session can load the "what this
    codebase is" orientation on demand.

    ``file``: ``overview`` (default) | ``architecture`` | ``conventions``
    | ``all``. Start with ``overview``; pull the others only when the
    task goes deep (``all`` for a jax-sized repo is ~20k tokens).

    Returns ``{repo, files: {name: text}, tracked_repos}`` (the repo list
    helps when you guessed the name wrong).
    """
    guides = CARTOGRAPH_ROOT / "guides"
    tracked = sorted(
        d.name for d in guides.iterdir()
        if d.is_dir() and (d / "overview.md").is_file()
    ) if guides.is_dir() else []
    if repo not in tracked:
        # External projects earn their bedrock through the loop; before it
        # exists, orient from what the corpus already holds for them.
        topics_dir = guides / repo / "topics"
        topics = sorted(p.stem for p in topics_dir.glob("*.md")) if topics_dir.is_dir() else []
        episodes: list[str] = []
        ep_root = CARTOGRAPH_ROOT / "episodes"
        if ep_root.is_dir():
            for ep in sorted(ep_root.rglob("*.md"), reverse=True):
                text = ep.read_text(encoding="utf-8", errors="replace")[:600]
                if re.search(rf"^repo:\s*{re.escape(repo)}\s*$", text, re.MULTILINE):
                    episodes.append(str(ep.relative_to(CARTOGRAPH_ROOT)))
                if len(episodes) >= 10:
                    break
        if topics or episodes:
            return {
                "repo": repo, "files": {},
                "note": "no bedrock yet for this project; orient from its topics and episodes (Read the paths), or seed one with cartograph_capture(kind='overview')",
                "topics": [f"guides/{repo}/topics/{t}.md" for t in topics],
                "recent_episodes": episodes,
                "tracked_repos": tracked,
            }
        return {"repo": repo, "files": {}, "error": f"unknown repo '{repo}'", "tracked_repos": tracked}
    names = ["overview", "architecture", "conventions"] if file == "all" else [file]
    files: dict[str, str] = {}
    for n in names:
        fp = guides / repo / f"{n}.md"
        if fp.is_file():
            files[n] = fp.read_text(encoding="utf-8", errors="replace")
    return {"repo": repo, "files": files, "tracked_repos": tracked}


def _slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug[:80] or "untitled"


def _tracked_repo_names() -> set[str]:
    ws = CARTOGRAPH_ROOT / "workspace"
    return {d.name for d in ws.iterdir() if d.is_dir()} if ws.is_dir() else set()


def _rebuild_indexes() -> None:
    import subprocess
    for script in ("build-file-index.py", "build-search-index.py"):
        subprocess.run(
            [sys.executable, str(CARTOGRAPH_ROOT / "scripts" / script), "--quiet"],
            cwd=str(CARTOGRAPH_ROOT), capture_output=True, timeout=120, check=False,
        )


@mcp.tool()
def cartograph_capture(
    kind: str,
    project: str,
    title: str,
    body: str,
    tags: list[str] | None = None,
    files_touched: list[str] | None = None,
    sources: list[str] | None = None,
) -> dict[str, Any]:
    """**Call this to write work from an external project INTO cartograph.**

    Use at the end of any session (in rudrite/kernels, academy, anywhere)
    that produced a durable insight worth carrying forward. ``kind``:

    * ``episode`` — a per-session worknote (200-600 words: the task, the
      files that mattered, the surprise, what a future session should
      know). Lands at ``episodes/YYYY-MM/YYYY-MM-DD-<project>-<slug>.md``.
    * ``research`` — external context worth keeping (comparisons, papers
      read, ecosystem findings). Lands at ``research/<project>/<slug>.md``;
      if that note already exists the body is APPENDED as a dated update
      section (revise-in-place doctrine, never a duplicate file).
    * ``overview`` — seed or extend the project's lightweight bedrock
      (``guides/<project>/overview.md``, one file): the "what this project
      is" orientation ``cartograph_bedrock`` serves. Write it once when a
      project becomes a heavy cartograph user; the loop evolves it after.

    ``project`` is a short slug for where the work happened (``kernels``,
    ``academy``, or a tracked repo name). Captures are marked
    ``auto_drafted: true`` so they enter cartograph's review queue, carry
    ``captured_from: <project>``, and the search indexes rebuild on write
    so the note is immediately findable. The serve daemon auto-commits
    and pushes content, so do NOT git-commit the file yourself.

    Returns ``{path, action, words, warnings}``.
    """
    from datetime import date as _date

    kind = (kind or "").strip().lower()
    if kind not in ("episode", "research", "overview"):
        return {"error": "kind must be 'episode', 'research', or 'overview'"}
    project = re.sub(r"[^a-z0-9-]+", "-", (project or "").strip().lower()).strip("-")
    if not project:
        return {"error": "project is required (short slug, e.g. 'kernels')"}
    body = (body or "").strip()
    if not body:
        return {"error": "body is required"}

    words = len(body.split())
    warnings: list[str] = []
    if kind == "episode" and words > 800:
        return {"error": f"episode body is {words} words; the lint ceiling is 800. Distill or split before capturing."}
    if kind == "episode" and words < 150:
        warnings.append(f"episode is {words} words; the 200-600 range reads best")

    # Tracked-repo names are banned as tags (catch-alls with zero signal).
    tracked = _tracked_repo_names()
    tags = [t for t in (tags or []) if t and t not in tracked and t != project]

    today = _date.today().isoformat()
    slug = _slugify(title)

    def fm_list(items: list[str]) -> str:
        return "[" + ", ".join(items) + "]"

    if kind == "overview":
        # Lightweight external bedrock: ONE file per project, seeded here,
        # evolved by fold contracts and compaction afterwards.
        out_dir = CARTOGRAPH_ROOT / "guides" / project
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / "overview.md"
        if path.exists():
            existing = path.read_text(encoding="utf-8")
            path.write_text(
                existing.rstrip() + f"\n\n## {today} update: {title.strip()}\n\n{body}\n",
                encoding="utf-8",
            )
            action = "appended update section (a later compaction contract merges it in place)"
        else:
            text = (
                "---\n"
                "layer: bedrock\n"
                f"repo: {project}\n"
                "external: true\n"
                f"last_revised: {today}\n"
                f"captured_from: {project}\n"
                "---\n\n"
                f"# {project} — overview\n\n"
                f"{body}\n"
            )
            path.write_text(text, encoding="utf-8")
            action = "created"
        _rebuild_indexes()
        return {
            "path": str(path.relative_to(CARTOGRAPH_ROOT)),
            "action": action,
            "words": words,
            "warnings": warnings,
            "note": "lightweight external bedrock; cartograph_bedrock now serves it to any session",
        }

    if kind == "episode":
        out_dir = CARTOGRAPH_ROOT / "episodes" / today[:7]
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"{today}-{project}-{slug}.md"
        n = 2
        while path.exists():
            path = out_dir / f"{today}-{project}-{slug}-{n}.md"
            n += 1
        ft = "".join(f"  - {f}\n" for f in (files_touched or []))
        text = (
            "---\n"
            "layer: episode\n"
            f"date: {today}\n"
            f"repo: {project}\n"
            f"captured_from: {project}\n"
            + ("files_touched:\n" + ft if ft else "files_touched: []\n")
            + f"tags: {fm_list(tags)}\n"
            "superseded_by: ~\n"
            "distilled_into: ~\n"
            "auto_drafted: true\n"
            "reviewed_by_human: ~\n"
            "rejected: false\n"
            "---\n\n"
            f"# {title.strip()}\n\n"
            f"{body}\n"
        )
        path.write_text(text, encoding="utf-8")
        action = "created"
    else:
        out_dir = CARTOGRAPH_ROOT / "research" / project
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"{slug}.md"
        if path.exists():
            existing = path.read_text(encoding="utf-8")
            path.write_text(
                existing.rstrip() + f"\n\n## {today} update: {title.strip()}\n\n{body}\n",
                encoding="utf-8",
            )
            action = "appended update section"
        else:
            src = "".join(f"  - {u}\n" for u in (sources or []))
            text = (
                "---\n"
                "layer: research\n"
                f"repo: {project}\n"
                f"date: {today}\n"
                f"captured_from: {project}\n"
                f"tags: {fm_list(tags)}\n"
                + ("sources:\n" + src if src else "sources: []\n")
                + "auto_drafted: true\n"
                "reviewed_by_human: ~\n"
                "rejected: false\n"
                "---\n\n"
                f"# {title.strip()}\n\n"
                f"{body}\n"
            )
            path.write_text(text, encoding="utf-8")
            action = "created"

    _rebuild_indexes()
    return {
        "path": str(path.relative_to(CARTOGRAPH_ROOT)),
        "action": action,
        "words": words,
        "warnings": warnings,
        "note": "auto-committed by the serve daemon shortly; it enters the review queue as a pending draft",
    }


if __name__ == "__main__":
    mcp.run()
