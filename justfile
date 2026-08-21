set shell := ["bash", "-cu"]

# Cartograph local dev runner.
# - `just deps`             : install Astro + python deps
# - `just dev`              : code-server (47780) + Astro dev (4321) + FastAPI dev (47777)
# - `just build`            : build the static UI under web/dist/
# - `just up`               : build, start code-server (47780), serve cartograph (47777) — all detached
# - `just serve`            : FastAPI server, detached (idempotent; uses pre-built web/dist/)
# - `just serve-restart`    : restart the detached FastAPI server (picks up serve.py changes)
# - `just serve-fg`         : FastAPI server in the foreground (live logs; Ctrl+C to stop)
# - `just code-server`      : start code-server in the background (idempotent)
# - `just code-server-stop` : stop code-server
# - `just down`             : stop code-server AND the cartograph server
# - `just add-repo <upstream-org/repo>` : fork-setup + bedrock stubs (build via /backfill in a session)
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
    CARTOGRAPH_PYTHON="{{PY}}" bash "{{ROOT}}/scripts/serve-cartograph.sh"

serve-restart:
    CARTOGRAPH_PYTHON="{{PY}}" bash "{{ROOT}}/scripts/serve-cartograph.sh" --restart

serve-fg:
    CARTOGRAPH_PYTHON="{{PY}}" bash "{{ROOT}}/scripts/serve-cartograph.sh" --foreground

up: build code-server serve

down: code-server-stop
    bash "{{ROOT}}/scripts/serve-cartograph.sh" --stop

# Run the smoke-test suite. Bash syntax check on every .sh, Python compile on
# every .py, functional smoke tests for doctor/inject-context/publish/lint,
# linters if installed.
test:
    bash "{{ROOT}}/tests/smoke.sh"

# First-time setup: verify deps, install what's missing, run doctor.
bootstrap:
    bash "{{ROOT}}/scripts/bootstrap.sh"

# Onboard a new tracked repo: fork + clone + remotes + hooks + bedrock stubs.
# Idempotent — safe to re-run. Bedrock itself is built in-session with the
# /backfill slash command (real bedrock is detected via
# `backfilled_from_sha:` frontmatter).
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
      echo "→ bedrock already exists for '$repo'"
      echo "  to rebuild: run /backfill $repo in a Claude Code session"
      exit 0
    fi
    echo "→ fork ready; build the bedrock in-session:"
    echo "  open a Claude Code session in workspace/$repo and run /backfill $repo"

# Build the docx deliverable for a finalized proposal — design-doc look-and-feel,
# investment-case content. Output: proposals/<repo>/<slug>.docx (served at
# /api/proposal-docx/<repo>/<slug> and offered as a download once status: greenlit).
#   just proposal-docx _new jax-rlvr-verifiers
proposal-docx repo slug:
    cd "{{ROOT}}/proposals/_build" && [ -d node_modules ] || npm install
    node "{{ROOT}}/proposals/_build/build-proposal-docx.mjs" "{{repo}}" "{{slug}}"

# Build the FORMAL final-draft docx (the /proposal-final-draft deliverable —
# Introduction / Background / Ecosystem+Impact / HLD / Feasibility & Risk /
# References). Renders proposals/<repo>/<slug>.final-draft.md (the builder prefers
# it over <slug>.md) → proposals/<repo>/<slug>.docx, with d2 diagrams embedded.
#   just proposal-final-draft tunix frontier-agentic-capability
proposal-final-draft repo slug: (proposal-docx repo slug)

