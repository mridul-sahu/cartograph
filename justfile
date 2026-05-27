set shell := ["bash", "-cu"]

# Cartograph local dev runner.
# - `just deps`             : install Astro + python deps
# - `just dev`              : code-server (47780) + Astro dev (4321) + FastAPI dev (47777)
# - `just build`            : build the static UI under web/dist/
# - `just up`               : build, start code-server (47780), serve cartograph (47777)
# - `just serve`            : just the FastAPI server (uses pre-built web/dist/)
# - `just code-server`      : start code-server in the background (idempotent)
# - `just code-server-stop` : stop code-server
# - `just down`             : stop code-server (cartograph is foreground — Ctrl+C it)
# - `just add-repo <upstream-org/repo>` : fork-setup + first bedrock backfill
# - `just backfill <repo>`  : (re-)build bedrock for an already-added repo
# - `just test`             : run the smoke-test suite (syntax + functional + lint)
# - `just bootstrap`        : check + install missing dependencies (first-time setup)

ROOT := justfile_directory()
WEB := ROOT / "web"
PY := env_var_or_default("CARTOGRAPH_PYTHON", "python3")

default: help

help:
    @just --list

deps:
    cd "{{WEB}}" && npm install
    {{PY}} -m pip install --user fastapi 'uvicorn[standard]' pyyaml

code-server:
    bash "{{ROOT}}/scripts/serve-code-server.sh"

code-server-stop:
    bash "{{ROOT}}/scripts/serve-code-server.sh" --stop

dev: code-server
    @echo "→ astro dev on :4321, fastapi dev on :47777, code-server on :47780 (Ctrl+C stops astro+fastapi; code-server keeps running — use \`just down\`)"
    (cd "{{WEB}}" && npm run dev) & \
    CARTOGRAPH_RELOAD=1 {{PY}} "{{ROOT}}/scripts/serve.py" & \
    wait

build:
    cd "{{WEB}}" && npm run build

serve:
    {{PY}} "{{ROOT}}/scripts/serve.py"

up: build code-server serve

down: code-server-stop

# Run the smoke-test suite. Bash syntax check on every .sh, Python compile on
# every .py, functional smoke tests for doctor/inject-context/publish/lint,
# linters if installed.
test:
    bash "{{ROOT}}/tests/smoke.sh"

# First-time setup: verify deps, install what's missing, run doctor.
bootstrap:
    bash "{{ROOT}}/scripts/bootstrap.sh"

# Onboard a new tracked repo: fork + clone + remotes + hooks + bedrock stubs,
# then (if no real bedrock yet) kick off the headless bedrock backfill in the
# background. Idempotent — safe to re-run; skips backfill if real bedrock
# already exists (detected via `backfilled_from_sha:` frontmatter).
add-repo upstream:
    #!/usr/bin/env bash
    set -euo pipefail
    upstream="{{upstream}}"
    if [[ "$upstream" != */* ]]; then
      echo "add-repo: expected <upstream-org/repo>, got: $upstream" >&2
      exit 2
    fi
    repo="${upstream##*/}"
    echo "→ fork-setup for $upstream"
    bash "{{ROOT}}/scripts/fork-setup.sh" "$upstream"
    echo
    overview="{{ROOT}}/guides/$repo/overview.md"
    if [[ -f "$overview" ]] && grep -q '^backfilled_from_sha:' "$overview"; then
      echo "→ bedrock already exists for '$repo' — skipping backfill"
      echo "  to force rebuild: just backfill $repo"
      exit 0
    fi
    echo "→ kicking off bedrock backfill in background"
    mkdir -p "{{ROOT}}/.backfill-log"
    nohup bash "{{ROOT}}/scripts/backfill-bedrock.sh" "$repo" >/dev/null 2>&1 &
    bg=$!
    disown $bg 2>/dev/null || true
    sleep 1
    latest_log="$(ls -t "{{ROOT}}/.backfill-log/"*-"$repo".log 2>/dev/null | head -1)"
    echo "  backfill pid=$bg"
    [[ -n "$latest_log" ]] && echo "  log: $latest_log"
    echo "  watch progress: visit http://localhost:47777/repo/$repo/ (or tail the log above)"

# Re-run bedrock backfill synchronously for an already-added repo. Streams
# claude's output to your terminal.
backfill repo:
    bash "{{ROOT}}/scripts/backfill-bedrock.sh" "{{repo}}"

