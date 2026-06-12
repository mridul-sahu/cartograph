#!/usr/bin/env python3
"""Cartograph status server.

Serves the built Astro app (``web/dist/``) at ``localhost:47777`` plus a small
JSON API so the web UI can show live drift / activity / doctor status without
re-bundling on every fetch, and accept human review verdicts on topic notes.

Endpoints
---------
GET  /api/status                            : drift + topic counts + doctor summary.
GET  /api/drift/{repo}                      : raw markdown for ``.drift-reports/<repo>.md``.
GET  /api/activity                          : last 50 upstream commits across all forks.
POST /api/topic/{repo}/{topic}/review       : write a human review verdict into the
                                              topic's frontmatter (``reviewed_by_human``
                                              and ``review_notes``). The only write
                                              path in the entire server.

Source data lives in:
- ``guides/<repo>/overview.md`` frontmatter (``backfilled_from_sha``).
- ``guides/<repo>/topics/<topic>.md`` frontmatter (audit endpoint mutates this).
- ``workspace/<repo>/`` git refs (``upstream/main``).
- ``.drift-reports/<repo>.md`` (if present).
- ``learn/{ramp-up,walkthroughs,drafts}/`` for counts.

The review endpoint is intentionally local-only (the server binds
``127.0.0.1`` — see ``main``); there is no auth gate. ``uvicorn`` runs in
single-worker mode; the ``--reload`` flag defaults ON so a `git pull`
or local edit to this file picks up without a manual restart. Disable
with ``CARTOGRAPH_RELOAD=0`` if you need a stable PID (e.g. for a
process supervisor).

Run::

    python scripts/serve.py            # binds 127.0.0.1:47777, reload=on
    CARTOGRAPH_RELOAD=0 python scripts/serve.py  # disable auto-reload
"""
from __future__ import annotations

import json
import logging
import os
import signal
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from functools import lru_cache, wraps
from pathlib import Path
from typing import Any, Callable

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover - PyYAML is optional fallback path
    yaml = None  # type: ignore

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles


_LANGUAGE_BY_EXT = {
    ".py": "python",
    ".pyi": "python",
    ".pyx": "python",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cxx": "cpp",
    ".c": "c",
    ".h": "cpp",
    ".hh": "cpp",
    ".hpp": "cpp",
    ".go": "go",
    ".rs": "rust",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".md": "markdown",
    ".mdx": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".json": "json",
    ".sql": "sql",
    ".bzl": "python",
    ".html": "html",
    ".css": "css",
}


def _infer_language(file_path: str) -> str:
    ext = Path(file_path).suffix.lower()
    if ext in _LANGUAGE_BY_EXT:
        return _LANGUAGE_BY_EXT[ext]
    name = Path(file_path).name
    if name in {"BUILD", "BUILD.bazel", "WORKSPACE", "MODULE.bazel"}:
        return "python"  # Bazel uses Starlark which is a Python dialect
    if name == "Dockerfile":
        return "dockerfile"
    if name == "Makefile" or name == "justfile":
        return "makefile"
    return "text"

LOG = logging.getLogger("cartograph.serve")

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Load KEY=value lines from a .env-style file into os.environ.

    Real environment variables win — only sets keys that aren't already in
    os.environ. Matches the precedence rules in scripts/lib/load-config.sh.
    """
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        os.environ.setdefault(key, val)


_load_dotenv(PROJECT_ROOT / "cartograph.env")

# Wall-clock start of this process. With reload on, uvicorn re-execs a fresh
# worker on each code change, so this naturally reflects the *current* worker's
# uptime rather than the original launch.
_PROCESS_START = time.time()


def _ttl_cache(seconds: float) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Memoize a compute function's result for ``seconds`` per distinct args.

    Built for the polled endpoints (/api/status, /api/activity) whose
    underlying compute walks git + frontmatter on every request. Single
    process, low key cardinality — a plain dict guarded by a lock is
    enough. The wrapper grows a ``cache_clear()`` so the content-watch
    loop can invalidate eagerly when content changes on disk.
    """
    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        lock = threading.Lock()
        cache: dict[tuple[Any, ...], tuple[float, Any]] = {}

        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            key = (args, tuple(sorted(kwargs.items())))
            now = time.monotonic()
            with lock:
                hit = cache.get(key)
                if hit is not None and now < hit[0]:
                    return hit[1]
            value = fn(*args, **kwargs)
            with lock:
                cache[key] = (now + seconds, value)
            return value

        def cache_clear() -> None:
            with lock:
                cache.clear()

        wrapper.cache_clear = cache_clear  # type: ignore[attr-defined]
        return wrapper

    return decorate

CONFIG_PATH = PROJECT_ROOT / "cartograph.env"

# Curated registry of every user-settable CARTOGRAPH_* variable, surfaced by
# /api/config and the /settings page. `type` drives the form widget; `applies`
# is "restart" for keys serve.py reads from its own process env (cartograph.env
# is loaded once at startup), "immediate" for keys that bash scripts re-source
# on every run. `readonly` entries are shown for context but never written.
#
# Excluded on purpose: CARTOGRAPH_AUTO_DRAFTED (internal marker set by scripts),
# CARTOGRAPH_WORKSPACE (path footgun — terminal-only).
CONFIG_SCHEMA: tuple[dict[str, Any], ...] = (
    # --- Identity & GitHub ---
    {"key": "CARTOGRAPH_GITHUB_USER", "group": "Identity & GitHub", "type": "string",
     "default": "", "applies": "restart", "required": True,
     "label": "GitHub user", "help": "GitHub account for forks, PR queries, and git identity."},
    {"key": "CARTOGRAPH_GIT_USER_NAME", "group": "Identity & GitHub", "type": "string",
     "default": "", "applies": "immediate", "required": True,
     "label": "Git user.name", "help": "git user.name written into per-fork .git/config."},
    {"key": "CARTOGRAPH_GIT_USER_EMAIL", "group": "Identity & GitHub", "type": "string",
     "default": "", "applies": "immediate", "required": True,
     "label": "Git user.email", "help": "git user.email for per-fork commits (your open-source identity)."},
    {"key": "CARTOGRAPH_SSH_HOST_ALIAS", "group": "Identity & GitHub", "type": "string",
     "default": "github.com", "applies": "immediate",
     "label": "SSH host alias", "help": "Host alias in fork/upstream URLs (git@<alias>:owner/repo.git)."},
    {"key": "CARTOGRAPH_SSH_COMMAND", "group": "Identity & GitHub", "type": "string",
     "default": "", "applies": "immediate",
     "label": "SSH command", "help": "Explicit core.sshCommand per fork (pins a key). Empty = shell default."},
    {"key": "CARTOGRAPH_FORBIDDEN_EXTRAS", "group": "Identity & GitHub", "type": "string",
     "default": "", "applies": "immediate",
     "label": "Forbidden token extras", "help": "Comma-separated extra forbidden tokens for lint + token-check."},
    {"key": "CARTOGRAPH_PUBLISH_DEST", "group": "Identity & GitHub", "type": "string",
     "default": "", "applies": "immediate",
     "label": "Publish destination", "help": "owner/repo for `just publish`. Empty = <github-user>/cartograph."},

    # --- Auto-curation ---
    {"key": "CARTOGRAPH_AUTO_PROMOTE", "group": "Auto-curation", "type": "bool",
     "default": "1", "applies": "immediate",
     "label": "Auto-promote", "help": "Master switch for the episode→topic→bedrock cascade."},
    {"key": "CARTOGRAPH_AUTO_PROMOTE_EPISODES", "group": "Auto-curation", "type": "int",
     "default": "3", "applies": "immediate",
     "label": "Promote: min episodes", "help": "Minimum episodes sharing a tag before topic promotion."},
    {"key": "CARTOGRAPH_AUTO_PROMOTE_MAX_PER_RUN", "group": "Auto-curation", "type": "int",
     "default": "2", "applies": "immediate",
     "label": "Promote: max per run", "help": "Cap on promotions per SessionStart run (token budget)."},
    {"key": "CARTOGRAPH_AUTO_EPISODE", "group": "Auto-curation", "type": "bool",
     "default": "1", "applies": "immediate",
     "label": "Auto-episode", "help": "Auto-draft an episode from a session log at Stop."},
    {"key": "CARTOGRAPH_AUTO_EPISODE_THRESHOLD", "group": "Auto-curation", "type": "int",
     "default": "3", "applies": "immediate",
     "label": "Auto-episode threshold", "help": "Minimum edits in a session to trigger an auto-episode."},
    {"key": "CARTOGRAPH_AUTO_RESEARCH", "group": "Auto-curation", "type": "bool",
     "default": "1", "applies": "immediate",
     "label": "Auto-research", "help": "Auto-draft a research note from a high-value session."},
    {"key": "CARTOGRAPH_AUTO_RESEARCH_THRESHOLD", "group": "Auto-curation", "type": "int",
     "default": "2", "applies": "immediate",
     "label": "Auto-research threshold", "help": "Minimum research-triggering events to spawn research."},
    {"key": "CARTOGRAPH_DIGEST_THRESHOLD", "group": "Auto-curation", "type": "int",
     "default": "3", "applies": "immediate",
     "label": "Digest threshold", "help": "Min episodes/tag (in lookback) to suggest /promote at SessionStart."},
    {"key": "CARTOGRAPH_DIGEST_LOOKBACK_DAYS", "group": "Auto-curation", "type": "int",
     "default": "90", "applies": "immediate",
     "label": "Digest lookback (days)", "help": "How far back the SessionStart digest scans episodes."},

    # --- Headless spawn control ---
    {"key": "CARTOGRAPH_HEADLESS_MAX", "group": "Headless control", "type": "int",
     "default": "1", "applies": "immediate",
     "label": "Max concurrent agents", "help": "Global cap on concurrent headless claude agents across all spawn points."},
    {"key": "CARTOGRAPH_HEADLESS_DISABLE", "group": "Headless control", "type": "bool",
     "default": "0", "applies": "immediate",
     "label": "Disable headless spawns", "help": "1 = hard kill switch: no autonomous headless agent spawns at all."},
    {"key": "CARTOGRAPH_CURATE_INTERVAL", "group": "Headless control", "type": "int",
     "default": "1800", "applies": "restart",
     "label": "Curate drain interval (s)", "help": "Seconds between batched curation drains (one agent drains the whole queue)."},
    {"key": "CARTOGRAPH_CURATE_BATCH_MAX", "group": "Headless control", "type": "int",
     "default": "8", "applies": "immediate",
     "label": "Curate batch size", "help": "Max tasks one drain agent handles per pass; the rest drain next interval."},
    {"key": "CARTOGRAPH_BUILD_MIN_INTERVAL", "group": "Headless control", "type": "int",
     "default": "300", "applies": "restart",
     "label": "Min build interval (s)", "help": "Minimum seconds between static-site rebuilds (coalesces a fold storm into one build)."},

    # --- Push toggles ---
    {"key": "CARTOGRAPH_AUTO_REVISE_PUSH", "group": "Push toggles", "type": "bool",
     "default": "1", "applies": "immediate",
     "label": "Auto-revise push", "help": "0 = auto-revise commits/stages bedrock but does not push."},
    {"key": "CARTOGRAPH_BACKFILL_PUSH", "group": "Push toggles", "type": "bool",
     "default": "1", "applies": "immediate",
     "label": "Backfill push", "help": "0 = backfill commits/stages bedrock but does not push."},
    {"key": "CARTOGRAPH_DRAFT_PUSH", "group": "Push toggles", "type": "bool",
     "default": "1", "applies": "immediate",
     "label": "Draft push", "help": "0 = episode/research drafts written locally, not pushed."},
    {"key": "CARTOGRAPH_REVISE_PUSH", "group": "Push toggles", "type": "bool",
     "default": "1", "applies": "immediate",
     "label": "Revise push", "help": "0 = rejected-topic revisions staged but not pushed."},
    {"key": "CARTOGRAPH_SESSION_PUSH", "group": "Push toggles", "type": "bool",
     "default": "1", "applies": "immediate",
     "label": "Session-log push", "help": "0 = session logs written locally, not pushed."},
    {"key": "CARTOGRAPH_SYNC_PUSH", "group": "Push toggles", "type": "bool",
     "default": "1", "applies": "immediate",
     "label": "Upstream-sync push", "help": "0 = upstream syncs fetched locally, not pushed to the fork."},

    # --- Queue & tuning ---
    {"key": "CARTOGRAPH_QUEUE_TOPIC_AGE_DAYS", "group": "Queue & tuning", "type": "int",
     "default": "90", "applies": "restart",
     "label": "Topic stale age (days)", "help": "How old a topic gets before it enters the review-debt queue."},
    {"key": "CARTOGRAPH_QUEUE_LEASE_TTL_MIN", "group": "Queue & tuning", "type": "int",
     "default": "30", "applies": "immediate",
     "label": "Queue lease TTL (min)", "help": "TTL for concurrent-work advisory leases on topics."},
    {"key": "CARTOGRAPH_WORKNOTE_TTL", "group": "Queue & tuning", "type": "int",
     "default": "30", "applies": "immediate",
     "label": "Worknote TTL (min)", "help": "Advisory lease duration for concurrent work on a topic slug."},
    {"key": "CARTOGRAPH_CITE_CAP", "group": "Queue & tuning", "type": "int",
     "default": "10", "applies": "immediate",
     "label": "Cite cap", "help": "Max results per content layer in the /cite lookup."},

    # --- Claude invocation flags (advanced) ---
    {"key": "CARTOGRAPH_ASK_CLAUDE_FLAGS", "group": "Claude flags", "type": "flags",
     "default": "", "applies": "restart",
     "label": "/api/ask flags", "help": "claude -p flags for the AskClaude endpoint. Empty = built-in default."},
    {"key": "CARTOGRAPH_AUTO_REVISE_CLAUDE_FLAGS", "group": "Claude flags", "type": "flags",
     "default": "", "applies": "immediate",
     "label": "auto-revise flags", "help": "claude -p flags for auto-revise runs. Empty = built-in default."},
    {"key": "CARTOGRAPH_BACKFILL_CLAUDE_FLAGS", "group": "Claude flags", "type": "flags",
     "default": "", "applies": "immediate",
     "label": "backfill flags", "help": "claude -p flags for backfill runs. Empty = built-in default."},
    {"key": "CARTOGRAPH_FOLD_CLAUDE_FLAGS", "group": "Claude flags", "type": "flags",
     "default": "", "applies": "immediate",
     "label": "fold flags", "help": "claude -p flags for topic→bedrock folding. Empty = built-in default."},
    {"key": "CARTOGRAPH_PROMOTE_CLAUDE_FLAGS", "group": "Claude flags", "type": "flags",
     "default": "", "applies": "immediate",
     "label": "promote flags", "help": "claude -p flags for episode→topic promotion. Empty = built-in default."},
    {"key": "CARTOGRAPH_REVISE_CLAUDE_FLAGS", "group": "Claude flags", "type": "flags",
     "default": "", "applies": "immediate",
     "label": "revise flags", "help": "claude -p flags for rejected-topic revision. Empty = built-in default."},

    # --- Server & runtime ---
    {"key": "CARTOGRAPH_RELOAD", "group": "Server & runtime", "type": "bool",
     "default": "1", "applies": "restart",
     "label": "Auto-reload", "help": "uvicorn auto-reload. Set 0 for a stable PID under a supervisor."},
    {"key": "CARTOGRAPH_CODE_SERVER_PORT", "group": "Server & runtime", "type": "int",
     "default": "47780", "applies": "immediate",
     "label": "code-server port", "help": "Port for the embedded code-server (VS Code) instance."},

    # --- Runtime info (read-only) ---
    {"key": "CARTOGRAPH_ROOT", "group": "Runtime info", "type": "readonly",
     "default": str(PROJECT_ROOT), "applies": "restart",
     "label": "Root", "help": "Cartograph repo root (auto-derived)."},
    {"key": "CARTOGRAPH_PYTHON", "group": "Runtime info", "type": "readonly",
     "default": sys.executable, "applies": "restart",
     "label": "Python", "help": "Interpreter running the server."},
    {"key": "CARTOGRAPH_SERVER_URL", "group": "Runtime info", "type": "readonly",
     "default": "http://127.0.0.1:47777", "applies": "restart",
     "label": "Server URL", "help": "Local API base used by hooks + scripts."},
)

_CONFIG_SAFE = re.compile(r"^[A-Za-z0-9_./:@,+-]+$")


def _config_quote(val: str) -> str:
    """Render a value for cartograph.env.

    The .env parsers on both sides (this file's ``_load_dotenv`` and
    ``scripts/lib/load-config.sh``) strip exactly one surrounding quote pair
    with no escape handling — so wrapping a value in plain double quotes
    round-trips any inner content (including embedded quotes) faithfully.
    """
    if val == "":
        return ""
    if _CONFIG_SAFE.match(val):
        return val
    return '"' + val + '"'


def _read_config_file() -> dict[str, str]:
    """Parse cartograph.env into {key: value} (same semantics as _load_dotenv)."""
    out: dict[str, str] = {}
    if not CONFIG_PATH.exists():
        return out
    for raw in CONFIG_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        out[key] = val
    return out


def _write_config_file(updates: dict[str, str], removals: set[str]) -> list[str]:
    """Upsert/remove keys in cartograph.env, preserving comments + order.

    Returns the keys actually touched. Writes atomically (temp + os.replace).
    """
    existing = CONFIG_PATH.read_text(encoding="utf-8").splitlines() if CONFIG_PATH.exists() else []
    out_lines: list[str] = []
    changed: list[str] = []
    seen: set[str] = set()
    for raw in existing:
        stripped = raw.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            out_lines.append(raw)
            continue
        key = stripped.partition("=")[0].strip()
        if key in removals:
            changed.append(key)
            continue  # drop the line
        if key in updates:
            out_lines.append(f"{key}={_config_quote(updates[key])}")
            seen.add(key)
            changed.append(key)
            continue
        out_lines.append(raw)
    new_keys = [k for k in updates if k not in seen]
    if new_keys:
        # One blank separator before the appended block (collapsed away on
        # removal since it ends up trailing and gets rstripped). No provenance
        # header — that would orphan when its keys are later removed.
        if out_lines and out_lines[-1].strip():
            out_lines.append("")
        for k in new_keys:
            out_lines.append(f"{k}={_config_quote(updates[k])}")
            changed.append(k)
    text = "\n".join(out_lines).rstrip("\n") + "\n"
    fd, tmp = tempfile.mkstemp(dir=str(CONFIG_PATH.parent), prefix=".cartograph.env.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, CONFIG_PATH)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return changed


def _validate_config_value(entry: dict[str, Any], val: str) -> str | None:
    """Return an error string if `val` is invalid for `entry`, else None."""
    if entry.get("required") and val == "":
        return "value is required"
    if val == "":
        return None
    t = entry["type"]
    if t == "bool" and val not in ("0", "1"):
        return "must be 0 or 1"
    if t == "int":
        try:
            int(val)
        except ValueError:
            return "must be an integer"
    if t == "enum" and val not in entry.get("choices", []):
        return f"must be one of {entry.get('choices', [])}"
    return None


def _cartograph_user() -> str:
    """Configured GitHub user for PR queries. Empty string if unset."""
    return os.environ.get("CARTOGRAPH_GITHUB_USER", "").strip()


def _discover_repos() -> tuple[str, ...]:
    """Filesystem-derive the tracked-repo list.

    Any directory under ``workspace/`` that contains a ``.git`` entry is
    considered tracked. Falls back to the historical hardcoded list if
    the workspace dir is missing (e.g., a fresh clone before any fork
    bootstrap).
    """
    workspace = PROJECT_ROOT / "workspace"
    if not workspace.exists():
        return ("jax", "xla", "orbax", "tunix", "tokamax")
    found = []
    for child in sorted(workspace.iterdir()):
        if not child.is_dir():
            continue
        if (child / ".git").exists():
            found.append(child.name)
    if not found:
        return ("jax", "xla", "orbax", "tunix", "tokamax")
    return tuple(found)


REPOS: tuple[str, ...] = _discover_repos()
GUIDES_DIR = PROJECT_ROOT / "guides"
LEARN_DIR = PROJECT_ROOT / "learn"
WORKSPACE_DIR = PROJECT_ROOT / "workspace"
DRIFT_DIR = PROJECT_ROOT / ".drift-reports"
DIST_DIR = PROJECT_ROOT / "web" / "dist"
EPISODES_DIR = PROJECT_ROOT / "episodes"

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def _parse_frontmatter(text: str) -> dict[str, Any]:
    """Lift YAML frontmatter from a markdown file. Tolerant of malformed YAML."""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}
    block = m.group(1)
    if yaml is not None:
        try:
            data = yaml.safe_load(block) or {}
            return data if isinstance(data, dict) else {}
        except yaml.YAMLError:
            LOG.warning("frontmatter parse failed")
            return {}
    parsed: dict[str, Any] = {}
    for raw_line in block.splitlines():
        if ":" not in raw_line:
            continue
        key, _, value = raw_line.partition(":")
        parsed[key.strip()] = value.strip().strip('"\'')
    return parsed


def _read_frontmatter(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return _parse_frontmatter(path.read_text(encoding="utf-8"))
    except OSError as err:
        LOG.warning("read failed for %s: %s", path, err)
        return {}


def _git(repo_dir: Path, *args: str) -> str | None:
    if not repo_dir.exists():
        return None
    try:
        out = subprocess.run(
            ["git", "-C", str(repo_dir), *args],
            check=True,
            capture_output=True,
            text=True,
            timeout=8,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as err:
        LOG.debug("git %s failed in %s: %s", args, repo_dir, err)
        return None
    return out.stdout.strip()


@lru_cache(maxsize=8)
def _topics_count(repo: str) -> int:
    topics_dir = GUIDES_DIR / repo / "topics"
    if not topics_dir.exists():
        return 0
    return sum(1 for p in topics_dir.iterdir() if p.suffix == ".md")


@lru_cache(maxsize=8)
def _walkthroughs_count(repo: str) -> int:
    walk_dir = LEARN_DIR / "walkthroughs"
    if not walk_dir.exists():
        return 0
    count = 0
    for path in walk_dir.glob("*.md"):
        fm = _read_frontmatter(path)
        if fm.get("repo") == repo:
            count += 1
    return count


def _find_session_log(slug: str) -> Path | None:
    """Locate a session log by slug. Sessions live in YYYY-MM subdirs."""
    sessions = PROJECT_ROOT / "sessions"
    if not sessions.exists():
        return None
    for month_dir in sessions.iterdir():
        if not month_dir.is_dir():
            continue
        candidate = month_dir / f"{slug}.md"
        if candidate.exists():
            return candidate
    return None


def _drift_summary(repo: str, backfilled_sha: str | None) -> tuple[int, int]:
    """Return (drift_commits, drift_files) for a repo.

    Authoritative source: live `git rev-list` against the recorded backfill
    sha. The `.drift-reports/<repo>.md` file is a STALE artifact if the
    bedrock has been bumped since the report was written — we therefore
    compute fresh and clean up stale reports as a side effect.
    """
    if not backfilled_sha:
        # No bedrock sha tracked yet — fall back to the report if present.
        report_path = DRIFT_DIR / f"{repo}.md"
        if report_path.exists():
            text = report_path.read_text(encoding="utf-8", errors="replace")
            commits_match = re.search(r"(\d+)\s+commits?", text, re.IGNORECASE)
            files_match = re.search(r"(\d+)\s+files?\s+changed", text, re.IGNORECASE)
            if commits_match:
                return int(commits_match.group(1)), int(files_match.group(1)) if files_match else 0
        return 0, 0
    repo_dir = WORKSPACE_DIR / repo
    rev_list = _git(repo_dir, "rev-list", "--count", f"{backfilled_sha}..upstream/main")
    if rev_list is None or not rev_list.isdigit():
        return 0, 0
    commits = int(rev_list)

    # Self-heal: if bedrock matches upstream but a stale report file exists,
    # remove it. This avoids the UI showing drift counts that no longer
    # reflect reality (which happens whenever bedrock is updated outside the
    # drift-check.sh flow — e.g., by a backfill agent or human edit).
    report_path = DRIFT_DIR / f"{repo}.md"
    if commits == 0 and report_path.exists():
        try:
            report_path.unlink()
            LOG.info("removed stale drift report for %s (bedrock now matches upstream)", repo)
        except OSError:
            pass

    if commits == 0:
        return 0, 0
    diff = _git(
        repo_dir,
        "diff",
        "--name-only",
        f"{backfilled_sha}..upstream/main",
    )
    files = len(diff.splitlines()) if diff else 0
    return commits, files


def _backfill_state(repo: str) -> dict[str, Any]:
    """Read .backfill-log/<repo>.state.json — the live backfill job state.

    backfill-bedrock.sh writes this file (running → done/error) so the job
    is observable whether it was started from the UI or the CLI. A 'running'
    state whose process is gone is reconciled to 'error' (crashed/killed).
    """
    state_file = PROJECT_ROOT / ".backfill-log" / f"{repo}.state.json"
    if not state_file.exists():
        return {"state": "idle"}
    try:
        st: dict[str, Any] = json.loads(state_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"state": "idle"}
    if st.get("state") == "running":
        pid = st.get("pid")
        alive = False
        if isinstance(pid, int):
            try:
                os.kill(pid, 0)
                alive = True
            except ProcessLookupError:
                alive = False
            except PermissionError:
                alive = True  # exists, owned by another user
        if not alive:
            st["state"] = "error"
            st["note"] = "backfill process is no longer running (crashed or killed)"
    return st


# Orchestration state for the sequential backfill-all run. Per-repo job
# state stays file-based (backfill-bedrock.sh owns .backfill-log/*.state.json);
# this only tracks the run-everything sequence itself.
_backfill_all_lock = threading.Lock()
_backfill_all_state: dict[str, Any] = {"state": "idle", "current": None, "repos": {}}


def _backfill_all_worker(repos: tuple[str, ...]) -> None:
    """Run backfill-bedrock.sh for each repo in turn, recording progress.

    Sequential on purpose — each backfill is a ``claude -p`` run, and
    parallel runs contend for token rate limits and the git index.
    """
    script = PROJECT_ROOT / "scripts" / "backfill-bedrock.sh"
    for repo in repos:
        if _backfill_state(repo).get("state") == "running":
            with _backfill_all_lock:
                _backfill_all_state["repos"][repo] = "skipped (already running)"
            continue
        with _backfill_all_lock:
            _backfill_all_state["current"] = repo
            _backfill_all_state["repos"][repo] = "running"
        try:
            result = subprocess.run(  # noqa: S603
                ["bash", str(script), repo],
                cwd=str(PROJECT_ROOT),
                capture_output=True,
                timeout=3600,
            )
            outcome = "done" if result.returncode == 0 else f"error (exit {result.returncode})"
        except (subprocess.TimeoutExpired, OSError) as exc:
            LOG.warning("backfill-all: %s failed: %s", repo, exc)
            outcome = f"error ({exc.__class__.__name__})"
        with _backfill_all_lock:
            _backfill_all_state["repos"][repo] = outcome
    with _backfill_all_lock:
        _backfill_all_state["state"] = "done"
        _backfill_all_state["current"] = None
        _backfill_all_state["finished_at"] = datetime.now(tz=timezone.utc).isoformat()


def _rebuild_site() -> bool:
    """Rebuild the static Astro site so a content mutation shows up.

    The site is a static build — moving or editing a content file does
    nothing visible until ``web/dist/`` is regenerated. Returns True on a
    clean build.
    """
    web = PROJECT_ROOT / "web"
    if not (web / "package.json").exists():
        return False
    try:
        r = subprocess.run(  # noqa: S603, S607
            ["npm", "run", "build"],
            cwd=str(web),
            capture_output=True,
            text=True,
            timeout=300,
        )
        if r.returncode != 0:
            LOG.warning("site rebuild failed: %s", r.stderr[-500:])
        return r.returncode == 0
    except (subprocess.SubprocessError, OSError) as exc:
        LOG.warning("site rebuild errored: %s", exc)
        return False


_rebuild_lock = threading.Lock()
_rebuild_running = False
_rebuild_pending = False

# Minimum seconds between the END of one build and the START of the next.
# A burst of content mutations — e.g. the auto-promote fold cascade touching
# dozens of bedrock files — would otherwise drive back-to-back `npm run build`
# runs that peg the CPU. The cooldown coalesces every request that lands in
# the window into a single build. An isolated edit after an idle period still
# rebuilds immediately (the elapsed time already exceeds the interval).
# Tune via CARTOGRAPH_BUILD_MIN_INTERVAL (seconds); 0 disables the throttle.
_REBUILD_MIN_INTERVAL = max(0.0, float(os.environ.get("CARTOGRAPH_BUILD_MIN_INTERVAL", "300")))
_last_rebuild_finish = 0.0  # time.monotonic() when the last build completed


def _rebuild_worker() -> None:
    global _rebuild_running, _rebuild_pending, _last_rebuild_finish
    while True:
        # Throttle: wait out the cooldown since the last build finished,
        # coalescing every request that lands during the wait into this one
        # build. Idle-then-edit pays no wait; a storm collapses to one build
        # per interval instead of pegging the CPU with back-to-back builds.
        wait = _REBUILD_MIN_INTERVAL - (time.monotonic() - _last_rebuild_finish)
        if wait > 0:
            time.sleep(wait)
        # Clear pending BEFORE building so a mutation that lands mid-build
        # re-arms pending and triggers a follow-up build — no lost changes.
        with _rebuild_lock:
            _rebuild_pending = False
        _rebuild_site()
        _last_rebuild_finish = time.monotonic()
        with _rebuild_lock:
            if not _rebuild_pending:
                _rebuild_running = False
                return
            # else: a request arrived during the build — loop; the cooldown
            # at the top throttles the next run.


_CONTENT_DIRS = ("guides", "episodes", "research", "papers", "research_papers", "learn", "setups", "designs", "proposals")

# Folders the auto-commit loop watches. Anything that lands under these
# paths is staged + committed + pushed after a quiet period, so authored
# content never sits local while the served pages go stale. designs/ and
# setups/ commit per deliverable sub-folder; every other dir bundles its
# whole tree into one commit. This covers the dirs whose commits would
# otherwise depend on a clean Stop hook firing (sessions/, diary/) or a
# per-action flow (guides/, episodes/, research/, papers/, learn/) — the
# loop now guarantees all of them land even when neither fires.
_AUTO_COMMIT_DIRS = (
    "designs",
    "setups",
    "sessions",
    "diary",
    "guides",
    "episodes",
    "research",
    "papers",
    "research_papers",
    "learn",
    "proposals",
)

# Of the watched dirs, these bundle their whole tree into a single commit
# (one batch of files → one commit). designs/ and setups/ are the exception:
# they commit per deliverable sub-folder (see _auto_commit_group_key).
_AUTO_COMMIT_BUNDLE_DIRS = frozenset(
    {"sessions", "diary", "guides", "episodes", "research", "papers", "research_papers", "learn", "proposals"}
)

# Commit message per bundled dir; falls back to a generic message otherwise.
_BUNDLE_COMMIT_MESSAGES = {
    "sessions": "content: session logs",
    "diary": "content: diary entries",
    "guides": "content: guide updates",
    "episodes": "content: episode notes",
    "research": "content: research notes",
    "papers": "content: paper notes",
    "research_papers": "content: research-paper notes",
    "learn": "content: learn updates",
    "proposals": "content: proposal notes",
}

# How long the auto-commit loop waits after the newest modification in a
# group before committing it. Long enough that a save-edit-save loop
# collapses into one commit; short enough that a finished change lands
# promptly.
_AUTO_COMMIT_QUIET_SECONDS = 30
_AUTO_COMMIT_INTERVAL_SECONDS = 20

# Batched-curation drain. The SessionStart/Stop hooks now ENQUEUE curation work
# (fold/promote/episode/research) under .cartograph/curation-queue/ instead of
# spawning a `claude -p` agent per item. This loop drains the whole queue with
# ONE headless agent at most once per interval — the debounced, single-flight
# replacement for the per-item fan-out that swarmed the machine. Tune via
# CARTOGRAPH_CURATE_INTERVAL (seconds); the floor is 60s.
_CURATE_INTERVAL_SECONDS = max(60.0, float(os.environ.get("CARTOGRAPH_CURATE_INTERVAL", "1800")))


def _content_fingerprint() -> tuple[int, float]:
    """(file count, newest mtime) across the content dirs — a cheap probe
    for 'has any content changed'."""
    count = 0
    newest = 0.0
    for d in _CONTENT_DIRS:
        base = PROJECT_ROOT / d
        if not base.exists():
            continue
        for p in base.rglob("*"):
            try:
                if p.is_file():
                    count += 1
                    m = p.stat().st_mtime
                    if m > newest:
                        newest = m
            except OSError:
                continue
    return count, newest


def _content_watch_loop() -> None:
    """Rebuild the site whenever content changes by ANY route — an API
    mutation, a background script, a plain `git commit`, a hand edit.

    The endpoints and scripts also call _request_rebuild() directly (a
    faster path); this loop is the catch-all that guarantees a rebuild
    even for routes nothing else watches — notably a manual commit.
    """
    last = _content_fingerprint()
    while True:
        time.sleep(12)
        try:
            cur = _content_fingerprint()
        except Exception:  # noqa: BLE001 — a watch loop must never die
            continue
        if cur != last:
            last = cur
            LOG.info("content change detected — requesting rebuild")
            # Content moved → the cached /api/status stats are stale; drop
            # them now instead of waiting out the 30 s TTL.
            _status_payload.cache_clear()  # type: ignore[attr-defined]
            _request_rebuild()


def _git_porcelain(pathspecs: list[str]) -> list[tuple[str, str]]:
    """Return ``[(status, path), …]`` for ``git status --porcelain`` on the
    given pathspecs. Respects ``.gitignore`` the same way git does.

    Renames are flattened to the destination path; that is fine for the
    auto-commit loop because designs and setups are added or modified, not
    renamed mid-flight in practice.
    """
    try:
        r = subprocess.run(  # noqa: S603, S607
            ["git", "status", "--porcelain=v1", "--", *pathspecs],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (subprocess.SubprocessError, OSError):
        return []
    if r.returncode != 0:
        return []
    out: list[tuple[str, str]] = []
    for line in r.stdout.splitlines():
        if len(line) < 4:
            continue
        xy = line[:2]
        rest = line[3:]
        if " -> " in rest:
            rest = rest.split(" -> ", 1)[1]
        # Git quotes paths with special chars — strip the surrounding quotes.
        # Paths containing escapes will round-trip safely through `git add`
        # because we hand them straight back to git, which decodes them.
        if rest.startswith('"') and rest.endswith('"'):
            rest = rest[1:-1]
        out.append((xy, rest.strip()))
    return out


def _auto_commit_group_key(path: str) -> str | None:
    """Map a repo-relative content path to its auto-commit group.

    ``designs/<repo>/<slug>/<...>``  → ``designs/<repo>/<slug>``
    ``setups/<repo>/<...>``          → ``setups/<repo>``
    ``guides/<...>``, ``episodes/<...>``, ``sessions/<...>``, …
                                     → the top-level dir (whole dir, one commit)

    Returns ``None`` for paths outside the watched dirs.
    """
    parts = path.split("/")
    if not parts:
        return None
    if parts[0] == "designs" and len(parts) >= 3:
        return "/".join(parts[:3])
    if parts[0] == "setups" and len(parts) >= 2:
        return "/".join(parts[:2])
    # Bundle everything under the dir into one group so a batch of new files
    # collapses to a single commit, not one per file.
    if parts[0] in _AUTO_COMMIT_BUNDLE_DIRS and len(parts) >= 2:
        return parts[0]
    return None


def _max_mtime(paths: list[str]) -> float:
    """Newest mtime across the given repo-relative paths. Missing files (a
    deletion) contribute 0, which means they don't hold a group back.
    """
    newest = 0.0
    for p in paths:
        ap = PROJECT_ROOT / p
        try:
            m = ap.stat().st_mtime
            if m > newest:
                newest = m
        except OSError:
            continue
    return newest


def _auto_commit_group(group: str, paths: list[str]) -> bool:
    """Commit + push the changed paths for one auto-commit group.

    Returns ``True`` on a successful commit + push. The message is derived
    from the group path, e.g.::

        designs/orbax/safetensors-to-orbax-converter
            → "content(design): update orbax/safetensors-to-orbax-converter"
        setups/orbax
            → "content(setup): update orbax"
        episodes  → "content: episode notes"
        guides    → "content: guide updates"
    """
    if group.startswith("designs/"):
        sub = group[len("designs/"):]
        msg = f"content(design): update {sub}"
    elif group.startswith("setups/"):
        sub = group[len("setups/"):]
        msg = f"content(setup): update {sub}"
    else:
        msg = _BUNDLE_COMMIT_MESSAGES.get(group, f"content: update {group}")
    return _git_publish(paths, msg)


def _auto_commit_loop() -> None:
    """Periodically commit + push watched-dir changes after a quiet period.

    Polls ``git status`` for the watched dirs (designs/setups per deliverable
    sub-folder, every other dir bundled per dir), and commits each group whose
    newest file has been quiet for at least ``_AUTO_COMMIT_QUIET_SECONDS``. The
    quiet-period check lets a save-edit-save loop collapse into one commit
    — a half-written edit won't get pushed mid-keystroke.

    A successful commit changes the content fingerprint, which kicks the
    rebuild loop naturally, so the page reflects the new state.

    Best-effort: any error is logged and swallowed; this loop must never die.
    """
    pathspecs = [f"{d}/" for d in _AUTO_COMMIT_DIRS]
    while True:
        time.sleep(_AUTO_COMMIT_INTERVAL_SECONDS)
        try:
            entries = _git_porcelain(pathspecs)
        except Exception:  # noqa: BLE001 — watch loop must never die
            continue
        if not entries:
            continue
        groups: dict[str, list[str]] = {}
        for _status, path in entries:
            key = _auto_commit_group_key(path)
            if key is None:
                continue
            groups.setdefault(key, []).append(path)
        if not groups:
            continue
        now = time.time()
        for group, paths in sorted(groups.items()):
            newest = _max_mtime(paths)
            # Pure-deletion groups have newest == 0; commit immediately.
            if newest > 0 and (now - newest) < _AUTO_COMMIT_QUIET_SECONDS:
                continue
            try:
                ok = _auto_commit_group(group, paths)
            except Exception as exc:  # noqa: BLE001
                LOG.warning("auto-commit: %s raised %s", group, exc)
                continue
            if ok:
                LOG.info(
                    "auto-commit: pushed %s (%d path%s)",
                    group,
                    len(paths),
                    "" if len(paths) == 1 else "s",
                )


def _drain_curation_queue() -> dict[str, Any]:
    """Run one batched curation drain. Best-effort, never raises.

    Delegates to scripts/curate.sh, which hands the whole pending queue to a
    single headless agent under the global cap (and is a no-op when the queue is
    empty or an agent is already running). Returns a small status dict.
    """
    script = PROJECT_ROOT / "scripts" / "curate.sh"
    try:
        pending_before = subprocess.run(  # noqa: S603
            ["bash", str(script), "count"],
            cwd=str(PROJECT_ROOT), capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        r = subprocess.run(  # noqa: S603
            ["bash", str(script), "drain"],
            cwd=str(PROJECT_ROOT), capture_output=True, text=True, timeout=1800,
        )
        return {
            "ok": r.returncode == 0,
            "queued_before": pending_before,
            "detail": (r.stderr or r.stdout)[-500:],
        }
    except Exception as exc:  # noqa: BLE001 — drain must never crash a caller/loop
        LOG.warning("curate drain: %s", exc)
        return {"ok": False, "detail": str(exc)}


def _curate_loop() -> None:
    """Periodically drain the curation queue with one batched agent.

    The debounced, single-flight replacement for the old per-item spawn fan-out:
    at most one headless agent per _CURATE_INTERVAL_SECONDS, and only when there
    is queued work. Never dies.
    """
    while True:
        time.sleep(_CURATE_INTERVAL_SECONDS)
        try:
            count = subprocess.run(  # noqa: S603
                ["bash", str(PROJECT_ROOT / "scripts" / "curate.sh"), "count"],
                cwd=str(PROJECT_ROOT), capture_output=True, text=True, timeout=10,
            ).stdout.strip()
            if count and count != "0":
                LOG.info("curate: %s task(s) queued — draining with one agent", count)
                _drain_curation_queue()
        except Exception as exc:  # noqa: BLE001 — loop must never die
            LOG.warning("curate loop: %s", exc)


def _request_rebuild() -> None:
    """Request a static-site rebuild without blocking the caller.

    Every content mutation (promote, fold, review, mark-trivial, new
    research/episode) leaves ``web/dist/`` stale. This schedules a rebuild
    on a background thread so the endpoint returns at once. Coalesced and
    throttled: a burst of mutations collapses to at most one in-flight build
    plus one queued, and the worker holds off until CARTOGRAPH_BUILD_MIN_INTERVAL
    has elapsed since the last build (see _rebuild_worker), so a fold storm
    can't drive back-to-back builds.
    """
    global _rebuild_running, _rebuild_pending
    with _rebuild_lock:
        if _rebuild_running:
            _rebuild_pending = True
            return
        _rebuild_running = True
    threading.Thread(target=_rebuild_worker, daemon=True).start()


def _clear_stale_git_lock() -> None:
    """Remove a crashed git's orphaned ``.git/index.lock`` so the auto-commit
    loop self-heals instead of wedging for hours.

    Telling a STALE lock from a LIVE one: a live lock is held *open* by the git
    process that created it; a stale lock (the process crashed mid-write) has no
    holder. ``lsof`` reads exactly that. We remove the lock only when BOTH hold:

      - no process currently has the file open (``lsof`` returns nothing), and
      - it is older than a short grace window (so we never race a git that just
        grabbed it).

    This is what git's own "a git process may have crashed ... remove the file
    manually" message describes — done automatically and conservatively. (A real
    case: a crashed subprocess left a 0-byte lock that blocked every commit for
    ~51 minutes before anyone noticed.)
    """
    lock = PROJECT_ROOT / ".git" / "index.lock"
    try:
        age = time.time() - lock.stat().st_mtime
    except OSError:
        return  # no lock present
    try:
        held = subprocess.run(  # noqa: S603, S607
            ["lsof", "-t", "--", str(lock)],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if held.stdout.strip():
            return  # a live process owns it — leave it alone
    except FileNotFoundError:
        pass  # lsof unavailable — fall back to the age guard alone
    except subprocess.SubprocessError:
        return  # can't determine the holder — be conservative
    if age < 30:
        return  # too fresh to be certain it's orphaned
    try:
        lock.unlink()
        LOG.warning(
            "removed stale .git/index.lock (no holder, age %.0fs) — a git "
            "process had crashed and orphaned it",
            age,
        )
    except OSError:
        pass


def _git_publish(paths: list[str], message: str) -> bool:
    """Commit the given repo-relative paths and push to origin/main.

    Pathspec form — stages and commits ONLY these paths, so a concurrent
    edit elsewhere in the tree is never swept in. Best-effort: returns
    False instead of raising if there is nothing to commit or the push
    fails, so the caller's primary action still succeeds.
    """
    root = str(PROJECT_ROOT)
    try:
        _clear_stale_git_lock()
        subprocess.run(  # noqa: S603, S607
            ["git", "add", "--", *paths], cwd=root, timeout=20, check=False
        )
        commit = subprocess.run(  # noqa: S603, S607
            ["git", "commit", "-q", "-m", message, "--", *paths],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=20,
        )
        if commit.returncode != 0:
            return False
        push = subprocess.run(  # noqa: S603, S607
            ["git", "push", "origin", "main"],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if push.returncode != 0:
            subprocess.run(  # noqa: S603, S607
                ["git", "pull", "--rebase", "origin", "main"],
                cwd=root,
                timeout=90,
                check=False,
            )
            push = subprocess.run(  # noqa: S603, S607
                ["git", "push", "origin", "main"],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=60,
            )
        return push.returncode == 0
    except (subprocess.SubprocessError, OSError) as exc:
        LOG.warning("git publish failed: %s", exc)
        return False


def _spawn_revise_rejected(rel_path: str) -> bool:
    """Spawn the revise-rejected agent (detached) for a just-rejected file.

    ``claude -p`` reads the rejection note, researches the problem, fixes
    the content, and resets it to pending re-review. Returns False if the
    script is missing so the caller can fall back to a plain rejection.
    """
    script = PROJECT_ROOT / "scripts" / "revise-rejected.sh"
    if not script.exists():
        return False
    try:
        subprocess.run(  # noqa: S603, S607
            ["bash", "-c", f'nohup bash "{script}" "{rel_path}" >/dev/null 2>&1 &'],
            cwd=str(PROJECT_ROOT),
            timeout=10,
        )
        return True
    except (subprocess.SubprocessError, OSError) as exc:
        LOG.warning("revise-rejected spawn failed: %s", exc)
        return False


def _repo_status(repo: str) -> dict[str, Any]:
    bedrock_fm = _read_frontmatter(GUIDES_DIR / repo / "overview.md")
    backfilled = bedrock_fm.get("backfilled_from_sha")
    repo_dir = WORKSPACE_DIR / repo

    upstream_sha = _git(repo_dir, "rev-parse", "--short", "upstream/main")
    last_fetch_at = _git(repo_dir, "log", "-1", "--format=%cI", "upstream/main")
    drift_commits, drift_files = _drift_summary(repo, backfilled)

    return {
        "name": repo,
        "tracked_branch": "main",
        "upstream_sha": upstream_sha,
        "backfilled_from_sha": backfilled,
        "drift_commits": drift_commits,
        "drift_files": drift_files,
        "last_fetch_at": last_fetch_at,
        "topics_count": _topics_count(repo),
        "walkthroughs_count": _walkthroughs_count(repo),
    }


def _doctor() -> dict[str, Any]:
    problems: list[str] = []
    warnings: list[str] = []
    for repo in REPOS:
        repo_dir = WORKSPACE_DIR / repo
        if not repo_dir.exists():
            warnings.append(f"workspace/{repo}/ missing — fork not cloned")
            continue
        if _git(repo_dir, "rev-parse", "--verify", "upstream/main") is None:
            problems.append(f"workspace/{repo}/: upstream/main ref missing")
        bedrock = GUIDES_DIR / repo / "overview.md"
        if not bedrock.exists():
            warnings.append(f"guides/{repo}/overview.md missing")
    return {
        "status": "OK" if not problems else "FAIL",
        "problems": problems,
        "warnings": warnings,
    }


def _github_health() -> dict[str, Any]:
    """Probe GitHub reachability + auth the same way the PR endpoints do.

    Runs a short ``gh api user`` — this is the exact failure surface behind a
    silently-degraded server (e.g. a process trapped in a network sandbox can
    serve localhost fine but every ``gh`` child is blocked from the API).
    """
    configured = _cartograph_user()
    base: dict[str, Any] = {
        "reachable": False,
        "configured_user": configured,
        "authed_user": None,
        "user_mismatch": False,
        "error": None,
    }
    try:
        r = subprocess.run(  # noqa: S603
            ["gh", "api", "user", "--jq", ".login"],  # noqa: S607
            capture_output=True, text=True, timeout=10,
        )
    except FileNotFoundError:
        return {**base, "error": "gh CLI not found on PATH"}
    except subprocess.TimeoutExpired:
        return {**base, "error": "gh api user timed out (10s)"}
    if r.returncode != 0:
        return {**base, "error": (r.stderr.strip() or f"gh exited {r.returncode}")[:300]}
    authed = r.stdout.strip()
    return {
        "reachable": True,
        "configured_user": configured,
        "authed_user": authed,
        "user_mismatch": bool(configured and authed and configured != authed),
        "error": None,
    }


def _global_stats() -> dict[str, int]:
    topics_total = sum(_topics_count(r) for r in REPOS)
    walkthroughs_total = sum(1 for _ in (LEARN_DIR / "walkthroughs").glob("*.md")) if (LEARN_DIR / "walkthroughs").exists() else 0
    ramp_ups_total = sum(1 for p in (LEARN_DIR / "ramp-up").glob("*.md") if p.name != "README.md") if (LEARN_DIR / "ramp-up").exists() else 0
    drafts_total = sum(1 for _ in (LEARN_DIR / "drafts").glob("*.md")) if (LEARN_DIR / "drafts").exists() else 0
    episodes_total = 0
    if EPISODES_DIR.exists():
        for month in EPISODES_DIR.iterdir():
            if month.is_dir():
                episodes_total += sum(1 for _ in month.glob("*.md"))
    return {
        "topics_total": topics_total,
        "walkthroughs_total": walkthroughs_total,
        "ramp_ups_total": ramp_ups_total,
        "drafts_total": drafts_total,
        "episodes_total": episodes_total,
    }


def _upstream_owner_repo(repo: str) -> str | None:
    """Parse upstream remote URL → ``owner/repo`` slug (used to link commits to GitHub).

    Cached per repo for the FastAPI process lifetime — the remote URL never
    changes during a server run.
    """
    cache = _upstream_owner_repo.__dict__.setdefault("_cache", {})
    if repo in cache:
        return cache[repo]
    repo_dir = WORKSPACE_DIR / repo
    url = _git(repo_dir, "remote", "get-url", "upstream") or ""
    url = url.strip()
    owner_repo: str | None = None
    # Accept git@host:owner/repo[.git] and https://host/owner/repo[.git]
    m = re.search(r"[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?$", url)
    if m:
        owner_repo = f"{m.group(1)}/{m.group(2)}"
    cache[repo] = owner_repo
    return owner_repo


@_ttl_cache(30.0)
def _activity(limit: int = 50) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for repo in REPOS:
        repo_dir = WORKSPACE_DIR / repo
        log = _git(
            repo_dir,
            "log",
            "-n",
            "20",
            "--format=%h|%an|%cI|%s",
            "upstream/main",
        )
        if not log:
            continue
        owner_repo = _upstream_owner_repo(repo) or ""
        for line in log.splitlines():
            parts = line.split("|", 3)
            if len(parts) != 4:
                continue
            sha, author, date_iso, msg = parts
            rows.append({
                "repo": repo,
                "sha": sha,
                "author": author,
                "date_iso": date_iso,
                "msg": msg,
                "upstream_owner_repo": owner_repo,
            })
    rows.sort(key=lambda c: c["date_iso"], reverse=True)
    return rows[:limit]


@_ttl_cache(30.0)
def _status_payload() -> dict[str, Any]:
    """The /api/status response body — TTL-cached because the home page
    polls it and each compute walks git + frontmatter for every repo.
    The content-watch loop clears the cache early when content changes."""
    return {
        "repos": {r: _repo_status(r) for r in REPOS},
        "doctor": _doctor(),
        "stats": _global_stats(),
        "fetched_at": datetime.now(tz=timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Audit endpoint — writes ``reviewed_by_human`` / ``review_notes`` into the
# YAML frontmatter of a topic note. The only mutating path in the server.
# ---------------------------------------------------------------------------

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


def _resolve_topic_path(repo: str, topic: str) -> Path:
    """Resolve ``guides/<repo>/topics/<topic>.md`` after validating both
    components. Raises ``HTTPException(400)`` on any escape attempt and
    ``HTTPException(404)`` if the file does not exist or is outside the
    expected directory.
    """
    if repo not in REPOS:
        raise HTTPException(status_code=400, detail=f"unknown repo: {repo}")
    if ".." in topic or "/" in topic or topic.startswith("."):
        raise HTTPException(status_code=400, detail="invalid topic slug")
    if not _SLUG_RE.match(topic):
        raise HTTPException(status_code=400, detail="topic slug must be [a-z0-9._-]")

    topics_dir = (GUIDES_DIR / repo / "topics").resolve()
    path = (topics_dir / f"{topic}.md").resolve()
    # Defence-in-depth: the resolved path must live under topics_dir.
    try:
        path.relative_to(topics_dir)
    except ValueError as err:
        raise HTTPException(status_code=400, detail="path escapes topics dir") from err
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail=f"topic not found: {repo}/{topic}")
    return path


def _yaml_quote(value: Any) -> str:
    """Render a scalar for inline YAML.

    Strings get quoted only when they contain characters that would break
    the parser; bool/int/None are written as their canonical YAML forms.
    The reject-flow passes ``rejected: True`` through here — without the
    non-string branches we hit ``TypeError: argument of type 'bool' is
    not iterable`` from the substring check.
    """
    if value is None:
        return "~"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if not isinstance(value, str):
        value = str(value)
    if value == "":
        return "~"
    needs_quote = any(c in value for c in ":#\"'\n\r[]{},&*!|>%@`") or value.strip() != value
    if not needs_quote:
        return value
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _fm_set_or_remove(path: Path, updates: "dict[str, Any]") -> None:
    """Update (or remove, when value is ``None``) the listed frontmatter
    fields on ``path``. Values may be str / bool / int — _yaml_quote
    renders each. Preserves the existing field order; new fields are
    appended just before the closing ``---``.
    """
    text = path.read_text(encoding="utf-8")
    m = _FRONTMATTER_RE.match(text)
    if not m:
        raise HTTPException(
            status_code=409,
            detail=f"no frontmatter block in {path.name}",
        )
    block = m.group(1)
    body = text[m.end():]

    lines = block.splitlines()
    remaining: dict[str, Any] = dict(updates)
    new_lines: list[str] = []
    for raw_line in lines:
        if ":" not in raw_line:
            new_lines.append(raw_line)
            continue
        key = raw_line.split(":", 1)[0].strip()
        if key in remaining:
            value = remaining.pop(key)
            if value is None:
                # Drop the line entirely.
                continue
            new_lines.append(f"{key}: {_yaml_quote(value)}")
        else:
            new_lines.append(raw_line)

    # Any keys that didn't already exist get appended (skip removes).
    for key, value in remaining.items():
        if value is None:
            continue
        new_lines.append(f"{key}: {_yaml_quote(value)}")

    new_block = "\n".join(new_lines)
    path.write_text(f"---\n{new_block}\n---\n{body}", encoding="utf-8")


def _current_review_state(path: Path) -> dict[str, Any]:
    fm = _read_frontmatter(path)
    reviewed = fm.get("reviewed_by_human")
    notes = fm.get("review_notes")
    return {
        "reviewed_by_human": None if reviewed in (None, "", "~") else str(reviewed),
        "review_notes": None if notes in (None, "", "~") else str(notes),
    }


def create_app() -> FastAPI:
    app = FastAPI(
        title="cartograph",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
    )

    @app.get("/api/status")
    def status() -> dict[str, Any]:
        return _status_payload()

    @app.get("/api/drift/{repo}", response_class=PlainTextResponse)
    def drift(repo: str) -> str:
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        path = DRIFT_DIR / f"{repo}.md"
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"no drift report for {repo}")
        return path.read_text(encoding="utf-8")

    @app.get("/api/activity")
    def activity() -> dict[str, list[dict[str, str]]]:
        return {"commits": _activity()}

    @app.get("/api/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        """Server-process health: pid/uptime/runtime + GitHub connectivity + doctor.

        Distinct from ``/api/status`` (which is repo/content-centric) — this is
        about the running server itself, and powers the /settings page + the
        header health dot.
        """
        return {
            "ok": True,
            "server": {
                "pid": os.getpid(),
                "ppid": os.getppid(),
                "uptime_seconds": round(time.time() - _PROCESS_START, 1),
                "started_at": datetime.fromtimestamp(_PROCESS_START, tz=timezone.utc).isoformat(),
                "reload": os.environ.get("CARTOGRAPH_RELOAD", "1") != "0",
                "python": sys.executable,
                "cwd": str(Path.cwd()),
            },
            "github": _github_health(),
            "doctor": _doctor(),
        }

    @app.get("/api/errors")
    def errors_log(n: int = 50) -> dict[str, Any]:
        """Tail of ``.cartograph/errors.log`` — script-side failures.

        ``scripts/lib/errors.sh`` appends one line per failure as
        ``ISO8601<TAB>script<TAB>message``. Returns the last ``n`` entries
        (default 50, capped at 500), newest first; an empty list when the
        log doesn't exist yet.
        """
        n = max(1, min(n, 500))
        path = PROJECT_ROOT / ".cartograph" / "errors.log"
        if not path.is_file():
            return {"errors": [], "count": 0}
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"cannot read errors.log: {exc}") from exc
        entries: list[dict[str, str]] = []
        for line in reversed(lines):
            if not line.strip():
                continue
            parts = line.split("\t", 2)
            if len(parts) == 3:
                ts, script, message = parts
            else:
                # Malformed line — keep it visible rather than dropping it.
                ts, script, message = "", "", line
            entries.append({"ts": ts, "script": script, "message": message})
            if len(entries) >= n:
                break
        return {"errors": entries, "count": len(entries)}

    @app.get("/api/injection-cost")
    def injection_cost() -> dict[str, Any]:
        """Per-repo orientation-injection cost estimate.

        The UserPromptSubmit hook injects each repo's three bedrock guides
        plus ``guides/seams.md`` in full on every turn. This sums their
        char lengths and estimates tokens (chars // 4) so the UI can flag
        repos whose bedrock has outgrown the injection budget
        (``CARTOGRAPH_BEDROCK_TOKEN_BUDGET``, default 20000 tokens).
        """
        budget = int(os.environ.get("CARTOGRAPH_BEDROCK_TOKEN_BUDGET", "20000"))

        def _chars(path: Path) -> int:
            try:
                return len(path.read_text(encoding="utf-8")) if path.is_file() else 0
            except OSError:
                return 0

        seams_chars = _chars(GUIDES_DIR / "seams.md")
        repos: dict[str, Any] = {}
        any_warn = False
        for repo in REPOS:
            files: dict[str, int] = {}
            chars = 0
            for name in ("overview.md", "architecture.md", "conventions.md"):
                size = _chars(GUIDES_DIR / repo / name)
                files[name] = size // 4
                chars += size
            files["seams.md"] = seams_chars // 4
            chars += seams_chars
            est = chars // 4
            warn = est > budget
            any_warn = any_warn or warn
            repos[repo] = {
                "chars": chars,
                "est_tokens": est,
                "files": files,
                "budget_warn": warn,
            }
        return {"repos": repos, "budget_tokens": budget, "budget_warn": any_warn}

    @app.post("/api/server/restart")
    def restart_server() -> dict[str, Any]:
        """Relaunch the server via a detached helper, then return immediately.

        Spawns scripts/restart-server.sh in its own session so it survives the
        very process it is about to kill: the helper frees :47777 and re-execs
        serve.py with this interpreter. The client should poll /api/healthz to
        detect when the new process is up.

        CAVEAT: the relaunched process inherits this process's network context.
        If the server is trapped inside a network-restricted sandbox, a restart
        cannot escape it — restart from a terminal instead.
        """
        script = PROJECT_ROOT / "scripts" / "restart-server.sh"
        if not script.is_file():
            raise HTTPException(status_code=500, detail="scripts/restart-server.sh missing")
        log_dir = PROJECT_ROOT / ".cartograph" / "state"
        log_dir.mkdir(parents=True, exist_ok=True)
        log = (log_dir / "restart.log").open("ab")
        subprocess.Popen(  # noqa: S603
            ["bash", str(script), sys.executable],
            cwd=str(PROJECT_ROOT),
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        return {
            "ok": True,
            "restarting": True,
            "pid": os.getpid(),
            "hint": "poll /api/healthz; the server returns in a few seconds",
        }

    @app.get("/api/config")
    def get_config() -> dict[str, Any]:
        """Curated CARTOGRAPH_* settings: schema + current values.

        `value` is the cartograph.env value if set, else the live os.environ
        value (source=env), else the registry default (source=default).
        """
        file_vals = _read_config_file()
        keys_out: list[dict[str, Any]] = []
        for entry in CONFIG_SCHEMA:
            key = entry["key"]
            if key in file_vals:
                value, source = file_vals[key], "file"
            elif key in os.environ:
                value, source = os.environ[key], "env"
            else:
                value, source = entry.get("default", ""), "default"
            keys_out.append({**entry, "value": value, "source": source})
        groups: list[str] = []
        for entry in CONFIG_SCHEMA:
            if entry["group"] not in groups:
                groups.append(entry["group"])
        return {"groups": groups, "keys": keys_out, "config_path": "cartograph.env"}

    @app.post("/api/config")
    def post_config(body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:  # noqa: B008
        """Persist setting changes to cartograph.env.

        Body: ``{updates: {KEY: value}, removals: [KEY]}``. Writes are
        allow-listed against CONFIG_SCHEMA and type-validated; a single bad
        value rejects the whole request (400) and leaves the file untouched.
        """
        raw_updates = body.get("updates") or {}
        raw_removals = body.get("removals") or []
        if not isinstance(raw_updates, dict) or not isinstance(raw_removals, list):
            raise HTTPException(status_code=400, detail="updates must be an object, removals a list")
        by_key = {e["key"]: e for e in CONFIG_SCHEMA}
        editable = {k: e for k, e in by_key.items() if e["type"] != "readonly"}
        updates: dict[str, str] = {}
        for key, val in raw_updates.items():
            entry = editable.get(key)
            if entry is None:
                raise HTTPException(status_code=400, detail=f"unknown or read-only key: {key}")
            sval = "" if val is None else str(val).strip()
            err = _validate_config_value(entry, sval)
            if err:
                raise HTTPException(status_code=400, detail=f"{key}: {err}")
            updates[key] = sval
        removals: set[str] = set()
        for key in raw_removals:
            if key not in editable:
                raise HTTPException(status_code=400, detail=f"unknown or read-only key: {key}")
            removals.add(str(key))
        overlap = set(updates) & removals
        if overlap:
            raise HTTPException(status_code=400, detail=f"key in both updates and removals: {sorted(overlap)}")
        changed = _write_config_file(updates, removals)
        restart_required = any(by_key[k].get("applies") == "restart" for k in changed if k in by_key)
        return {"ok": True, "changed": changed, "restart_required": restart_required}

    @app.get("/api/topic/{repo}/{topic}/review")
    def get_review(repo: str, topic: str) -> dict[str, Any]:
        path = _resolve_topic_path(repo, topic)
        return {"ok": True, "state": _current_review_state(path)}

    @app.post("/api/topic/{repo}/{topic}/review")
    def post_review(
        repo: str,
        topic: str,
        body: dict[str, Any] = Body(default_factory=dict),  # noqa: B008
    ) -> dict[str, Any]:
        path = _resolve_topic_path(repo, topic)
        verdict = body.get("verdict")
        if verdict not in {"approve", "reject", "discard"}:
            raise HTTPException(
                status_code=400,
                detail="verdict must be 'approve', 'reject', or 'discard'",
            )
        rel = str(path.relative_to(PROJECT_ROOT))

        if verdict == "discard":
            # Hard delete — the topic note is gone for good.
            path.unlink(missing_ok=True)
            _git_publish([rel], f"chore: discard topic {repo}/{topic}")
            _request_rebuild()
            return {"ok": True, "state": "discarded", "note": f"deleted {rel}"}

        if verdict == "approve":
            today = datetime.now(tz=timezone.utc).date().isoformat()
            # Approving sets reviewed_by_human, clears any prior rejection,
            # and unblocks topic→bedrock auto-fold for this topic.
            _fm_set_or_remove(
                path,
                {
                    "reviewed_by_human": today,
                    "review_notes": None,
                    "rejected": None,
                },
            )
            _request_rebuild()
            return {
                "ok": True,
                "state": _current_review_state(path),
                "note": "approved.",
            }

        # reject — record the note, then hand it to the revise-rejected
        # agent: claude researches the note, fixes the content, and resets
        # it to pending re-review.
        # Accept either 'note' or 'notes'; the bulk-review front-ends sent
        # 'notes' for a while and the silent 400 meant rejected topics
        # never triggered revise-rejected.sh.
        note = body.get("note") or body.get("notes")
        if not isinstance(note, str) or not note.strip():
            raise HTTPException(
                status_code=400,
                detail="reject verdict requires a non-empty 'note'",
            )
        _fm_set_or_remove(
            path,
            {
                "reviewed_by_human": None,
                "review_notes": note.strip(),
                "rejected": True,
            },
        )
        revising = _spawn_revise_rejected(rel)
        _request_rebuild()
        return {
            "ok": True,
            "state": "revising" if revising else "rejected",
            "note": (
                "rejected — claude is revising it per your note; reload in a "
                "few minutes to re-review."
                if revising
                else "rejected (revise agent unavailable — fix manually)."
            ),
        }

    @app.post("/api/topic/{repo}/{topic}/touch")
    def touch_topic(repo: str, topic: str) -> dict[str, Any]:
        """Set ``last_revised: <today>`` in the topic's frontmatter — nothing else.

        Powers the stale-topic "touch" action: the human confirms a topic
        is still accurate without editing its content. Same repo/slug
        validation and traversal defences as the review endpoints (via
        ``_resolve_topic_path``).
        """
        path = _resolve_topic_path(repo, topic)
        today = datetime.now(tz=timezone.utc).date().isoformat()
        _fm_set_or_remove(path, {"last_revised": today})
        _request_rebuild()
        return {"ok": True, "last_revised": today}

    @app.post("/api/drift-check/{repo}")
    def drift_check_repo(repo: str) -> dict[str, Any]:
        """Re-run drift detection for a single repo (or all if repo=all).

        Shells out to ``scripts/drift-check.sh``. Returns whether a drift
        report file now exists.
        """
        if repo not in REPOS and repo != "all":
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        script = PROJECT_ROOT / "scripts" / "drift-check.sh"
        if not script.exists():
            raise HTTPException(
                status_code=500, detail="scripts/drift-check.sh missing",
            )
        args = ["bash", str(script)] + ([] if repo == "all" else [repo])
        try:
            result = subprocess.run(  # noqa: S603
                args, capture_output=True, text=True, timeout=60,
                cwd=str(PROJECT_ROOT),
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(
                status_code=504, detail="drift-check timed out",
            ) from None

        # Whether drift exists per repo now.
        if repo == "all":
            results = {
                r: (DRIFT_DIR / f"{r}.md").exists()
                for r in REPOS
            }
        else:
            results = {repo: (DRIFT_DIR / f"{repo}.md").exists()}

        _request_rebuild()
        return {
            "ok": result.returncode == 0,
            "exit_code": result.returncode,
            "drift_present": results,
            "stdout": result.stdout[-2000:],
            "stderr": result.stderr[-1000:],
        }

    @app.post("/api/auto-revise/{repo}")
    def auto_revise_repo(repo: str) -> dict[str, Any]:
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        drift_file = DRIFT_DIR / f"{repo}.md"
        if not drift_file.exists():
            return {
                "ok": True,
                "status": "no_drift",
                "message": f"no drift report for {repo}",
            }
        script = PROJECT_ROOT / "scripts" / "auto-revise.sh"
        if not script.exists():
            raise HTTPException(
                status_code=500,
                detail="scripts/auto-revise.sh missing",
            )
        try:
            result = subprocess.run(  # noqa: S603
                ["bash", str(script), repo],
                capture_output=True,
                text=True,
                timeout=300,
                cwd=str(PROJECT_ROOT),
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(
                status_code=504,
                detail="auto-revise timed out (5 min)",
            ) from None
        closed = not drift_file.exists()
        return {
            "ok": result.returncode == 0,
            "status": "closed" if closed else "still_open",
            "exit_code": result.returncode,
            "stdout": result.stdout[-4000:],
            "stderr": result.stderr[-2000:],
            "note": (
                "drift closed — review `git diff` and commit when ready"
                if closed
                else "auto-revise did not close drift; manual review needed"
            ),
        }

    @app.post("/api/auto-revise/all")
    def auto_revise_all() -> dict[str, Any]:
        if not DRIFT_DIR.exists():
            return {"ok": True, "results": {}, "message": "no drift reports"}
        repos_with_drift = sorted(
            f.stem for f in DRIFT_DIR.glob("*.md") if f.stem in REPOS
        )
        results: dict[str, Any] = {}
        for repo in repos_with_drift:
            results[repo] = auto_revise_repo(repo)
        closed = sum(1 for r in results.values() if r.get("status") == "closed")
        return {
            "ok": True,
            "summary": f"{closed}/{len(results)} drift reports closed",
            "results": results,
        }

    @app.get("/api/resolve-file/{repo}")
    def resolve_file(repo: str, path: str) -> dict[str, Any]:
        """Resolve a (possibly stale) cited path to a real file in the fork.

        Upstream moves files; hardcoded / cited paths rot. Given a path,
        return the actual on-disk repo-relative path:
          - exact match wins,
          - else glob by basename (non-test, shortest path preferred),
          - else ok=False so the caller can avoid opening an empty editor.
        """
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        if ".." in path.split("/") or path.startswith("/"):
            raise HTTPException(status_code=400, detail="invalid path")
        root = (WORKSPACE_DIR / repo).resolve()

        exact = (root / path).resolve()
        try:
            exact.relative_to(root)
        except ValueError:
            raise HTTPException(status_code=400, detail="path escapes repo root") from None
        if exact.is_file():
            return {"ok": True, "path": path, "exact": True, "candidates": [path]}

        basename = path.rsplit("/", 1)[-1]
        if not basename:
            return {"ok": False, "path": None, "candidates": []}
        skip = {".git", "node_modules", "bazel-out", "bazel-bin", "bazel-testlogs",
                "__pycache__", "build", "dist", ".tox"}
        hits: list[str] = []
        for p in root.rglob(basename):
            if not p.is_file():
                continue
            rel = p.relative_to(root)
            if any(part in skip for part in rel.parts):
                continue
            hits.append(str(rel))
        # Prefer non-test files, then the shortest path (closest to the root).
        hits.sort(key=lambda r: ("test" in r, r.count("/"), len(r)))
        return {
            "ok": bool(hits),
            "path": hits[0] if hits else None,
            "exact": False,
            "candidates": hits[:10],
        }

    @app.get("/api/tree/{repo}")
    def list_tree(
        repo: str,
        path: str = "",
        depth: int = 1,
    ) -> dict[str, Any]:
        """List a directory in a fork's working tree for the UI file browser.

        ``path`` is the dir relative to the fork root ("" for root).
        ``depth=1`` returns immediate children; higher is allowed (capped at 3).
        Skips .git, common build/cache dirs to keep the response sane.
        """
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        if ".." in path.split("/") or path.startswith("/"):
            raise HTTPException(status_code=400, detail="invalid path")
        root = (WORKSPACE_DIR / repo).resolve()
        target = (root / path).resolve() if path else root
        try:
            target.relative_to(root)
        except ValueError:
            raise HTTPException(status_code=400, detail="path escapes repo root") from None
        if not target.exists() or not target.is_dir():
            raise HTTPException(status_code=404, detail=f"not a directory: {path}")

        depth = max(1, min(depth, 3))
        IGNORE = {".git", "node_modules", ".venv", "__pycache__", "bazel-out", "bazel-bin", "bazel-testlogs", ".pytest_cache", "build", "dist", ".tox", ".mypy_cache", ".ruff_cache"}

        def walk(d: Path, remaining: int) -> list[dict[str, Any]]:
            entries: list[dict[str, Any]] = []
            try:
                children = sorted(d.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
            except (PermissionError, OSError):
                return entries
            for child in children:
                if child.name in IGNORE or child.name.startswith("."):
                    if child.name not in {".github", ".vscode"}:
                        continue
                node: dict[str, Any] = {
                    "name": child.name,
                    "path": str(child.relative_to(root)),
                    "type": "dir" if child.is_dir() else "file",
                }
                if child.is_file():
                    try:
                        node["size"] = child.stat().st_size
                    except OSError:
                        node["size"] = 0
                if child.is_dir() and remaining > 1:
                    node["children"] = walk(child, remaining - 1)
                entries.append(node)
            return entries

        return {
            "ok": True,
            "repo": repo,
            "path": path,
            "depth": depth,
            "entries": walk(target, depth),
        }

    @app.get("/api/grep/{repo}")
    def grep_in_repo(
        repo: str,
        q: str = "",
        max_results: int = 100,
    ) -> dict[str, Any]:
        """Text search within a fork. Uses `rg` if available, falls back to grep.

        Returns ``file:line:text`` matches. Capped at ``max_results`` (default 100).
        """
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        q = q.strip()
        if not q:
            raise HTTPException(status_code=400, detail="q is required")
        if len(q) < 2:
            raise HTTPException(status_code=400, detail="q must be ≥2 chars")
        max_results = max(1, min(max_results, 500))
        root = WORKSPACE_DIR / repo
        if not root.exists():
            raise HTTPException(status_code=404, detail=f"repo not cloned: {repo}")

        # Prefer ripgrep (much faster). Fall back to grep -r.
        rg = subprocess.run(  # noqa: S603
            ["which", "rg"], capture_output=True, text=True,
        )
        if rg.returncode == 0 and rg.stdout.strip():
            cmd = [
                "rg", "--no-heading", "--line-number", "--max-count", "20",
                "--max-filesize", "1M",
                "--glob", "!.git", "--glob", "!node_modules",
                "--glob", "!bazel-out", "--glob", "!bazel-bin",
                "--glob", "!**/__pycache__",
                "--", q, str(root),
            ]
        else:
            cmd = ["grep", "-rn", "--include=*", q, str(root)]
        try:
            result = subprocess.run(  # noqa: S603
                cmd, capture_output=True, text=True, timeout=15,
                cwd=str(root),
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="grep timed out") from None

        matches: list[dict[str, Any]] = []
        for line in result.stdout.splitlines()[:max_results]:
            # Format: <abs-path>:<line>:<text>  OR  <path>:<line>:<text>
            parts = line.split(":", 2)
            if len(parts) != 3:
                continue
            file_path, line_no_str, text = parts
            try:
                line_no = int(line_no_str)
            except ValueError:
                continue
            try:
                rel = str(Path(file_path).relative_to(root))
            except ValueError:
                rel = file_path
            matches.append({
                "file": rel,
                "line": line_no,
                "text": text[:300],
            })

        return {
            "ok": True,
            "repo": repo,
            "query": q,
            "match_count": len(matches),
            "matches": matches,
            "truncated": len(result.stdout.splitlines()) > max_results,
        }

    @app.get("/api/insights/{repo}")
    def file_insights(repo: str, file: str = "") -> dict[str, Any]:
        """Return Cartograph cross-references for a given file.

        Greps guides/<repo>/, learn/, and episodes/ for the file path. Returns
        matches as a structured list so the UI can render an "insights" pane.
        """
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        if not file:
            return {"ok": True, "repo": repo, "file": "", "matches": []}
        if ".." in file.split("/"):
            raise HTTPException(status_code=400, detail="invalid file")

        # Search just the bare filename + full relative path; people cite both.
        basename = Path(file).name
        patterns = [file]
        if basename != file:
            patterns.append(basename)

        # Locations to search.
        search_roots = [
            (GUIDES_DIR / repo, "guides"),
            (GUIDES_DIR, "seams"),  # we'll filter to seams.md below
            (LEARN_DIR / "walkthroughs", "walkthroughs"),
            (LEARN_DIR / "ramp-up", "ramp-up"),
            (EPISODES_DIR, "episodes"),
        ]
        matches: list[dict[str, Any]] = []
        seen: set[str] = set()
        for pattern in patterns:
            # Skip very short patterns to avoid noise.
            if len(pattern) < 4:
                continue
            for root, kind in search_roots:
                if not root.exists():
                    continue
                cmd = ["grep", "-rln", "--include=*.md", "-F", pattern, str(root)]
                try:
                    res = subprocess.run(  # noqa: S603
                        cmd, capture_output=True, text=True, timeout=5,
                    )
                except subprocess.TimeoutExpired:
                    continue
                for path_str in res.stdout.splitlines():
                    p = Path(path_str)
                    # Filter seams.md root match.
                    if kind == "seams" and p.name != "seams.md":
                        continue
                    try:
                        rel = str(p.relative_to(PROJECT_ROOT))
                    except ValueError:
                        continue
                    if rel in seen:
                        continue
                    seen.add(rel)
                    # Try to surface the line where the citation appears + neighbour.
                    try:
                        text = p.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        continue
                    snippets: list[str] = []
                    for i, line in enumerate(text.splitlines(), start=1):
                        if pattern in line:
                            snippets.append(f"L{i}: {line.strip()[:200]}")
                            if len(snippets) >= 3:
                                break
                    matches.append({
                        "kind": kind if kind != "seams" else "bedrock-seams",
                        "file": rel,
                        "snippets": snippets,
                    })
        # Sort by kind priority for the UI.
        order = {"guides": 0, "bedrock-seams": 1, "walkthroughs": 2, "ramp-up": 3, "episodes": 4}
        matches.sort(key=lambda m: (order.get(m["kind"], 99), m["file"]))
        return {
            "ok": True,
            "repo": repo,
            "file": file,
            "match_count": len(matches),
            "matches": matches,
        }

    @app.get("/api/code/{repo}/{file_path:path}")
    def read_code(repo: str, file_path: str) -> dict[str, Any]:
        """Read a single file from a fork's working tree for the UI code viewer.

        Validates the repo against REPOS and rejects any path traversal
        (``..``) or absolute paths. Refuses files over 2 MB or non-text
        encodings. Returns content + metadata; the UI does line numbering
        and (optional) highlighting client-side.
        """
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        if not file_path or ".." in file_path.split("/") or file_path.startswith("/"):
            raise HTTPException(status_code=400, detail="invalid path")
        root = (PROJECT_ROOT / "workspace" / repo).resolve()
        target = (root / file_path).resolve()
        # Defence-in-depth: target must stay under the fork's root.
        try:
            target.relative_to(root)
        except ValueError:
            raise HTTPException(status_code=400, detail="path escapes repo root") from None
        if not target.exists() or not target.is_file():
            raise HTTPException(status_code=404, detail=f"not found: {file_path}")
        size = target.stat().st_size
        if size > 2 * 1024 * 1024:
            raise HTTPException(status_code=413, detail=f"file too large ({size} bytes)")
        try:
            content = target.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(
                status_code=415,
                detail=f"binary or non-utf8 file: {exc}",
            ) from None
        return {
            "ok": True,
            "repo": repo,
            "path": file_path,
            "size": size,
            "lines": content.count("\n") + 1,
            "language": _infer_language(file_path),
            "content": content,
        }

    @app.get("/api/repos")
    def repos_list() -> dict[str, Any]:
        """The tracked-upstream repo list — single source of truth for
        the front-end so it doesn't hardcode the same names server-side."""
        return {"repos": list(REPOS)}

    # Weights for ranking — bedrock counts more than topic, topic more
    # than episode. This biases the most-cited list toward files that
    # the *durable* notes lean on, not the ones that happened to appear
    # in a transient session.
    _CITATION_WEIGHTS = {
        "bedrock": 3.0,
        "topic": 2.0,
        "seam": 2.0,
        "episode": 1.0,
        "learn": 1.0,
        "research": 1.5,
        "paper": 1.0,
    }

    def _note_belongs_to_repo(note_path: str, repo: str) -> bool:
        """A note is 'about' this repo if its path lives under the
        repo's guides/learn/research/papers/episodes tree. Episodes that
        don't have a repo-scoped path are filtered by frontmatter
        elsewhere; for ranking purposes the path heuristic is enough.
        """
        return (
            note_path.startswith(f"guides/{repo}/")
            or note_path.startswith(f"learn/walkthroughs/{repo}-")
            or note_path.startswith(f"learn/ramp-up/{repo}.md")
            or note_path.startswith(f"research/{repo}/")
            or note_path.startswith(f"papers/{repo}/")
            or note_path.startswith(f"setups/{repo}/")
            or note_path.startswith(f"designs/{repo}/")
        )

    @app.get("/api/discipline")
    def discipline_scorecard(limit: int = 5) -> dict[str, Any]:
        """Per-session discipline scorecard for the last N sessions.

        Counts per session:
          - edits             — Edit/Write/NotebookEdit tool calls
          - reads             — Read tool calls
          - whatknows_calls   — explicit /whatknows or /api/whatknows hits
          - workspace_reads   — Reads of workspace/<repo>/ files
          - cited_file_edits  — workspace Edits whose target appears in by-file.json
        Plus session-independent counters:
          - unblessed_auto_drafts — auto-draft episodes never reviewed
          - revisions_pending     — topics flagged by post-edit-topic-mark

        Makes the §1a + §4 discipline trend visible in the console.
        """
        sessions_dir = PROJECT_ROOT / "sessions"
        sessions: list[dict[str, Any]] = []
        if sessions_dir.is_dir():
            # Walk session logs newest-first across YYYY-MM subdirs.
            all_logs: list[Path] = []
            for month_dir in sorted(sessions_dir.glob("*"), reverse=True):
                if not month_dir.is_dir() or not re.match(r"^\d{4}-\d{2}$", month_dir.name):
                    continue
                all_logs.extend(sorted(month_dir.glob("*.md"), reverse=True))
                if len(all_logs) >= limit * 2:
                    break

            # Pre-load file index for cited-file-edit attribution.
            idx_path = PROJECT_ROOT / ".cartograph" / "index" / "by-file.json"
            cited_basenames: set[str] = set()
            if idx_path.is_file():
                try:
                    idx = json.loads(idx_path.read_text(encoding="utf-8"))
                    for key in (idx.get("by_file") or {}).keys():
                        cited_basenames.add(key.rsplit("/", 1)[-1])
                except (OSError, json.JSONDecodeError):
                    pass

            for log in all_logs[:limit]:
                try:
                    text = log.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                edits = 0
                reads = 0
                whatknows_calls = 0
                workspace_reads = 0
                cited_file_edits = 0
                for line in text.splitlines():
                    m = re.match(r"^- \d{2}:\d{2}:\d{2}\s+(Edit|Write|NotebookEdit|Read)\s+(.+)$", line)
                    if not m:
                        if "/whatknows " in line or "/api/whatknows" in line:
                            whatknows_calls += 1
                        continue
                    tool = m.group(1)
                    target = m.group(2).strip()
                    if tool == "Read":
                        reads += 1
                        if "/workspace/" in target:
                            workspace_reads += 1
                    else:
                        edits += 1
                        if cited_basenames and Path(target).name in cited_basenames:
                            cited_file_edits += 1
                sessions.append({
                    "slug": log.stem,
                    "date": log.stem[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", log.stem) else None,
                    "path": str(log.relative_to(PROJECT_ROOT)),
                    "edits": edits,
                    "reads": reads,
                    "workspace_reads": workspace_reads,
                    "cited_file_edits": cited_file_edits,
                    "whatknows_calls": whatknows_calls,
                })

        # Standing obligations independent of any one session.
        unblessed_auto_drafts = 0
        ep_dir = PROJECT_ROOT / "episodes"
        if ep_dir.is_dir():
            for ep in ep_dir.rglob("*.md"):
                try:
                    fm = _read_frontmatter(ep)
                except Exception:
                    continue
                if fm.get("auto_drafted") is True \
                        and not fm.get("reviewed_by_human") \
                        and fm.get("rejected") is not True:
                    unblessed_auto_drafts += 1

        revisions_pending = 0
        rev_path = PROJECT_ROOT / ".cartograph" / "state" / "topic-revisions-pending.json"
        if rev_path.is_file():
            try:
                revisions_pending = len(json.loads(rev_path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                pass

        return {
            "sessions": sessions,
            "standing": {
                "unblessed_auto_drafts": unblessed_auto_drafts,
                "revisions_pending": revisions_pending,
            },
        }

    @app.get("/api/topic-revisions-pending")
    def topic_revisions_pending() -> dict[str, Any]:
        """Topics whose cited workspace files have been edited since
        the topic's last_revised. Written by the
        PostToolUse:Edit|Write hook (scripts/post-edit-topic-mark.sh)
        and surfaced as the 4th kind on /api/queue + /console/review/.
        """
        path = PROJECT_ROOT / ".cartograph" / "state" / "topic-revisions-pending.json"
        if not path.is_file():
            return {"items": [], "total": 0}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"items": [], "total": 0}

        items: list[dict[str, Any]] = []
        for topic_path, info in data.items():
            # Resolve repo + slug from the topic path. Anything outside
            # guides/<repo>/topics/<slug>.md is ignored — defensive.
            m = re.match(r"^guides/([^/]+)/topics/([^/]+)\.md$", topic_path)
            if not m:
                continue
            repo, slug = m.group(1), m.group(2)
            # Skip if claude-fix already settled this revision in a job.
            # Reuse the same _settled_kind machinery the queue resolver
            # uses for anchor/drift, but for revision jobs we use
            # 'revision' as kind. Jobs that complete successfully wipe
            # their entry from this file via post-revision-clear (see
            # scripts/topic-revision-fix.sh below). For now: the
            # script's own clear-on-success is the source of truth, so
            # if the file still has the entry, it's still pending.
            items.append({
                "topic": topic_path,
                "repo": repo,
                "slug": slug,
                "cited_files": info.get("cited_files") or [],
                "first_edited_at": info.get("first_edited_at"),
                "last_edited_at": info.get("last_edited_at"),
                "edits_in_session": info.get("edits_in_session"),
                "session": info.get("session"),
            })
        items.sort(key=lambda it: (it["repo"], it["slug"]))
        return {"items": items, "total": len(items)}

    @app.post("/api/topic-revisions-pending/clear")
    def topic_revisions_clear(body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:  # noqa: B008
        """Remove a topic from the pending-revision list. Called by the
        topic-revision-fix script after a successful revision lands;
        also reachable from the UI as a manual 'dismiss' affordance for
        false positives (e.g. the edit was a comment-only change).
        """
        topic = (body.get("topic") or "").strip()
        if not topic:
            raise HTTPException(status_code=400, detail="topic required")
        path = PROJECT_ROOT / ".cartograph" / "state" / "topic-revisions-pending.json"
        if not path.is_file():
            return {"ok": True, "removed": False}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
        removed = topic in data
        data.pop(topic, None)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(path)
        return {"ok": True, "removed": removed, "remaining": len(data)}

    @app.get("/api/note")
    def note_meta(path: str) -> dict[str, Any]:
        """Return parsed frontmatter for a cartograph note at the given
        repo-relative path. Used by the cartograph VS Code extension to
        gate drift diagnostics on the citing note's last_revised.
        """
        if not path or ".." in path or path.startswith("/"):
            raise HTTPException(status_code=400, detail="invalid path")
        abs_path = (PROJECT_ROOT / path).resolve()
        if not str(abs_path).startswith(str(PROJECT_ROOT.resolve())):
            raise HTTPException(status_code=400, detail="path escapes cartograph root")
        if not abs_path.is_file():
            return {"ok": False, "path": path, "error": "not found"}
        return {"ok": True, "path": path, "data": _read_frontmatter(abs_path)}

    @app.get("/api/repo/{repo}/most-cited")
    def repo_most_cited(repo: str, limit: int = 12) -> dict[str, Any]:
        """Files most cited by notes about <repo>. Derived from the
        reverse file-index (.cartograph/index/by-file.json), so the list
        updates the moment a new bedrock or topic note lands — no
        hand-curated STARTER_FILES required.

        Scoring: sum of layer weights across citing notes (bedrock=3,
        topic=2, episode=1). Files cited only by episodes rank below
        files in durable notes.
        """
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        idx_path = PROJECT_ROOT / ".cartograph" / "index" / "by-file.json"
        if not idx_path.is_file():
            return {"ok": False, "repo": repo, "items": [], "note": "file index not built; run scripts/build-file-index.py"}
        try:
            idx = json.loads(idx_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"ok": False, "repo": repo, "items": []}

        by_file = idx.get("by_file") or {}
        # For each indexed file path/basename, accumulate score + layer
        # breakdown from citations whose note belongs to this repo.
        rows: list[dict[str, Any]] = []
        for cited_path, citations in by_file.items():
            score = 0.0
            layers: dict[str, int] = {}
            for c in citations:
                note = c.get("note") or ""
                if not _note_belongs_to_repo(note, repo):
                    continue
                layer = (c.get("layer") or "").lower()
                w = _CITATION_WEIGHTS.get(layer, 1.0)
                score += w
                layers[layer] = layers.get(layer, 0) + 1
            if score <= 0:
                continue
            rows.append({
                "path": cited_path,
                "score": round(score, 2),
                "citations": sum(layers.values()),
                "by_layer": layers,
            })
        rows.sort(key=lambda r: (-r["score"], -r["citations"], r["path"]))
        return {"ok": True, "repo": repo, "items": rows[:limit], "total_files_scored": len(rows)}

    @app.get("/api/prs/{repo}")
    def list_prs(repo: str) -> dict[str, Any]:
        """Open PRs from the configured GitHub user against the upstream repo.

        Uses ``gh pr list`` against the upstream remote (read-only). Returns
        a list of PRs the user has open against the upstream project.
        """
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        gh_user = _cartograph_user()
        if not gh_user:
            return {"ok": False, "prs": [], "error": "CARTOGRAPH_GITHUB_USER unset"}
        upstream_remote = subprocess.run(  # noqa: S603
            ["git", "-C", str(PROJECT_ROOT / "workspace" / repo),
             "remote", "get-url", "upstream"],
            capture_output=True, text=True, timeout=5,
        )
        if upstream_remote.returncode != 0:
            return {"ok": False, "prs": [], "error": "no upstream remote"}
        url = upstream_remote.stdout.strip()
        # git@<host>:<org>/<repo>.git → <org>/<repo>
        m = re.search(r":([^/]+/[^/]+?)(\.git)?$", url)
        if not m:
            return {"ok": False, "prs": [], "error": f"unparseable upstream: {url}"}
        upstream_slug = m.group(1)
        try:
            result = subprocess.run(  # noqa: S603
                ["gh", "pr", "list",
                 "--repo", upstream_slug,
                 "--author", gh_user,
                 "--state", "all",
                 "--limit", "20",
                 "--json", "number,title,state,isDraft,url,createdAt,updatedAt,headRefName,baseRefName,mergeable"],
                capture_output=True, text=True, timeout=15,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "prs": [], "error": "gh pr list timed out"}
        if result.returncode != 0:
            return {
                "ok": False,
                "prs": [],
                "error": result.stderr.strip()[:500] or f"gh exited {result.returncode}",
            }
        try:
            prs = json.loads(result.stdout) if result.stdout.strip() else []
        except json.JSONDecodeError:
            prs = []
        return {
            "ok": True,
            "upstream": upstream_slug,
            "author": gh_user,
            "prs": prs,
            "count": len(prs),
        }

    @app.post("/api/ask")
    def ask_claude(body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:  # noqa: B008
        """General-purpose Claude entry point.

        Accepts ``{kind, repo?, context?, prompt}`` and invokes ``claude -p``
        headless with a kind-specific framing. Used by AskClaude.tsx on
        repo dashboards (kind=explore), topic viewers (kind=review-topic),
        code viewer (kind=explain-code).
        """
        kind = body.get("kind", "general")
        repo = body.get("repo")
        context = body.get("context", "")
        prompt = body.get("prompt", "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="prompt is required")
        if repo is not None and repo not in REPOS:
            raise HTTPException(status_code=400, detail=f"unknown repo: {repo}")

        framings = {
            "explore": (
                "You are helping a user explore the {repo} codebase. They have a "
                "Cartograph knowledge base loaded — bedrock + topic notes + walkthroughs "
                "under guides/{repo}/ and learn/. Read the relevant guides FIRST, "
                "then point the user at specific file:line locations in workspace/{repo}/. "
                "Be concrete. Cite file:line. Keep the answer short (under 400 words)."
            ),
            "review-topic": (
                "You are reviewing the Cartograph topic note at: {context}\n\n"
                "The user wants a second opinion on whether it's accurate, complete, "
                "and useful. Read the topic note, then read the cited code in "
                "workspace/{repo}/ to verify claims. Report: claims that hold up, "
                "claims that are wrong or stale, gaps that should be filled. "
                "Be specific. Cite file:line."
            ),
            "review-bedrock": (
                "You are reviewing a Cartograph bedrock file at: {context}\n\n"
                "Bedrock is the brief, dense layer loaded on every Claude turn. "
                "Read the file, then verify against workspace/{repo}/ and the topic "
                "notes under guides/{repo}/topics/. Report: claims that hold up, "
                "claims that are wrong, structural gaps (per docs/quality-bar.md). "
                "Be specific. Cite file:line."
            ),
            "review-episode": (
                "You are reviewing the Cartograph episode at: {context}\n\n"
                "Episodes are session worknotes — small (200-600w), task-driven. "
                "Read it, check the files_touched are real, cross-reference any "
                "claims against the relevant topic notes / bedrock. Suggest: tags "
                "to add, whether it should supersede an older episode, whether it's "
                "ripe to distill into a topic note (≥3 episodes same tag)."
            ),
            "review-draft": (
                "You are reviewing the long-form essay draft at: {context}\n\n"
                "Drafts are pre-publication outlines or partial bodies. The user "
                "wants honest feedback on: the spine of the argument, factual "
                "accuracy against workspace/{repo}/, missing nuance, and whether "
                "it's ready to promote to a walkthrough at learn/walkthroughs/."
            ),
            "review-research": (
                "You are reviewing the research note at: {context}\n\n"
                "Research notes are intermediate — they capture external context, "
                "comparisons to other tools, design rationale that doesn't yet "
                "fit a topic note. Read it, fact-check claims against the cited "
                "sources + workspace/{repo}/, surface what's stable enough to be "
                "promoted to a topic note or draft, and what's still speculative."
            ),
            "review-paper": (
                "You are reviewing the paper notes at: {context}\n\n"
                "Paper notes are summaries + how-we-used-it for an external paper, "
                "RFC, or design doc. Cross-reference the claims with workspace/{repo}/ "
                "and related research notes. Surface: what we've actually adopted "
                "from the paper, what's still speculative, what's contradicted by "
                "the current code."
            ),
            "explain-code": (
                "You are explaining the code file at workspace/{repo}/{context} to a user. "
                "Cross-reference with the bedrock + relevant topic notes under guides/{repo}/ "
                "so the user gets the conceptual framing alongside the line-level detail. "
                "Be concrete. Use the user's question to focus."
            ),
            "general": (
                "You are helping with Cartograph (a layered Markdown knowledge base for "
                "JAX/XLA/Orbax/Tunix/Tokamax). Bedrock and topic notes are under "
                "guides/<repo>/; walkthroughs and ramp-ups under learn/."
            ),
        }
        framing = framings.get(kind, framings["general"])
        framing = framing.format(repo=repo or "<repo>", context=context or "<context>")

        prompt_file = subprocess.run(  # noqa: S603
            ["mktemp", "-t", "cartograph-ask-prompt.XXXXXX"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        try:
            Path(prompt_file).write_text(
                f"# Framing\n\n{framing}\n\n# User question\n\n{prompt}\n",
                encoding="utf-8",
            )
            flags = os.environ.get(
                "CARTOGRAPH_ASK_CLAUDE_FLAGS",
                '-p --output-format text --permission-mode acceptEdits '
                '--allowedTools "Read,Glob,Grep,Bash"',
            )
            # Route through the headless control layer so the answer agent sets
            # the recursion marker (its own hooks won't enqueue/spawn). FORCE=1
            # bypasses the concurrency cap: a synchronous user question must
            # never be held back by a background drain.
            headless_lib = PROJECT_ROOT / "scripts" / "lib" / "headless.sh"
            result = subprocess.run(  # noqa: S603
                [
                    "bash", "-c",
                    f'source "{headless_lib}"; '
                    f"CARTOGRAPH_HEADLESS_FORCE=1 cg_headless_run ask -- {flags} < {prompt_file}",
                ],
                capture_output=True, text=True, timeout=300,
                cwd=str(PROJECT_ROOT),
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="claude timed out") from None
        finally:
            Path(prompt_file).unlink(missing_ok=True)

        return {
            "ok": result.returncode == 0,
            "exit_code": result.returncode,
            "answer": result.stdout.strip(),
            "stderr": result.stderr[-1000:] if result.stderr else "",
        }

    @app.post("/api/curate")
    def curate_now() -> dict[str, Any]:
        """Drain the curation queue on demand with one batched agent.

        Runs the drain on a background thread (it can take minutes) and returns
        at once with how many tasks were pending. The drain self-limits via the
        global headless cap, so triggering this while an agent is already
        running is a safe no-op.
        """
        script = PROJECT_ROOT / "scripts" / "curate.sh"
        try:
            pending = subprocess.run(  # noqa: S603
                ["bash", str(script), "count"],
                cwd=str(PROJECT_ROOT), capture_output=True, text=True, timeout=10,
            ).stdout.strip()
        except Exception:  # noqa: BLE001
            pending = "?"
        threading.Thread(target=_drain_curation_queue, daemon=True).start()
        return {"status": "draining", "queued": pending}

    @app.get("/api/promotions")
    def list_promotions() -> dict[str, Any]:
        """Chronological log of all auto-promotion events.

        Scans the filesystem for items carrying any of these flags:
          - episodes with `auto_drafted: true`        (session → episode)
          - topic notes with `auto_promoted: true`    (episodes → topic)
          - topic notes with `folded_into_bedrock:`   (topic → bedrock)
        and returns them sorted newest-first, so the UI can render an
        "everything cartograph compounded for you" feed.
        """
        events: list[dict[str, Any]] = []

        # Episodes — auto_drafted
        episodes_dir = PROJECT_ROOT / "episodes"
        if episodes_dir.exists():
            for ep in episodes_dir.rglob("*.md"):
                fm = _read_frontmatter(ep)
                if fm.get("auto_drafted") is True:
                    events.append({
                        "kind": "episode-auto-draft",
                        "title": ep.stem,
                        "repo": fm.get("repo"),
                        "date": str(fm.get("date") or ""),
                        "path": str(ep.relative_to(PROJECT_ROOT)),
                        "url": f"/episodes/{ep.stem}/",
                        "reviewed": fm.get("reviewed_by_human")
                            if isinstance(fm.get("reviewed_by_human"), str)
                            and fm.get("reviewed_by_human") not in ("", "~")
                            else None,
                        "rejected": fm.get("rejected") is True,
                    })

        # Topic notes — auto_promoted / folded_into_bedrock
        guides = PROJECT_ROOT / "guides"
        if guides.exists():
            for topic in guides.rglob("topics/*.md"):
                fm = _read_frontmatter(topic)
                repo = topic.parent.parent.name
                base = {
                    "repo": repo,
                    "title": topic.stem,
                    "path": str(topic.relative_to(PROJECT_ROOT)),
                    "url": f"/repo/{repo}/topics/{topic.stem}/",
                    "reviewed": fm.get("reviewed_by_human")
                        if isinstance(fm.get("reviewed_by_human"), str)
                        and fm.get("reviewed_by_human") not in ("", "~")
                        else None,
                    "rejected": fm.get("rejected") is True,
                }
                if fm.get("auto_promoted") is True:
                    events.append({
                        **base,
                        "kind": "topic-auto-promote",
                        "date": str(fm.get("last_revised") or ""),
                    })
                folded = fm.get("folded_into_bedrock")
                if folded and str(folded).strip() not in ("", "~"):
                    events.append({
                        **base,
                        "kind": "topic-fold-bedrock",
                        "date": str(folded),
                    })

        events.sort(key=lambda e: str(e.get("date") or ""), reverse=True)
        return {
            "ok": True,
            "total": len(events),
            "by_kind": {
                "episode-auto-draft": sum(1 for e in events if e["kind"] == "episode-auto-draft"),
                "topic-auto-promote": sum(1 for e in events if e["kind"] == "topic-auto-promote"),
                "topic-fold-bedrock": sum(1 for e in events if e["kind"] == "topic-fold-bedrock"),
            },
            "events": events,
        }

    @app.get("/api/adjacent-repos")
    def adjacent_repos() -> dict[str, Any]:
        """Count mentions of adjacent / candidate repos across cartograph content.

        Scans guides/, episodes/, research/, papers/ for substring matches
        of known adjacent project names. When mention count crosses a
        threshold, the UI surfaces a suggestion to add that repo to
        cartograph as a tracked fork.
        """
        candidates = {
            "flax": ["flax", "nnx.Module", "flax.training", "flax.linen"],
            "optax": ["optax", "optax.GradientTransformation"],
            "qwix": ["qwix", "QArray", "qwix.QArray"],
            "sglang-jax": ["sglang", "sglang_jax", "sglang-jax"],
            "vllm": ["vllm", "vLLM"],
            "jaxlib": ["jaxlib"],
            "shardy": ["shardy", "sdy::", "sdy dialect"],
            "stablehlo": ["stablehlo", "StableHLO"],
            "treescope": ["treescope"],
        }
        # Already tracked — exclude from suggestions but still count.
        tracked = set(REPOS)
        roots = [GUIDES_DIR, PROJECT_ROOT / "episodes", PROJECT_ROOT / "research",
                 PROJECT_ROOT / "papers"]

        counts: dict[str, int] = {}
        file_counts: dict[str, set[str]] = {}
        for name, patterns in candidates.items():
            counts[name] = 0
            file_counts[name] = set()

        for root in roots:
            if not root.exists():
                continue
            # Single pass: read each md file once, check all patterns.
            for p in root.rglob("*.md"):
                try:
                    text = p.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                lower = text.lower()
                rel = str(p.relative_to(PROJECT_ROOT))
                for name, patterns in candidates.items():
                    hits = sum(lower.count(pat.lower()) for pat in patterns)
                    if hits > 0:
                        counts[name] += hits
                        file_counts[name].add(rel)

        # A candidate is already covered if its name — or its leading repo
        # token before a '-'/'_' variant suffix (e.g. "sglang-jax" → "sglang")
        # — matches a tracked repo. Without the variant check an ecosystem
        # candidate like "sglang-jax" keeps offering a "set up" button even
        # though its base repo (sglang) is already a tracked fork.
        def _already_tracked(cand: str) -> bool:
            return (cand in tracked
                    or cand.split("-", 1)[0] in tracked
                    or cand.split("_", 1)[0] in tracked)

        suggestions = []
        for name, n in counts.items():
            if _already_tracked(name):
                continue
            files = sorted(file_counts[name])
            # Threshold: ≥5 hits across ≥2 files = worth proposing as a fork.
            should_suggest = n >= 5 and len(files) >= 2
            suggestions.append({
                "name": name,
                "mention_count": n,
                "file_count": len(files),
                "files": files[:10],
                "suggest_add": should_suggest,
            })
        suggestions.sort(key=lambda s: (-int(s["suggest_add"]), -s["mention_count"]))

        return {
            "ok": True,
            "tracked_repos": list(tracked),
            "suggestions": suggestions,
        }

    @app.get("/api/paper-pdf/{repo}/{slug}/{filename:path}")
    def get_paper_pdf(repo: str, slug: str, filename: str) -> Any:
        """Serve a paper PDF from ``papers/<repo>/<slug>/<filename>``."""
        from fastapi.responses import FileResponse  # noqa: PLC0415

        if repo not in REPOS:
            raise HTTPException(status_code=404, detail="unknown repo")
        if "/" in slug or ".." in slug or "/" in filename or ".." in filename:
            raise HTTPException(status_code=400, detail="invalid path")
        path = PROJECT_ROOT / "papers" / repo / slug / filename
        try:
            path.resolve().relative_to((PROJECT_ROOT / "papers").resolve())
        except ValueError:
            raise HTTPException(status_code=400, detail="path escape") from None
        if not path.exists() or not path.is_file():
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(path, media_type="application/pdf")

    @app.get("/api/design-docx/{repo}/{slug}/{filename:path}")
    def get_design_docx(repo: str, slug: str, filename: str) -> Any:
        """Serve a design deliverable from ``designs/<repo>/<slug>/<filename>``.

        The .docx (or .pdf) is the build output authored by the design's
        build script — the UI exposes it as a download so the user can drag
        it into Google Drive. Path-traversal hardened the same way as
        get_paper_pdf; the MIME type is inferred from the extension so a
        sibling .pdf or .pptx works without code changes.
        """
        from fastapi.responses import FileResponse  # noqa: PLC0415

        if repo not in REPOS:
            raise HTTPException(status_code=404, detail="unknown repo")
        if "/" in slug or ".." in slug or "/" in filename or ".." in filename:
            raise HTTPException(status_code=400, detail="invalid path")
        path = PROJECT_ROOT / "designs" / repo / slug / filename
        try:
            path.resolve().relative_to((PROJECT_ROOT / "designs").resolve())
        except ValueError:
            raise HTTPException(status_code=400, detail="path escape") from None
        if not path.exists() or not path.is_file():
            raise HTTPException(status_code=404, detail="not found")
        media = {
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".pdf": "application/pdf",
            ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }.get(path.suffix.lower(), "application/octet-stream")
        return FileResponse(path, media_type=media, filename=path.name)

    @app.get("/api/proposal-docx/{repo}/{slug}")
    def get_proposal_docx(repo: str, slug: str) -> Any:
        """Serve the finalized proposal deliverable from
        ``proposals/<repo>/<slug>.docx`` (built by
        ``proposals/_build/build-proposal-docx.mjs``). ``repo`` may be ``_new``
        for new-repo proposals, so validation is against the proposals tree
        rather than REPOS. Path-traversal hardened like get_design_docx.
        """
        from fastapi.responses import FileResponse  # noqa: PLC0415

        if "/" in repo or ".." in repo or "/" in slug or ".." in slug:
            raise HTTPException(status_code=400, detail="invalid path")
        path = PROJECT_ROOT / "proposals" / repo / f"{slug}.docx"
        try:
            path.resolve().relative_to((PROJECT_ROOT / "proposals").resolve())
        except ValueError:
            raise HTTPException(status_code=400, detail="path escape") from None
        if not path.exists() or not path.is_file():
            raise HTTPException(
                status_code=404,
                detail="not built — run: node proposals/_build/build-proposal-docx.mjs <repo> <slug>",
            )
        return FileResponse(
            path,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename=path.name,
        )

    # In-memory IDE state — the Cartograph VS Code extension POSTs the
    # active file here; the /browse sidebar polls GET to stay in sync.
    _ide_state: dict[str, Any] = {"repo": None, "file": None, "line": None, "ts": None}

    @app.get("/api/ide-state")
    def get_ide_state() -> dict[str, Any]:
        return {"ok": True, **_ide_state}

    @app.post("/api/ide-state")
    def post_ide_state(
        body: dict[str, Any] = Body(default_factory=dict),  # noqa: B008
    ) -> dict[str, Any]:
        _ide_state["repo"] = body.get("repo")
        _ide_state["file"] = body.get("file")
        _ide_state["line"] = body.get("line")
        _ide_state["ts"] = datetime.now(tz=timezone.utc).isoformat()
        return {"ok": True}

    _CITATION_RE = re.compile(
        r"([A-Za-z0-9_][A-Za-z0-9_./-]*\."
        r"(?:py|pyi|pyx|cc|cpp|cxx|c|h|hh|hpp|ts|tsx|js|go|rs|bzl)):(\d+)"
    )

    @app.get("/api/citations/{repo}")
    def citations(repo: str) -> dict[str, Any]:
        """Every `file:line` citation across this repo's bedrock + topic notes.

        Powers the extension's gutter markers + hover cards. Grouped by the
        cited code-file path (as written in the note — the extension does
        suffix matching against the editor's open file).
        """
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        guide_dir = GUIDES_DIR / repo
        files: dict[str, list[dict[str, Any]]] = {}
        md_paths: list[Path] = []
        if guide_dir.exists():
            md_paths.extend(guide_dir.rglob("*.md"))
        seams = GUIDES_DIR / "seams.md"
        if seams.exists():
            md_paths.append(seams)
        for md in md_paths:
            try:
                text = md.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            rel = str(md.relative_to(PROJECT_ROOT))
            if md.name == "seams.md":
                kind = "seam"
            elif "topics" in md.parts:
                kind = "topic"
            else:
                kind = "bedrock"
            for line in text.splitlines():
                for m in _CITATION_RE.finditer(line):
                    code_file, code_line = m.group(1), int(m.group(2))
                    files.setdefault(code_file, []).append({
                        "line": code_line,
                        "note": rel,
                        "kind": kind,
                        "context": line.strip()[:240],
                    })
        return {"ok": True, "repo": repo, "files": files}

    @app.get("/api/walkthroughs")
    def list_walkthroughs() -> dict[str, Any]:
        """List every walkthrough — slug + title + repo — for the IDE tour picker."""
        wdir = LEARN_DIR / "walkthroughs"
        out: list[dict[str, Any]] = []
        if wdir.exists():
            for md in sorted(wdir.glob("*.md")):
                fm = _read_frontmatter(md)
                text = md.read_text(encoding="utf-8", errors="replace")
                # Title = first H1, else the slug.
                title = md.stem
                tm = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
                if tm:
                    title = tm.group(1).strip()
                out.append({
                    "slug": md.stem,
                    "title": title,
                    "repo": fm.get("repo") if isinstance(fm.get("repo"), str) else None,
                    "rampup": bool(fm.get("rampup")),
                    "est_minutes": fm.get("est_minutes") if isinstance(fm.get("est_minutes"), int) else None,
                })
        return {"ok": True, "walkthroughs": out}

    @app.get("/api/walkthrough-steps/{slug}")
    def walkthrough_steps(slug: str) -> dict[str, Any]:
        """Parse a walkthrough into ordered steps for the editor-driven tour.

        Each `##`/`###` heading is a step; the first `file:line` citation
        inside it is the jump target. Repo per step is inferred from the
        cited path's leading segment when it names a tracked repo, else
        the walkthrough's frontmatter `repo`.
        """
        if "/" in slug or ".." in slug:
            raise HTTPException(status_code=400, detail="invalid slug")
        path = LEARN_DIR / "walkthroughs" / f"{slug}.md"
        if not path.exists():
            raise HTTPException(status_code=404, detail="walkthrough not found")
        text = path.read_text(encoding="utf-8", errors="replace")
        fm = _parse_frontmatter(text)
        default_repo = fm.get("repo") if isinstance(fm.get("repo"), str) else None
        body = _FRONTMATTER_RE.sub("", text, count=1)

        steps: list[dict[str, Any]] = []
        cur: dict[str, Any] | None = None
        for line in body.splitlines():
            hm = re.match(r"^(#{2,3})\s+(.*)$", line)
            if hm:
                if cur is not None:
                    steps.append(cur)
                cur = {"heading": hm.group(2).strip(), "prose": [],
                       "repo": None, "file": None, "line": None}
                continue
            if cur is None:
                continue
            cur["prose"].append(line)
            if cur["file"] is None:
                cm = _CITATION_RE.search(line)
                if cm:
                    cf, cl = cm.group(1), int(cm.group(2))
                    seg = cf.split("/", 1)[0]
                    cur["repo"] = seg if seg in REPOS else default_repo
                    cur["file"] = cf
                    cur["line"] = cl
        if cur is not None:
            steps.append(cur)
        for s in steps:
            # Full authored prose — the webview scrolls. (Was truncated to
            # 1200 chars, which chopped steps mid-sentence.)
            s["prose"] = "\n".join(s["prose"]).strip()
        return {
            "ok": True,
            "slug": slug,
            "repo": default_repo,
            "step_count": len(steps),
            "steps": steps,
        }

    @app.post("/api/code-server-theme")
    def set_code_server_theme(
        body: dict[str, Any] = Body(default_factory=dict),  # noqa: B008
    ) -> dict[str, Any]:
        """Switch the embedded code-server's theme to match cartograph.

        VS Code watches its own User settings.json and applies
        `workbench.colorTheme` changes LIVE — no reload. So writing the
        theme here makes the editor in the /browse iframe flip the moment
        the cartograph light/dark toggle is hit.
        """
        theme = body.get("theme")
        if theme not in {"light", "dark"}:
            raise HTTPException(
                status_code=400, detail="theme must be 'light' or 'dark'",
            )
        settings_path = (
            PROJECT_ROOT / ".code-server-data" / "User" / "settings.json"
        )
        if not settings_path.exists():
            raise HTTPException(
                status_code=404,
                detail="code-server settings.json not found",
            )
        try:
            data = json.loads(settings_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"code-server settings.json is not valid JSON: {exc}",
            ) from None
        # Explicit theme wins — turn off OS auto-detect so the cartograph
        # toggle is authoritative.
        data["window.autoDetectColorScheme"] = False
        data["workbench.colorTheme"] = (
            "Default Dark Modern" if theme == "dark" else "Default Light Modern"
        )
        settings_path.write_text(
            json.dumps(data, indent=2) + "\n", encoding="utf-8",
        )
        return {"ok": True, "theme": theme}

    @app.post("/api/episode/{slug}/review")
    def episode_review(
        slug: str,
        body: dict[str, Any] = Body(default_factory=dict),  # noqa: B008
    ) -> dict[str, Any]:
        """Approve, reject, or discard an episode.

        Approve  → sets `reviewed_by_human: <today>`, clears `rejected:`
        Reject   → records `rejected: true` + the note, then hands the
                   episode to the revise-rejected agent (claude fixes it
                   per the note and resets it to pending re-review)
        Discard  → deletes the episode file for good
        """
        if "/" in slug or ".." in slug:
            raise HTTPException(status_code=400, detail="invalid slug")
        verdict = body.get("verdict")
        if verdict not in {"approve", "reject", "discard"}:
            raise HTTPException(
                status_code=400,
                detail="verdict must be 'approve', 'reject', or 'discard'",
            )
        episodes_dir = PROJECT_ROOT / "episodes"
        ep_path: Path | None = None
        for month in episodes_dir.iterdir() if episodes_dir.exists() else []:
            if not month.is_dir():
                continue
            candidate = month / f"{slug}.md"
            if candidate.exists():
                ep_path = candidate
                break
        if ep_path is None:
            raise HTTPException(status_code=404, detail="episode not found")
        rel = str(ep_path.relative_to(PROJECT_ROOT))

        if verdict == "discard":
            ep_path.unlink(missing_ok=True)
            _git_publish([rel], f"chore: discard episode {slug}")
            _request_rebuild()
            return {"ok": True, "state": "discarded", "path": rel}

        if verdict == "approve":
            today = datetime.now(tz=timezone.utc).date().isoformat()
            _fm_set_or_remove(
                ep_path,
                {
                    "reviewed_by_human": today,
                    "review_notes": None,
                    "rejected": None,
                },
            )
            _request_rebuild()
            return {"ok": True, "state": "approved", "path": rel}

        # reject — record the note, hand it to the revise-rejected agent.
        # Accept either 'note' or 'notes' from the body — the front-end
        # sent 'notes' for a while and the silent 400 meant the
        # revise-rejected pipeline never spawned for bulk-review users.
        note = body.get("note") or body.get("notes")
        if not isinstance(note, str) or not note.strip():
            raise HTTPException(
                status_code=400,
                detail="reject verdict requires a non-empty 'note'",
            )
        _fm_set_or_remove(
            ep_path,
            {
                "reviewed_by_human": None,
                "review_notes": note.strip(),
                "rejected": True,
            },
        )
        revising = _spawn_revise_rejected(rel)
        _request_rebuild()
        return {
            "ok": True,
            "state": "revising" if revising else "rejected",
            "path": rel,
            "note": (
                "rejected — claude is revising it per your note; reload in a "
                "few minutes to re-review."
                if revising
                else "rejected (revise agent unavailable — fix manually)."
            ),
        }

    @app.post("/api/topic/{repo}/{topic}/fold-into-bedrock")
    def fold_topic_into_bedrock(repo: str, topic: str) -> dict[str, Any]:
        """Fold a topic note's insight into the relevant bedrock section.

        Surgical update — not a rewrite. Invokes claude -p with:
          - the topic note's body
          - the current bedrock for the repo
          - docs/quality-bar.md as the contract
        and asks claude to integrate the topic insight into the most
        affected bedrock file (overview / architecture / conventions),
        bump last_revised, and leave the topic note linked from the
        bedrock section.

        The topic note itself stays unchanged — it's the durable source
        of the deep dive; bedrock is the dense pointer that references it.
        """
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        if "/" in topic or ".." in topic:
            raise HTTPException(status_code=400, detail="invalid topic")
        topic_path = GUIDES_DIR / repo / "topics" / f"{topic}.md"
        if not topic_path.exists():
            raise HTTPException(status_code=404, detail="topic note not found")
        script = PROJECT_ROOT / "scripts" / "fold-topic-to-bedrock.sh"
        if not script.exists():
            raise HTTPException(
                status_code=500,
                detail="scripts/fold-topic-to-bedrock.sh missing",
            )
        try:
            result = subprocess.run(  # noqa: S603
                ["bash", str(script), repo, topic],
                capture_output=True, text=True, timeout=420,
                cwd=str(PROJECT_ROOT),
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(
                status_code=504, detail="fold timed out",
            ) from None
        _request_rebuild()
        return {
            "ok": result.returncode == 0,
            "exit_code": result.returncode,
            "stdout": result.stdout[-3000:],
            "stderr": result.stderr[-1500:],
            "note": "review git diff guides/<repo>/ before commit — bedrock should now reference this topic",
        }

    @app.get("/api/promote-candidates")
    def list_promote_candidates(threshold: int = 3) -> dict[str, Any]:
        """Tags with ≥`threshold` non-distilled episodes — candidates for /promote.

        Same logic the SessionStart digest hook surfaces. Returns the
        tag, the count, and the list of episode slugs so the UI can show
        them on /episodes/ with a "promote" button.
        """
        episodes_dir = PROJECT_ROOT / "episodes"
        if not episodes_dir.exists():
            return {"ok": True, "candidates": []}

        tag_to_episodes: dict[str, list[str]] = {}
        for ep in episodes_dir.rglob("*.md"):
            fm = _read_frontmatter(ep)
            distilled = fm.get("distilled_into")
            if distilled and str(distilled).strip() not in ("", "~"):
                continue
            tags_raw = fm.get("tags", [])
            if not isinstance(tags_raw, list):
                continue
            for tag in tags_raw:
                if not isinstance(tag, str):
                    continue
                tag_to_episodes.setdefault(tag, []).append(ep.stem)

        candidates = [
            {
                "tag": tag,
                "episode_count": len(slugs),
                "episode_slugs": sorted(slugs),
            }
            for tag, slugs in tag_to_episodes.items()
            if len(slugs) >= threshold
        ]
        candidates.sort(key=lambda c: (-c["episode_count"], c["tag"]))
        return {"ok": True, "threshold": threshold, "candidates": candidates}

    @app.post("/api/promote/{tag}")
    def promote_tag(tag: str) -> dict[str, Any]:
        """Distill ≥3 same-tag episodes into a topic note via claude -p.

        Resolves the target repo by majority of the source episodes' repo
        fields. Calls scripts/promote-tag.sh which:
          1. lists matching episodes
          2. drafts guides/<repo>/topics/<tag>.md
          3. sets distilled_into: on each source episode
        User reviews + edits + sets reviewed_by_human via the audit panel.
        """
        if "/" in tag or ".." in tag:
            raise HTTPException(status_code=400, detail="invalid tag")
        script = PROJECT_ROOT / "scripts" / "promote-tag.sh"
        if not script.exists():
            raise HTTPException(
                status_code=500, detail="scripts/promote-tag.sh missing",
            )
        try:
            result = subprocess.run(  # noqa: S603
                ["bash", str(script), tag],
                capture_output=True, text=True, timeout=600,
                cwd=str(PROJECT_ROOT),
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(
                status_code=504, detail="promote-tag timed out",
            ) from None
        _request_rebuild()
        if result.returncode != 0:
            # Surface as 5xx so the UI doesn't falsely claim success
            # when claude exited 0 but skipped Write (rc=4), the topic
            # was written but episodes never got stamped (rc=5), or
            # any other script failure.
            tail_err = (result.stderr or "")[-1500:]
            tail_out = (result.stdout or "")[-1500:]
            raise HTTPException(
                status_code=500,
                detail=f"promote-tag exit {result.returncode}: {tail_err.strip() or tail_out.strip() or 'no output'}",
            )
        return {
            "ok": True,
            "exit_code": 0,
            "stdout": result.stdout[-3000:],
            "stderr": result.stderr[-1500:],
            "note": "review the drafted topic note + each source episode's distilled_into before commit",
        }

    @app.post("/api/session/{slug}/mark-trivial")
    def session_mark_trivial(slug: str) -> dict[str, Any]:
        """Mark a session as 'trivial' so the missed-episode chip clears.

        Patches the session log's frontmatter ``episode_written:`` field
        to ``"not-needed"``. Idempotent.
        """
        if "/" in slug or ".." in slug:
            raise HTTPException(status_code=400, detail="invalid slug")
        log = _find_session_log(slug)
        if log is None:
            raise HTTPException(status_code=404, detail="session not found")
        text = log.read_text(encoding="utf-8")
        # Replace just the episode_written line (the file already has one as ~).
        new_text = re.sub(
            r"^episode_written: .*$",
            'episode_written: "not-needed"',
            text,
            count=1,
            flags=re.MULTILINE,
        )
        log.write_text(new_text, encoding="utf-8")
        _request_rebuild()
        return {"ok": True, "path": str(log.relative_to(PROJECT_ROOT))}

    @app.post("/api/session/{slug}/write-episode")
    def session_write_episode(slug: str) -> dict[str, Any]:
        """Invoke claude -p to draft an episode from the session log.

        Passes the session log content as context. Claude reads the
        tool-use log, opens the files that were edited, and drafts a
        short episode at episodes/<YYYY-MM>/<slug>.md. The user reviews
        the draft before commit.
        """
        if "/" in slug or ".." in slug:
            raise HTTPException(status_code=400, detail="invalid slug")
        log = _find_session_log(slug)
        if log is None:
            raise HTTPException(status_code=404, detail="session not found")
        script = PROJECT_ROOT / "scripts" / "session-to-episode.sh"
        if not script.exists():
            raise HTTPException(
                status_code=500,
                detail="scripts/session-to-episode.sh missing",
            )
        try:
            result = subprocess.run(  # noqa: S603
                ["bash", str(script), slug],
                capture_output=True, text=True, timeout=300,
                cwd=str(PROJECT_ROOT),
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(
                status_code=504,
                detail="session-to-episode timed out",
            ) from None
        _request_rebuild()
        return {
            "ok": result.returncode == 0,
            "exit_code": result.returncode,
            "stdout": result.stdout[-3000:],
            "stderr": result.stderr[-1500:],
            "note": "review the draft episode in episodes/ and edit before commit",
        }

    @app.post("/api/research")
    def save_research_note(
        body: dict[str, Any] = Body(default_factory=dict),  # noqa: B008
    ) -> dict[str, Any]:
        """Write a new research note to ``research/<repo>/<slug>.md``.

        Used by Claude sessions (via a future slash command) or by the UI
        to capture exploratory notes from a research session. Idempotent
        per (repo, slug): subsequent calls overwrite.
        """
        repo = body.get("repo")
        slug = body.get("slug")
        markdown = body.get("body", "")
        tags = body.get("tags", [])
        sources = body.get("sources", [])
        if repo not in REPOS:
            raise HTTPException(status_code=400, detail="invalid repo")
        if not isinstance(slug, str) or not slug or "/" in slug or ".." in slug:
            raise HTTPException(status_code=400, detail="invalid slug")
        if not isinstance(markdown, str) or not markdown.strip():
            raise HTTPException(status_code=400, detail="body is required")
        if not isinstance(tags, list):
            tags = []
        if not isinstance(sources, list):
            sources = []

        today = datetime.now(timezone.utc).date().isoformat()
        dest_dir = PROJECT_ROOT / "research" / repo
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{slug}.md"

        frontmatter_lines = [
            "---",
            "layer: research",
            f"repo: {repo}",
            f"slug: {slug}",
            f"last_revised: {today}",
        ]
        if tags:
            frontmatter_lines.append("tags:")
            for t in tags:
                if isinstance(t, str):
                    frontmatter_lines.append(f"  - {t}")
        if sources:
            frontmatter_lines.append("sources:")
            for s in sources:
                if isinstance(s, str):
                    frontmatter_lines.append(f"  - {s}")
        frontmatter_lines.append("---")
        content = "\n".join(frontmatter_lines) + "\n\n" + markdown.strip() + "\n"
        dest.write_text(content, encoding="utf-8")

        _request_rebuild()
        return {
            "ok": True,
            "path": f"research/{repo}/{slug}.md",
            "url": f"/research/{repo}/{slug}/",
            "bytes": dest.stat().st_size,
            "note": "review the diff before committing",
        }

    @app.post("/api/rebuild")
    def rebuild_site_endpoint() -> dict[str, Any]:
        """Trigger a coalesced background rebuild of the static site.

        For the background content scripts (backfill, auto-revise) to call
        after they mutate bedrock — so the served pages refresh without
        each script needing the npm toolchain itself.
        """
        _request_rebuild()
        return {"ok": True, "note": "rebuild requested (background, coalesced)"}

    @app.post("/api/promote-draft/{slug}")
    def promote_draft(slug: str) -> dict[str, Any]:
        """Move learn/drafts/<slug>.md → learn/walkthroughs/<slug>.md.

        Bumps frontmatter: ``kind: draft`` becomes ``kind: walkthrough`` and
        ``last_revised`` is set to today. The user reviews the diff before
        committing — this endpoint does NOT git add or commit.
        """
        if "/" in slug or ".." in slug:
            raise HTTPException(status_code=400, detail="invalid slug")
        src = LEARN_DIR / "drafts" / f"{slug}.md"
        dst = LEARN_DIR / "walkthroughs" / f"{slug}.md"
        if not src.exists():
            raise HTTPException(status_code=404, detail=f"no draft at {src.name}")
        if dst.exists():
            raise HTTPException(
                status_code=409,
                detail=f"walkthrough already exists at {dst.name}",
            )

        text = src.read_text(encoding="utf-8")
        today = datetime.now(timezone.utc).date().isoformat()

        # Rewrite the frontmatter: kind → walkthrough; last_revised → today.
        m = _FRONTMATTER_RE.match(text)
        if m:
            block = m.group(1)
            new_lines = []
            saw_kind = saw_revised = False
            for line in block.splitlines():
                if line.startswith("kind:"):
                    new_lines.append("kind: walkthrough")
                    saw_kind = True
                elif line.startswith("last_revised:"):
                    new_lines.append(f"last_revised: {today}")
                    saw_revised = True
                else:
                    new_lines.append(line)
            if not saw_kind:
                new_lines.insert(0, "kind: walkthrough")
            if not saw_revised:
                new_lines.append(f"last_revised: {today}")
            new_block = "\n".join(new_lines)
            text = text[: m.start(1)] + new_block + text[m.end(1) :]

        dst.write_text(text, encoding="utf-8")
        src.unlink()

        # A promotion moves a content file — commit it and rebuild the
        # static site, or the old /drafts/<slug>/ page keeps being served
        # and the new /walkthroughs/<slug>/ page never appears.
        committed = _git_publish(
            [f"learn/drafts/{slug}.md", f"learn/walkthroughs/{slug}.md"],
            f"chore(walkthrough): promote draft {slug}",
        )
        # Route through the throttled rebuild worker (not a direct
        # _rebuild_site) so a promotion never bypasses the cooldown that keeps
        # the build loop from pegging the CPU. The new walkthrough page appears
        # once the (coalesced) build lands.
        _request_rebuild()
        return {
            "ok": True,
            "from": f"learn/drafts/{slug}.md",
            "to": f"learn/walkthroughs/{slug}.md",
            "committed": committed,
            "rebuild": "queued",
            "note": (
                "promoted to a walkthrough"
                + (" · committed + pushed" if committed else "")
                + " · site rebuild queued"
            ),
        }

    @app.post("/api/backfill/all")
    def backfill_all() -> dict[str, Any]:
        """Backfill every tracked repo sequentially in one background thread.

        Registered before ``/api/backfill/{repo}`` so the literal ``all``
        wins route matching. Each repo runs the same backfill-bedrock.sh
        job the per-repo endpoint fires; poll ``GET /api/backfill/all/status``
        for the sequence's progress.
        """
        script = PROJECT_ROOT / "scripts" / "backfill-bedrock.sh"
        if not script.exists():
            raise HTTPException(
                status_code=500,
                detail="scripts/backfill-bedrock.sh missing",
            )
        with _backfill_all_lock:
            if _backfill_all_state["state"] == "running":
                return {
                    "ok": False,
                    "state": "running",
                    "note": "a backfill-all run is already in progress",
                }
            _backfill_all_state.update({
                "state": "running",
                "current": None,
                "started_at": datetime.now(tz=timezone.utc).isoformat(),
                "finished_at": None,
                "repos": {r: "pending" for r in REPOS},
            })
        threading.Thread(
            target=_backfill_all_worker,
            args=(REPOS,),
            daemon=True,
            name="backfill-all",
        ).start()
        return {
            "ok": True,
            "state": "running",
            "repos": list(REPOS),
            "note": "backfill-all started — poll /api/backfill/all/status",
        }

    @app.get("/api/backfill/all/status")
    def backfill_all_status() -> dict[str, Any]:
        """Progress of the sequential backfill-all run.

        ``repos`` is the orchestrator's view (pending/running/done/error/
        skipped); ``jobs`` attaches each repo's own state file via the same
        reader the per-repo status endpoint uses.
        """
        with _backfill_all_lock:
            st: dict[str, Any] = {
                k: (dict(v) if isinstance(v, dict) else v)
                for k, v in _backfill_all_state.items()
            }
        st["jobs"] = {r: _backfill_state(r) for r in REPOS}
        return st

    @app.post("/api/backfill/{repo}")
    def backfill_bedrock(repo: str) -> dict[str, Any]:
        """Start a bedrock re-backfill in the background — non-blocking.

        The backfill (``claude -p`` headless, 1-3 min) runs detached and
        writes ``.backfill-log/<repo>.state.json``. This call returns in
        milliseconds; poll ``GET /api/backfill/{repo}/status`` for progress.
        """
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        script = PROJECT_ROOT / "scripts" / "backfill-bedrock.sh"
        if not script.exists():
            raise HTTPException(
                status_code=500,
                detail="scripts/backfill-bedrock.sh missing",
            )
        if _backfill_state(repo).get("state") == "running":
            return {
                "ok": False,
                "state": "running",
                "note": "a backfill is already running for this repo",
            }
        # Detach: the inner shell backgrounds the real work via nohup and
        # exits instantly, so this request returns at once and no zombie is
        # left parented to the server. The script owns its own state file.
        subprocess.run(  # noqa: S603
            ["bash", "-c", f'nohup bash "{script}" "{repo}" >/dev/null 2>&1 &'],
            cwd=str(PROJECT_ROOT),
            timeout=10,
        )
        return {
            "ok": True,
            "state": "running",
            "note": "backfill started — poll /api/backfill/<repo>/status",
        }

    @app.get("/api/backfill/{repo}/status")
    def backfill_status(repo: str) -> dict[str, Any]:
        """Live state of a repo's backfill job: idle | running | done | error.

        Reads the state file backfill-bedrock.sh maintains, so it reflects
        runs started from the UI *or* the CLI. For finished runs the claude
        transcript tail is attached.
        """
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        st = _backfill_state(repo)
        log = st.get("log")
        if log and st.get("state") in ("done", "error"):
            try:
                st["log_tail"] = Path(log).read_text(
                    encoding="utf-8", errors="replace"
                )[-4000:]
            except OSError:
                pass
        return st

    @app.get("/api/lint")
    def lint_status() -> dict[str, Any]:
        """Run the content quality lint and return its JSON output.

        Shells out to ``scripts/lint-content.sh`` (which emits JSON on stdout).
        Returns the parsed JSON plus the exit code (0 = no hard fails, 1 =
        hard fails present).
        """
        script = PROJECT_ROOT / "scripts" / "lint-content.sh"
        if not script.exists():
            raise HTTPException(
                status_code=500,
                detail="scripts/lint-content.sh missing",
            )
        try:
            result = subprocess.run(  # noqa: S603
                ["bash", str(script)],
                capture_output=True,
                text=True,
                timeout=30,
                cwd=str(PROJECT_ROOT),
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="lint timed out") from None
        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError:
            return {
                "ok": False,
                "exit_code": result.returncode,
                "stdout": result.stdout[:2000],
                "stderr": result.stderr[:1000],
                "error": "lint output was not valid JSON",
            }
        data["exit_code"] = result.returncode
        return data

    # ── UI overhaul endpoints (claude-designs/cartograph/ui-overhaul/) ──

    def _run_query(filters: list[str], fmt: str = "json", limit: int = 0) -> Any:
        """Shell out to cartograph_query.py and return parsed result."""
        script = PROJECT_ROOT / "scripts" / "cartograph_query.py"
        args = ["python3", str(script), *filters, "--format", fmt]
        if limit:
            args.extend(["--limit", str(limit)])
        try:
            result = subprocess.run(  # noqa: S603
                args, capture_output=True, text=True, timeout=15,
                cwd=str(PROJECT_ROOT),
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="query timed out") from None
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr.strip()[:300])
        if fmt == "json":
            try:
                return json.loads(result.stdout or "[]")
            except json.JSONDecodeError:
                return []
        return result.stdout

    def _opinion_for(rel: str) -> dict[str, Any] | None:
        """Fresh stored opinion for a note (auto-review or UI-triggered).

        Fresh = the opinion file is newer than the note's last edit; an
        edited note invalidates its old opinion and re-enters review.
        """
        if not rel:
            return None
        key = rel[:-3] if rel.endswith(".md") else rel
        op_path = PROJECT_ROOT / ".cartograph" / "jobs" / f"opinion-{key.replace('/', '_')}.json"
        note_path = PROJECT_ROOT / rel
        try:
            if op_path.stat().st_mtime < note_path.stat().st_mtime:
                return None
            op = json.loads(op_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if op.get("status") != "done" or not op.get("verdict"):
            return None
        return op

    def _settle_reviewed(items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
        """Drop approve-opinioned items from a pending list; annotate the rest.

        An approve verdict settles the review — the human asked not to
        re-review what auto-review already cleared. Reject-opinioned items
        that were NOT auto-acted stay visible (contested calls), carrying
        the opinion so triage starts pre-annotated.
        """
        kept: list[dict[str, Any]] = []
        hidden = 0
        for item in items:
            op = _opinion_for(item.get("path") or "")
            if op and op.get("verdict") == "approve":
                hidden += 1
                continue
            if op:
                item["opinion"] = {
                    k: op.get(k)
                    for k in ("verdict", "reason", "confidence", "auto_review", "finished_at")
                    if op.get(k) is not None
                }
            kept.append(item)
        return kept, hidden

    @app.get("/api/queue")
    def queue_json() -> dict[str, Any]:
        """Sectioned review queue. Composes cartograph_query results +
        filesystem state (drift reports, worknote leases).

        See claude-designs/cartograph/review-queue/README.md.
        """
        topic_age_days = int(os.environ.get("CARTOGRAPH_QUEUE_TOPIC_AGE_DAYS", "90"))
        # approx 90 days ago
        from datetime import timedelta as _td
        cutoff_old = (datetime.now(timezone.utc) - _td(days=topic_age_days)).strftime("%Y-%m-%d")

        def _sec(label: str, items: list[Any]) -> dict[str, Any]:
            return {"label": label, "count": len(items), "items": items}

        sections = []

        # All non-rejected, non-reviewed episodes — auto-drafted OR
        # agent-authored. The previous query missed the latter, treating
        # claude-authored episodes as pre-blessed.
        unreviewed_episodes, _ = _settle_reviewed(
            _run_query(["layer=episode", "!reviewed_by_human", "!rejected"])
        )
        sections.append(_sec("Episodes awaiting review", unreviewed_episodes))

        unblessed, _ = _settle_reviewed(
            _run_query(["layer=topic", "!reviewed_by_human", "!rejected"])
        )
        sections.append(_sec("Topics awaiting human review", unblessed))

        stale = _run_query(["layer=topic", f"last_revised<{cutoff_old}"])
        sections.append(_sec(f"Topics aged >{topic_age_days}d", stale))

        # Drift reports — filesystem
        drift_repo = []
        drift_dir = PROJECT_ROOT / ".drift-reports"
        if drift_dir.is_dir():
            for p in sorted(drift_dir.glob("*.md")):
                text = p.read_text(encoding="utf-8", errors="replace")
                m = re.search(r"\*\*(\d+) commit", text)
                drift_repo.append({
                    "path": str(p.relative_to(PROJECT_ROOT)),
                    "repo": p.stem,
                    "commits": int(m.group(1)) if m else None,
                })
        sections.append(_sec("Per-repo drift reports open", drift_repo))

        # Filter drift + anchor entries through the per-job settled-state
        # resolver (defined later in this same closure scope). Both
        # /api/queue and /api/anchor-coverage filter through the same
        # function so the home queue panel and /console/review/ BulkAll
        # surface stay in lockstep — a run that completed on either
        # surface disappears from both on the next request, regardless
        # of whether the script's separate audit-JSON patch step ran.
        settled_drift_set = _settled_drift()
        settled_anchor_set = _settled_anchors()

        drift_topic = []
        topic_dir = PROJECT_ROOT / ".drift-reports" / "topics"
        if topic_dir.is_dir():
            for p in sorted(topic_dir.rglob("*.md")):
                rel = str(p.relative_to(PROJECT_ROOT))
                rs = _drift_repo_slug_from_path(rel)
                if rs and rs in settled_drift_set:
                    continue
                drift_topic.append({"path": rel})
        sections.append(_sec("Per-topic drift reports open", drift_topic))

        # Anchor-coverage gaps. The audit (scripts/anchor-coverage.py)
        # refreshes on SessionStart and dumps to .cartograph/state/.
        # Surface each topic with missing canonical anchors as a queue
        # row so /console/review can act on it via /api/anchor-fix.
        anchor_gaps = []
        ac_path = PROJECT_ROOT / ".cartograph" / "state" / "anchor-coverage.json"
        if ac_path.is_file():
            try:
                ac = json.loads(ac_path.read_text(encoding="utf-8"))
                for repo, gaps in (ac.get("gaps_by_repo") or {}).items():
                    for g in gaps:
                        slug = g.get("slug")
                        if not slug:
                            continue
                        if (repo, slug) in settled_anchor_set:
                            continue
                        anchor_gaps.append({
                            "path": f"guides/{repo}/topics/{slug}.md",
                            "repo": repo,
                            "slug": slug,
                        })
            except (OSError, json.JSONDecodeError):
                pass
        sections.append(_sec("Topics missing canonical anchors", anchor_gaps))

        # Topics whose cited workspace files moved since the topic was
        # last revised. Written by scripts/post-edit-topic-mark.sh on
        # every PostToolUse:Edit|Write — closes the §4 revision-discipline
        # feedback loop. Drains via /api/topic-revisions-pending/clear
        # when the user revises or dismisses.
        rev_pending = []
        tr_path = PROJECT_ROOT / ".cartograph" / "state" / "topic-revisions-pending.json"
        if tr_path.is_file():
            try:
                tr = json.loads(tr_path.read_text(encoding="utf-8"))
                for topic_path, info in tr.items():
                    m = re.match(r"^guides/([^/]+)/topics/([^/]+)\.md$", topic_path)
                    if not m:
                        continue
                    rev_pending.append({
                        "path": topic_path,
                        "repo": m.group(1),
                        "slug": m.group(2),
                        "cited_files": info.get("cited_files") or [],
                        "edits_in_session": info.get("edits_in_session"),
                    })
            except (OSError, json.JSONDecodeError):
                pass
        sections.append(_sec("Topics whose cited files moved", rev_pending))

        leases = []
        lease_dir = PROJECT_ROOT / ".cartograph" / "in-flight"
        if lease_dir.is_dir():
            for p in sorted(lease_dir.glob("*.md")):
                fm = _read_frontmatter(p)
                leases.append({
                    "slug": p.stem,
                    "acquired_at": fm.get("acquired_at"),
                    "intent": fm.get("intent"),
                    "agent": fm.get("agent"),
                })
        sections.append(_sec("Active worknote leases", leases))

        return {
            "sections": [s for s in sections if s["count"] > 0],
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

    @app.get("/api/whatknows")
    def whatknows(path: str) -> dict[str, Any]:
        """Reverse-index lookup. Returns notes citing the given path substring.

        See claude-designs/cartograph/file-reverse-index/README.md.
        """
        idx_path = PROJECT_ROOT / ".cartograph" / "index" / "by-file.json"
        if not idx_path.is_file():
            raise HTTPException(status_code=404, detail="file index not built; run scripts/build-file-index.py")
        try:
            idx = json.loads(idx_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=500, detail=f"index corrupted: {exc}") from exc
        needle = (path or "").strip()
        if not needle:
            return {"hits": [], "generated_at": idx.get("generated_at")}
        needle_base = needle.rsplit("/", 1)[-1]
        hits: list[dict[str, Any]] = []
        seen: set[str] = set()
        for file_path, entries in idx.get("by_file", {}).items():
            if file_path in seen:
                continue
            fp_base = file_path.rsplit("/", 1)[-1]
            # Bidirectional + basename match. See lookup_paths in build-file-index.py.
            if needle in file_path or file_path in needle or (needle_base and fp_base == needle_base):
                seen.add(file_path)
                hits.append({"path": file_path, "entries": entries})
        # Most specific (longest) first.
        hits.sort(key=lambda h: -len(h["path"]))
        return {"hits": hits[:50], "total": len(hits), "generated_at": idx.get("generated_at")}

    @app.get("/api/library")
    def library(
        type: str | None = None,
        repo: str | None = None,
        tag: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> dict[str, Any]:
        """Faceted index of library content (design/paper/research/walkthrough/learn).

        See claude-designs/cartograph/ui-overhaul/README.md. Passing
        ``limit`` and/or ``offset`` switches to paginated mode: the full
        result set is fetched, ``total`` is added to the response, and the
        page is sliced server-side. Without either param the legacy
        behavior (first 200 results, no ``total``) is unchanged.
        """
        filters = []
        layer_map = {
            "design": "design", "paper": "paper", "research": "research",
            "learn": "learn", "walkthrough": "learn",
        }
        if type and type in layer_map:
            filters.append(f"layer={layer_map[type]}")
        if repo:
            filters.append(f"repo={repo}")
        if tag:
            filters.append(f"tag={tag}")
        out: dict[str, Any] = {"filters": {"type": type, "repo": repo, "tag": tag}}
        if limit is None and offset is None:
            out["results"] = _run_query(filters, fmt="json", limit=200)
            return out
        results = _run_query(filters, fmt="json", limit=0)
        start = max(0, offset or 0)
        lim = max(0, limit) if limit is not None else 200
        out["results"] = results[start:start + lim] if lim else results[start:]
        out["total"] = len(results)
        out["limit"] = lim
        out["offset"] = start
        return out

    @app.get("/api/episodes-list")
    def episodes_list(
        repo: str | None = None,
        tag: str | None = None,
        unreviewed: bool = False,
        auto_drafted: bool | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> dict[str, Any]:
        """Filterable episode list. Renamed from /api/episodes to avoid
        collision with any future per-episode RESTful surface.

        Passing ``limit`` and/or ``offset`` switches to paginated mode:
        the full set is fetched, date-sorted, then sliced, and ``total``
        is added to the response. Without either param the legacy
        behavior (first 200 by path, no ``total``) is unchanged.
        """
        filters = ["layer=episode"]
        if repo:
            filters.append(f"repo={repo}")
        if tag:
            filters.append(f"tag={tag}")
        if unreviewed:
            filters.append("!reviewed_by_human")
        if auto_drafted is True:
            filters.append("auto_drafted=true")
        elif auto_drafted is False:
            filters.append("!auto_drafted")
        paginating = limit is not None or offset is not None
        results = _run_query(filters, fmt="json", limit=0 if paginating else 200)
        # Reverse-chronological by date frontmatter (cartograph_query sorts lex by path,
        # which for YYYY-MM/YYYY-MM-DD-* is *near*-chronological but not exact). Sort here.
        results.sort(key=lambda r: r.get("date") or "", reverse=True)
        out: dict[str, Any] = {"filters": {"repo": repo, "tag": tag, "unreviewed": unreviewed, "auto_drafted": auto_drafted}}
        if paginating:
            start = max(0, offset or 0)
            lim = max(0, limit) if limit is not None else 200
            out["results"] = results[start:start + lim] if lim else results[start:]
            out["total"] = len(results)
            out["limit"] = lim
            out["offset"] = start
        else:
            out["results"] = results
        return out

    @app.get("/api/find")
    def find_bm25(q: str, k: int = 10, repo: str | None = None, layer: str | None = None) -> dict[str, Any]:
        """BM25 retrieval over the notes corpus.

        Reads ``.cartograph/index/bm25.json`` (rebuilt at every SessionStart)
        and scores documents in-process. See
        ``claude-designs/cartograph/semantic-search/`` for trade-offs.
        """
        idx_path = PROJECT_ROOT / ".cartograph" / "index" / "bm25.json"
        if not idx_path.is_file():
            raise HTTPException(status_code=404, detail="bm25 index not built; run scripts/build-search-index.py")
        try:
            idx = json.loads(idx_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=500, detail=f"index corrupted: {exc}") from exc
        # Lazy-import the scoring function so a missing yaml dep doesn't 500 us.
        import importlib.util
        spec = importlib.util.spec_from_file_location("_bm25", PROJECT_ROOT / "scripts" / "build-search-index.py")
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        assert spec and spec.loader
        spec.loader.exec_module(mod)
        hits = mod.bm25_search(idx, q, k, repo, layer)
        return {"query": q, "hits": hits, "generated_at": idx.get("generated_at")}

    @app.get("/api/stack/{repo}")
    def stack(repo: str) -> dict[str, Any]:
        """Auto-discover local branches in a fork and group them into stacks.

        Any branch that is NOT main is considered. For each branch we compute:
          - its closest ancestor branch (= the previous step in its stack)
          - commits ahead of that parent
          - whether main has advanced past the parent (stale cascade signal)
          - the matching PR by headRefName (state / mergeable / draft)

        A "stack" is a chain of branches where branch[N]'s tip is an ancestor
        of branch[N+1]'s tip. Tips of stacks are branches not contained by any
        other branch.
        """
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        wd = PROJECT_ROOT / "workspace" / repo
        if not (wd / ".git").exists():
            raise HTTPException(status_code=404, detail=f"workspace/{repo} not a git repo")

        # Resolve the default branch — most forks use 'main', a few use 'master'.
        default_branch = (_git(wd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
                          or "origin/main").split("/", 1)[-1]
        # Drop the trailing ref to just the branch name.
        if default_branch.startswith("refs/heads/"):
            default_branch = default_branch.split("/", 2)[-1]

        # All local branches with committer date + sha.
        raw = _git(
            wd, "for-each-ref", "refs/heads/",
            "--format=%(refname:short)|%(committerdate:iso8601-strict)|%(objectname:short)",
        )
        branches: list[dict[str, Any]] = []
        for line in (raw or "").splitlines():
            parts = line.split("|", 2)
            if len(parts) != 3:
                continue
            name, dt, sha = parts
            if name == default_branch:
                continue
            branches.append({"name": name, "committed_at": dt, "sha": sha})

        if not branches:
            return {"repo": repo, "default_branch": default_branch, "branches": [], "stacks": []}

        # Sort oldest-first so a branch's parent has already been processed.
        branches.sort(key=lambda b: b["committed_at"])

        def is_ancestor(a: str, b: str) -> bool:
            # `git merge-base --is-ancestor A B` → exit 0 if A is an ancestor of B.
            try:
                r = subprocess.run(  # noqa: S603
                    ["git", "-C", str(wd), "merge-base", "--is-ancestor", a, b],
                    capture_output=True, timeout=5,
                )
                return r.returncode == 0
            except subprocess.TimeoutExpired:
                return False

        # Map name → parent (the most-recent earlier branch that is an ancestor
        # of this one). Branches with no such ancestor have parent = main.
        for i, b in enumerate(branches):
            parent_name = default_branch
            for prev in reversed(branches[:i]):
                if is_ancestor(prev["sha"], b["sha"]):
                    parent_name = prev["name"]
                    break
            b["parent"] = parent_name
            ahead = _git(wd, "rev-list", "--count", f"{parent_name}..{b['name']}") or "0"
            behind = _git(wd, "rev-list", "--count", f"{b['name']}..{parent_name}") or "0"
            b["commits_ahead_of_parent"] = int(ahead.strip() or 0)
            b["commits_behind_parent"] = int(behind.strip() or 0)
            # Distance from main — useful for the "rebase needed?" hint.
            main_ahead = _git(wd, "rev-list", "--count", f"{default_branch}..{b['name']}") or "0"
            main_behind = _git(wd, "rev-list", "--count", f"{b['name']}..{default_branch}") or "0"
            b["commits_ahead_of_main"] = int(main_ahead.strip() or 0)
            b["commits_behind_main"] = int(main_behind.strip() or 0)

        # Group into stacks. A stack is a chain rooted at `default_branch`.
        # Build children map from parent_name → list of child branches.
        children: dict[str, list[dict[str, Any]]] = {}
        for b in branches:
            children.setdefault(b["parent"], []).append(b)

        # PR enrichment in a single gh call per repo.
        prs_by_head: dict[str, dict[str, Any]] = {}
        upstream_url = _git(wd, "remote", "get-url", "upstream") or ""
        m = re.search(r"[:/]([^/]+/[^/]+?)(?:\.git)?$", upstream_url.strip())
        origin_url = _git(wd, "remote", "get-url", "origin") or ""
        fm = re.search(r"[:/]([^/]+/[^/]+?)(?:\.git)?$", origin_url.strip())
        fork_slug = fm.group(1) if fm else None
        gh_user = _cartograph_user()
        if m and gh_user:
            upstream_slug = m.group(1)
            try:
                pr_result = subprocess.run(  # noqa: S603
                    ["gh", "pr", "list",
                     "--repo", upstream_slug,
                     "--author", gh_user,
                     "--state", "all",
                     "--limit", "100",
                     "--json", "number,title,state,isDraft,url,createdAt,updatedAt,headRefName,baseRefName,mergeable,reviewDecision"],
                    capture_output=True, text=True, timeout=15,
                )
                if pr_result.returncode == 0:
                    for pr in json.loads(pr_result.stdout or "[]"):
                        prs_by_head[pr["headRefName"]] = pr
            except (subprocess.TimeoutExpired, json.JSONDecodeError):
                pass

        for b in branches:
            b["pr"] = prs_by_head.get(b["name"])

        # Build the stacks tree by walking from default_branch downward.
        def walk(parent: str) -> list[dict[str, Any]]:
            return [
                {**b, "children": walk(b["name"])}
                for b in children.get(parent, [])
            ]

        stacks = walk(default_branch)

        # HEAD — the currently checked-out branch.
        head = (_git(wd, "rev-parse", "--abbrev-ref", "HEAD") or "").strip() or None

        return {
            "repo": repo,
            "default_branch": default_branch,
            "upstream_slug": m.group(1) if m else None,
            "fork_slug": fork_slug,
            "head": head,
            "branches": branches,
            "stacks": stacks,
        }

    @app.get("/api/prs")
    def all_prs() -> dict[str, Any]:
        """Aggregate PRs by the configured GitHub user across every tracked upstream."""
        out: list[dict[str, Any]] = []
        for repo in REPOS:
            try:
                data = list_prs(repo)  # type: ignore[arg-type]
            except HTTPException:
                continue
            if not data.get("ok"):
                continue
            for pr in data.get("prs", []) or []:
                out.append({**pr, "repo": repo})
        out.sort(key=lambda p: p.get("updatedAt") or "", reverse=True)
        return {"prs": out}

    BOOKMARKS_PATH = PROJECT_ROOT / ".cartograph" / "state" / "bookmarks.json"

    def _load_bookmarks() -> list[dict[str, Any]]:
        if not BOOKMARKS_PATH.is_file():
            return []
        try:
            data = json.loads(BOOKMARKS_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
        if isinstance(data, list):
            return [b for b in data if isinstance(b, dict) and "path" in b]
        return []

    def _save_bookmarks(items: list[dict[str, Any]]) -> None:
        BOOKMARKS_PATH.parent.mkdir(parents=True, exist_ok=True)
        BOOKMARKS_PATH.write_text(
            json.dumps(items, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    @app.get("/api/bookmarks")
    def list_bookmarks() -> dict[str, Any]:
        return {"bookmarks": _load_bookmarks()}

    @app.post("/api/bookmarks")
    def toggle_bookmark(body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:  # noqa: B008
        """Toggle a bookmark for the given path. Body: {path, title?}."""
        path = (body.get("path") or "").strip()
        if not path:
            raise HTTPException(status_code=400, detail="path required")
        title = (body.get("title") or path).strip()
        items = _load_bookmarks()
        existing = next((b for b in items if b.get("path") == path), None)
        if existing:
            items = [b for b in items if b.get("path") != path]
            _save_bookmarks(items)
            return {"pinned": False, "count": len(items)}
        items.insert(0, {
            "path": path,
            "title": title,
            "pinned_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
        _save_bookmarks(items)
        return {"pinned": True, "count": len(items)}

    @app.get("/api/related")
    def related_notes(path: str, k: int = 6) -> dict[str, Any]:
        """BM25 'more like this' over the corpus, anchored on a note's text.

        Reads the seed note's title + lead paragraph and runs BM25 against
        the corpus; excludes the seed itself.
        """
        idx_path = PROJECT_ROOT / ".cartograph" / "index" / "bm25.json"
        if not idx_path.is_file():
            raise HTTPException(status_code=404, detail="bm25 index not built")
        idx = json.loads(idx_path.read_text(encoding="utf-8"))
        seed_doc = next((d for d in idx["docs"] if d["path"] == path), None)
        if not seed_doc:
            return {"path": path, "hits": [], "reason": "seed not in index"}
        # Reconstruct the seed's tokens (excluding rare stop noise) as a query.
        # Take the top-N most-frequent tokens by tf — those define the doc's identity.
        tf = seed_doc.get("tf", {})
        top_tokens = sorted(tf.items(), key=lambda x: -x[1])[:20]
        query = " ".join(t for t, _ in top_tokens)
        # Reuse the existing search function.
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "_bm25", PROJECT_ROOT / "scripts" / "build-search-index.py"
        )
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        assert spec and spec.loader
        spec.loader.exec_module(mod)
        hits = [h for h in mod.bm25_search(idx, query, k + 1) if h["path"] != path]
        return {"path": path, "hits": hits[:k]}

    @app.get("/api/backlinks")
    def backlinks(path: str) -> dict[str, Any]:
        """Notes that mention the given note's path.

        Pure body grep — fast on a few-hundred-file corpus.
        """
        # Normalize: caller may pass the note slug or a full path.
        slug = path.split("/")[-1].replace(".md", "")
        out: list[dict[str, Any]] = []
        for sub in ("guides", "episodes", "research", "papers", "designs", "learn", "claude-designs"):
            base = PROJECT_ROOT / sub
            if not base.is_dir():
                continue
            for p in base.rglob("*.md"):
                rel = str(p.relative_to(PROJECT_ROOT))
                if rel == path:
                    continue
                try:
                    body = p.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                if path in body or slug in body:
                    out.append({"path": rel})
        return {"path": path, "backlinks": sorted(out, key=lambda x: x["path"])[:50]}

    @app.get("/api/review/pending")
    def review_pending(limit: int = 50) -> dict[str, Any]:
        """Items awaiting human review for the bulk-review surface.

        EPISODES: any non-rejected episode without reviewed_by_human gets
        surfaced, NOT just auto-drafted ones. The previous query gated on
        auto_drafted=true, which silently skipped episodes that claude
        wrote via /episode or directly — those landed without
        reviewed_by_human and never entered the queue, treating
        agent-authored notes as pre-blessed. They aren't.

        Topics use the same rule.
        """
        episodes, ep_hidden = _settle_reviewed(_run_query(
            ["layer=episode", "!reviewed_by_human", "!rejected"],
            fmt="json", limit=limit,
        ))
        for e in episodes:
            e["kind"] = "episode"
        topics, t_hidden = _settle_reviewed(_run_query(
            ["layer=topic", "!reviewed_by_human", "!rejected"],
            fmt="json", limit=limit,
        ))
        for t in topics:
            t["kind"] = "topic"
        return {
            "episodes": episodes,
            "topics": topics,
            "total": len(episodes) + len(topics),
            "auto_approved_hidden": ep_hidden + t_hidden,
        }

    def _spawn_fix_job(kind: str, repo: str, slug: str) -> dict[str, Any]:
        """Fire-and-forget spawn of scripts/<kind>-fix.sh.

        Heavy fix jobs (drift on a topic with 40+ citations) can run
        5-10 minutes. Synchronous subprocess.run blocks the HTTP request
        for that long. Detached spawn writes status JSON to
        .cartograph/jobs/<kind>-<repo>-<slug>.json which the
        /api/job/{kind}/{repo}/{slug} endpoint polls.
        """
        if repo not in REPOS:
            raise HTTPException(status_code=400, detail=f"unknown repo: {repo}")
        if not _SLUG_RE.match(slug):
            raise HTTPException(status_code=400, detail="invalid slug")
        script = PROJECT_ROOT / "scripts" / f"{kind}-fix.sh"
        if not script.exists():
            raise HTTPException(status_code=500, detail=f"{kind}-fix.sh missing")

        # Refuse to spawn a duplicate if a run is in flight for this slug.
        status_path = PROJECT_ROOT / ".cartograph" / "jobs" / f"{kind}-{repo}-{slug}.json"
        if status_path.is_file():
            try:
                existing = json.loads(status_path.read_text(encoding="utf-8"))
                if existing.get("status") == "running":
                    pid = existing.get("pid")
                    if pid:
                        try:
                            os.kill(int(pid), 0)
                            return {"status": "running", "job": f"{kind}-{repo}-{slug}", "note": "already in progress"}
                        except (ProcessLookupError, PermissionError, ValueError):
                            pass  # stale lock; fall through and re-spawn
            except (json.JSONDecodeError, OSError):
                pass

        log_path = PROJECT_ROOT / ".cartograph" / "jobs" / f"{kind}-{repo}-{slug}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "wb") as logf:
            subprocess.Popen(  # noqa: S603
                ["bash", str(script), repo, slug],
                stdin=subprocess.DEVNULL,
                stdout=logf, stderr=subprocess.STDOUT,
                cwd=str(PROJECT_ROOT),
                start_new_session=True,
            )
        return {"status": "running", "job": f"{kind}-{repo}-{slug}", "note": "spawned"}

    @app.post("/api/anchor-fix")
    def anchor_fix(body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:  # noqa: B008
        """Fire-and-forget — poll /api/job/anchor/{repo}/{slug} for status."""
        return _spawn_fix_job("anchor", (body.get("repo") or "").strip(), (body.get("slug") or "").strip())

    @app.post("/api/drift-fix")
    def drift_fix(body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:  # noqa: B008
        """Fire-and-forget — poll /api/job/drift/{repo}/{slug} for status."""
        return _spawn_fix_job("drift", (body.get("repo") or "").strip(), (body.get("slug") or "").strip())

    # If a status file says 'running' but has been idle this long, we assume
    # the script died between bash truncating the .tmp and python writing it
    # (or otherwise crashed before emitting a terminal state). Without this,
    # the UI polls forever on a dead job.
    _STALE_RUNNING_SECS = 180

    def _read_status_resilient(path: Path) -> dict[str, Any]:
        """Read a status JSON file, tolerating transient empty / mid-write reads.

        Scripts write `.tmp` then rename atomically, but on macOS a stray
        zero-byte read can still hit during high-frequency polling. Treat
        a brief empty / unparseable read as "writer mid-flight, keep
        polling" — but only briefly: if the file has been empty or its
        pid is dead for long enough, return an explicit error so the UI
        unblocks instead of spinning forever.
        """
        if not path.is_file():
            return {"status": "idle", "note": "no run on record"}
        try:
            mtime = path.stat().st_mtime
        except OSError:
            mtime = time.time()
        age = time.time() - mtime

        for _ in range(3):
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                return {"status": "running", "note": "status file briefly unreadable — retrying"}
            if not text.strip():
                # Empty file. If it's been empty long enough, the writer
                # almost certainly died — surface as error so the UI moves on.
                if age > _STALE_RUNNING_SECS:
                    return {"status": "error", "error": f"status file empty for {int(age)}s — writer likely crashed"}
                time.sleep(0.05)
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                time.sleep(0.05)
                continue

            # Liveness check: a 'running' status with a dead pid means the
            # script died after writing the initial marker. Return error
            # rather than reporting running forever. For live jobs, also
            # populate elapsed_secs from the file mtime (the script only
            # writes the field on terminal status) so the UI can render a
            # ticking 'claude is working… (Ns)' label instead of standing
            # still and looking hung.
            if payload.get("status") == "running":
                pid = payload.get("pid")
                if pid:
                    try:
                        os.kill(int(pid), 0)
                    except (ProcessLookupError, PermissionError, ValueError):
                        return {
                            "status": "error",
                            "error": f"job pid {pid} no longer alive — script died (age: {int(age)}s)",
                            "started_at": payload.get("started_at"),
                            "elapsed_secs": int(age),
                        }
                if "elapsed_secs" not in payload:
                    payload["elapsed_secs"] = int(age)
            return payload
        # Repeated parse failure with a young file → still mid-flight.
        if age > _STALE_RUNNING_SECS:
            return {"status": "error", "error": f"status file unparseable for {int(age)}s — writer likely crashed"}
        return {"status": "running", "note": "status file in flux — writer hasn't finished"}

    @app.get("/api/job/{kind}/{repo}/{slug}")
    def job_status(kind: str, repo: str, slug: str) -> dict[str, Any]:
        """Poll the JSON status written by scripts/<kind>-fix.sh."""
        if kind not in ("anchor", "drift"):
            raise HTTPException(status_code=400, detail="kind must be anchor or drift")
        if repo not in REPOS:
            raise HTTPException(status_code=400, detail=f"unknown repo: {repo}")
        if not _SLUG_RE.match(slug):
            raise HTTPException(status_code=400, detail="invalid slug")
        return _read_status_resilient(PROJECT_ROOT / ".cartograph" / "jobs" / f"{kind}-{repo}-{slug}.json")

    @app.get("/api/drift-list")
    def drift_list() -> dict[str, Any]:
        """All per-topic drift reports, grouped by repo. Used by the
        bulk drift-fix page. Filtered through _settled_drift() so
        topics whose latest drift-fix job is done (revised, bumped-only,
        or no-op) disappear immediately — drift-fix.sh's report-removal
        step is the persistent path, this resolver is the authoritative
        view that won't drift if the removal didn't run.
        """
        settled = _settled_drift()
        out: dict[str, list[dict[str, str]]] = {}
        topic_dir = PROJECT_ROOT / ".drift-reports" / "topics"
        if topic_dir.is_dir():
            for repo_dir in topic_dir.glob("*"):
                if not repo_dir.is_dir():
                    continue
                for p in sorted(repo_dir.glob("*.md")):
                    if (repo_dir.name, p.stem) in settled:
                        continue
                    out.setdefault(repo_dir.name, []).append({
                        "slug": p.stem,
                        "path": str(p.relative_to(PROJECT_ROOT)),
                    })
        return {"by_repo": out, "total": sum(len(v) for v in out.values())}

    def _sanitize_path(rel: str) -> str:
        # Mirror scripts/review-opinion.sh's sanitizer so the UI can compute
        # the same filename key without re-asking the server.
        s = rel.replace("/", "_")
        if s.endswith(".md"):
            s = s[:-3]
        return s

    @app.post("/api/review/opinion")
    def review_opinion(body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:  # noqa: B008
        """Fire-and-forget — poll /api/job/opinion?path=<rel> for status.

        Spawns scripts/review-opinion.sh detached. Heavy notes can take 60+
        seconds for claude to read and judge; we don't block the HTTP request.
        """
        path = (body.get("path") or "").strip()
        if not path or ".." in path:
            raise HTTPException(status_code=400, detail="path required")
        script = PROJECT_ROOT / "scripts" / "review-opinion.sh"
        if not script.exists():
            raise HTTPException(status_code=500, detail="review-opinion.sh missing")

        sanitized = _sanitize_path(path)
        status_path = PROJECT_ROOT / ".cartograph" / "jobs" / f"opinion-{sanitized}.json"
        # Refuse duplicate spawn.
        if status_path.is_file():
            try:
                existing = json.loads(status_path.read_text(encoding="utf-8"))
                if existing.get("status") == "running":
                    pid = existing.get("pid")
                    if pid:
                        try:
                            os.kill(int(pid), 0)
                            return {"status": "running", "job": f"opinion-{sanitized}", "note": "already in progress"}
                        except (ProcessLookupError, PermissionError, ValueError):
                            pass
            except (json.JSONDecodeError, OSError):
                pass

        log_path = PROJECT_ROOT / ".cartograph" / "jobs" / f"opinion-{sanitized}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "wb") as logf:
            subprocess.Popen(  # noqa: S603
                ["bash", str(script), path],
                stdin=subprocess.DEVNULL,
                stdout=logf, stderr=subprocess.STDOUT,
                cwd=str(PROJECT_ROOT),
                start_new_session=True,
            )
        return {"status": "running", "job": f"opinion-{sanitized}", "sanitized": sanitized}

    @app.get("/api/job/opinion")
    def opinion_status(path: str) -> dict[str, Any]:
        """Poll the status JSON written by scripts/review-opinion.sh.

        Pass the same `path` you sent to POST /api/review/opinion. The
        server sanitizes identically.
        """
        if not path or ".." in path:
            raise HTTPException(status_code=400, detail="path required")
        sanitized = _sanitize_path(path)
        return _read_status_resilient(PROJECT_ROOT / ".cartograph" / "jobs" / f"opinion-{sanitized}.json")

    def _cancel_pid(status_path: Path) -> dict[str, Any]:
        """Kill the script process recorded in a 'running' status file
        and rewrite the file to a terminal 'cancelled' state. Best-effort
        — if the script already exited we still write the cancelled state
        so the UI moves on.
        """
        if not status_path.is_file():
            return {"status": "idle", "note": "no run on record"}
        try:
            payload = json.loads(status_path.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError:
            payload = {}
        pid = payload.get("pid")
        killed = False
        if pid:
            try:
                # The script runs in its own session (start_new_session=True
                # on Popen), so signaling -pid hits the whole process group
                # — bash + claude -p together. Plain os.kill(pid) only
                # reaches bash and leaves claude orphaned.
                os.killpg(int(pid), signal.SIGTERM)
                killed = True
            except (ProcessLookupError, PermissionError, ValueError):
                try:
                    os.kill(int(pid), signal.SIGTERM)
                    killed = True
                except (ProcessLookupError, PermissionError, ValueError):
                    pass
        cancelled = {
            "status": "error",
            "error": "cancelled by user" + (" (signalled pid " + str(pid) + ")" if killed else " (pid already gone)"),
            "started_at": payload.get("started_at"),
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "elapsed_secs": payload.get("elapsed_secs"),
            "cancelled": True,
        }
        try:
            status_path.write_text(json.dumps(cancelled), encoding="utf-8")
        except OSError:
            pass
        return cancelled

    @app.post("/api/job/cancel")
    def job_cancel(body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:  # noqa: B008
        """Terminate a running fix/opinion job and mark its status cancelled.

        Body shape (one of):
          { "kind": "anchor" | "drift", "repo": "<r>", "slug": "<s>" }
          { "kind": "opinion", "path": "<rel-path>" }
        """
        kind = (body.get("kind") or "").strip()
        if kind in ("anchor", "drift"):
            repo = (body.get("repo") or "").strip()
            slug = (body.get("slug") or "").strip()
            if repo not in REPOS or not _SLUG_RE.match(slug):
                raise HTTPException(status_code=400, detail="invalid repo or slug")
            sp = PROJECT_ROOT / ".cartograph" / "jobs" / f"{kind}-{repo}-{slug}.json"
        elif kind == "opinion":
            path = (body.get("path") or "").strip()
            if not path or ".." in path:
                raise HTTPException(status_code=400, detail="path required")
            sp = PROJECT_ROOT / ".cartograph" / "jobs" / f"opinion-{_sanitize_path(path)}.json"
        else:
            raise HTTPException(status_code=400, detail="kind must be anchor, drift, or opinion")
        return _cancel_pid(sp)

    # ─────────────────────────────────────────────────────────────────
    # Settled-job resolver. The single source of truth for "did claude
    # finish this and is it pending re-display." Both /api/queue and
    # /api/anchor-coverage filter through this, so the home queue card
    # and the /console/review/ BulkAll surface can't drift apart — a
    # run that completed shows up as resolved on both surfaces on the
    # next request, regardless of whether the script's separate
    # anchor-coverage.json patch step ran successfully.
    # ─────────────────────────────────────────────────────────────────
    _SETTLED_ANCHOR_ACTIONS = {"anchored", "no-op"}
    _SETTLED_DRIFT_ACTIONS = {"revised", "bumped-only", "no-op"}

    def _settled_kind(kind: str, terminal_actions: set[str]) -> set[tuple[str, str]]:
        """Return the set of (repo, slug) pairs whose latest job for
        this kind is in a terminal 'work landed / discarded' state.
        Used to filter the audit JSON before exposing it to clients.
        """
        out: set[tuple[str, str]] = set()
        jobs_dir = PROJECT_ROOT / ".cartograph" / "jobs"
        if not jobs_dir.is_dir():
            return out
        prefix = f"{kind}-"
        for sp in jobs_dir.glob(f"{prefix}*.json"):
            try:
                payload = json.loads(sp.read_text(encoding="utf-8") or "{}")
            except (OSError, json.JSONDecodeError):
                continue
            if payload.get("status") != "done":
                continue
            if payload.get("action") not in terminal_actions:
                continue
            # Filename: <kind>-<repo>-<slug>.json
            # <repo> is a known repo (REPOS); <slug> is the rest. We
            # split on the first known repo prefix to handle slugs that
            # themselves contain hyphens (e.g. 'msgpack-and-restore-decoupling').
            stem = sp.stem
            if not stem.startswith(prefix):
                continue
            rest = stem[len(prefix):]
            for r in REPOS:
                if rest.startswith(f"{r}-"):
                    slug = rest[len(r) + 1:]
                    out.add((r, slug))
                    break
        return out

    def _settled_anchors() -> set[tuple[str, str]]:
        return _settled_kind("anchor", _SETTLED_ANCHOR_ACTIONS)

    def _settled_drift() -> set[tuple[str, str]]:
        return _settled_kind("drift", _SETTLED_DRIFT_ACTIONS)

    def _drift_repo_slug_from_path(rel: str) -> tuple[str, str] | None:
        """`.drift-reports/topics/orbax/foo.md` → ('orbax', 'foo')."""
        m = re.match(r"^\.drift-reports/topics/([^/]+)/(.+)\.md$", rel)
        if not m:
            return None
        return m.group(1), m.group(2)

    @app.get("/api/anchor-coverage")
    def anchor_coverage_all() -> dict[str, Any]:
        """The full anchor-coverage audit. Refreshed on SessionStart by
        scripts/anchor-coverage.py. Per-topic gaps are also surfaced
        inline on the topic detail page via the AnchorCoverageCallout
        island.

        Filtered through _settled_anchors() so any (repo, slug) whose
        latest anchor-fix job is done+anchored or done+no-op disappears
        — the script's anchor-coverage.json patch step is just an
        optimization; the resolver here is authoritative.
        """
        path = PROJECT_ROOT / ".cartograph" / "state" / "anchor-coverage.json"
        if not path.is_file():
            return {"topics_audited": 0, "total_gaps": 0, "gaps_by_repo": {}}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"topics_audited": 0, "total_gaps": 0, "gaps_by_repo": {}}
        settled = _settled_anchors()
        if not settled:
            return data
        gaps_by_repo = data.get("gaps_by_repo") or {}
        filtered: dict[str, list[Any]] = {}
        for repo, gaps in gaps_by_repo.items():
            kept = [g for g in gaps if (repo, g.get("slug") or "") not in settled]
            if kept:
                filtered[repo] = kept
        data["gaps_by_repo"] = filtered
        data["total_gaps"] = sum(len(v) for v in filtered.values())
        return data

    @app.post("/api/stack/{repo}/restack")
    def stack_restack(repo: str) -> dict[str, Any]:
        """Run `git-spice upstack restack` in the given fork.

        Surfaces the cascade-rebase action as a button on /repo/<r>/stack/
        so common conflict-free rebases don't need a terminal trip.
        Conflicts still surface in stderr and require manual resolution
        — they're not silently fixed.
        """
        if repo not in REPOS:
            raise HTTPException(status_code=404, detail=f"unknown repo: {repo}")
        wd = PROJECT_ROOT / "workspace" / repo
        if not (wd / ".git").is_dir():
            raise HTTPException(status_code=404, detail=f"workspace/{repo} not a git repo")
        # Resolve gs vs git-spice (Homebrew installs the latter; the alias is opt-in).
        gs_bin = shutil.which("gs") or shutil.which("git-spice")
        if not gs_bin:
            return {"ok": False, "error": "git-spice not on PATH — run scripts/setup-spice.sh"}
        try:
            result = subprocess.run(  # noqa: S603
                [gs_bin, "upstack", "restack"],
                capture_output=True, text=True, timeout=60,
                cwd=str(wd),
                stdin=subprocess.DEVNULL,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "git-spice upstack restack timed out (60s)"}
        return {
            "ok": result.returncode == 0,
            "exit_code": result.returncode,
            "stdout": result.stdout[:4000],
            "stderr": result.stderr[:4000],
        }

    @app.get("/api/topic-drift/{repo}/{slug}")
    def topic_drift_report(repo: str, slug: str) -> dict[str, Any]:
        """Return the per-topic drift report markdown if one exists."""
        if repo not in REPOS:
            raise HTTPException(status_code=400, detail="unknown repo")
        if "/" in slug or ".." in slug or not _SLUG_RE.match(slug):
            raise HTTPException(status_code=400, detail="invalid slug")
        path = PROJECT_ROOT / ".drift-reports" / "topics" / repo / f"{slug}.md"
        if not path.is_file():
            return {"present": False}
        return {"present": True, "markdown": path.read_text(encoding="utf-8", errors="replace")}

    READING_QUEUE_PATH = PROJECT_ROOT / ".cartograph" / "state" / "reading-queue.json"

    def _load_reading_queue() -> list[dict[str, Any]]:
        if not READING_QUEUE_PATH.is_file():
            return []
        try:
            data = json.loads(READING_QUEUE_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
        return data if isinstance(data, list) else []

    def _save_reading_queue(items: list[dict[str, Any]]) -> None:
        READING_QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
        READING_QUEUE_PATH.write_text(
            json.dumps(items, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    @app.get("/api/reading-queue")
    def get_reading_queue() -> dict[str, Any]:
        return {"items": _load_reading_queue()}

    @app.post("/api/reading-queue")
    def post_reading_queue(body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:  # noqa: B008
        """Add / update / remove an item in the reading queue.

        body: {action: 'add' | 'remove' | 'note', path, title?, note?}
        """
        action = body.get("action") or "add"
        path = (body.get("path") or "").strip()
        if not path:
            raise HTTPException(status_code=400, detail="path required")
        items = _load_reading_queue()
        if action == "remove":
            items = [i for i in items if i.get("path") != path]
        elif action in ("add", "note"):
            existing_idx = next((i for i, x in enumerate(items) if x.get("path") == path), -1)
            entry = {
                "path": path,
                "title": (body.get("title") or path).strip(),
                "note": (body.get("note") or "").strip(),
                "added_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            if existing_idx >= 0:
                if action == "note":
                    items[existing_idx]["note"] = entry["note"]
                else:
                    items[existing_idx] = entry
            else:
                items.insert(0, entry)
        _save_reading_queue(items)
        return {"items": items}

    @app.get("/api/inbox")
    def inbox() -> dict[str, Any]:
        """Episodes awaiting human review — auto-drafted OR agent-authored.
        Previously gated on auto_drafted=true; that silently exempted
        episodes claude wrote via /episode from the triage queue.
        """
        result = _run_query(
            ["layer=episode", "!reviewed_by_human", "!rejected"],
            fmt="json",
            limit=100,
        )
        result.sort(key=lambda r: r.get("date") or "", reverse=True)
        return {"episodes": result}

    @app.get("/api/diary")
    def diary_list(limit: int = 14) -> dict[str, Any]:
        """List recent diary entries (most recent first).

        See claude-designs/cartograph/diary/README.md.
        """
        diary_dir = PROJECT_ROOT / "diary"
        if not diary_dir.is_dir():
            return {"entries": []}
        entries = []
        for p in sorted(diary_dir.rglob("*.md"), reverse=True):
            if p.name == "README.md":
                continue
            fm = _read_frontmatter(p)
            entries.append({
                "path": str(p.relative_to(PROJECT_ROOT)),
                "date": str(fm.get("date") or p.stem),
            })
            if len(entries) >= limit:
                break
        return {"entries": entries}

    if DIST_DIR.exists():
        app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="static")
    else:
        @app.get("/")
        def root() -> dict[str, str]:
            return {
                "status": "build pending",
                "hint": "run `cd web && npm run build` first, then re-launch this server.",
            }

    return app


app = create_app()


def main() -> None:
    import uvicorn

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # Reload is ON by default so a `git pull` of new server code lands
    # without anyone having to remember to restart the daemon. Opt-out via
    # CARTOGRAPH_RELOAD=0 when you need a stable PID (process supervisor,
    # production-style deploy).
    reload = os.environ.get("CARTOGRAPH_RELOAD", "1") != "0"
    LOG.info("cartograph serving on http://127.0.0.1:47777 (reload=%s)", reload)
    # Catch-all rebuild watcher — guarantees the static site refreshes on
    # any content change, including a plain `git commit` that no hook sees.
    threading.Thread(target=_content_watch_loop, daemon=True).start()
    # Auto-commit watcher — designs/ and setups/ get staged + committed +
    # pushed after a quiet period, so a fresh design or updated harness
    # doesn't sit local while the served pages go stale.
    threading.Thread(target=_auto_commit_loop, daemon=True).start()
    # Batched-curation drain — the SessionStart/Stop hooks enqueue work; this
    # loop drains it with ONE headless agent per interval (cap=1), replacing the
    # per-item spawn fan-out that swarmed the machine.
    threading.Thread(target=_curate_loop, daemon=True).start()
    # uvicorn's reload mode imports by module string ("scripts.serve:app").
    # `python scripts/serve.py` only puts scripts/ on sys.path, not the
    # cartograph root — `app_dir` here prepends the root so both the
    # parent's import validation and the reload child process can resolve
    # the module no matter where the script was launched from.
    uvicorn.run(
        "scripts.serve:app" if reload else app,
        host="127.0.0.1",
        port=47777,
        reload=reload,
        log_level="info",
        app_dir=str(PROJECT_ROOT) if reload else None,
    )


if __name__ == "__main__":
    main()
