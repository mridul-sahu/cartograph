#!/usr/bin/env python3
"""cartograph MCP server — three augmenting tools over the local corpus.

Tools (read-only, deliberately):

* ``cartograph_search(query, repo?, layer?, k=10)`` — BM25-ranked retrieval.
* ``cartograph_notes_for_file(path)`` — reverse file-path index lookup.
* ``cartograph_drift(repo, anchor?)`` — drift report state.

These tools *augment* Claude's native ``Read`` / ``Grep`` / ``Glob`` —
they don't wrap. The wrapping-vs-augmenting distinction is exactly what
``claude-designs/cartograph/mcp-surface/`` argued for. Reverse indexes
and ranked retrieval aren't reproducible with grep alone.

Run::

    python3 scripts/mcp_server.py        # stdio server, Claude Code wires this in

Wired into ``.claude/settings.json`` ``mcpServers``. The server has no
write surface — frontmatter mutations still happen via
``scripts/lib/frontmatter.sh`` from the slash commands.

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


if __name__ == "__main__":
    mcp.run()
