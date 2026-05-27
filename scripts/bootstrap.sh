#!/usr/bin/env bash
# scripts/bootstrap.sh — first-time setup helper.
#
# Checks every required dep, prints install instructions for missing ones,
# installs Python + Node deps, helps set up cartograph.env, runs doctor.
#
# Idempotent: safe to re-run any time.
#
# Required tools:
#   - bash 4+
#   - git 2.30+
#   - gh (GitHub CLI), authenticated
#   - just
#   - node 18+
#   - python 3.11+
#   - claude (Claude Code CLI)
#
# Optional:
#   - git-spice (for stacked-PR workflow; install at any time)
#   - shellcheck, ruff (for `just test` lints)

set -uo pipefail

CARTOGRAPH_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

missing=()
warnings=()

hd() { printf "\n\033[1m── %s ──\033[0m\n" "$1"; }
ok() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fl() { printf "  \033[31m✗\033[0m %s\n" "$1"; missing+=("$2"); }
wn() { printf "  \033[33m·\033[0m %s\n" "$1"; warnings+=("$2"); }

# ── Required tools ───────────────────────────────────────────────────────

hd "required tools"

# bash version — scripts are written for bash 3.2+ (Apple's default).
if (( ${BASH_VERSINFO[0]} >= 3 )); then
  ok "bash ${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"
else
  fl "bash ${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]} (need ≥3.2)" "bash"
fi

# git
if command -v git >/dev/null 2>&1; then
  git_v="$(git --version | awk '{print $3}')"
  ok "git $git_v"
else
  fl "git missing" "git (brew install git / apt install git)"
fi

# gh + auth
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    gh_user="$(gh api user --jq .login 2>/dev/null || echo '?')"
    ok "gh (authenticated as $gh_user)"
  else
    fl "gh installed but not authenticated" "gh auth login"
  fi
else
  fl "gh missing" "GitHub CLI (https://cli.github.com/)"
fi

# just
if command -v just >/dev/null 2>&1; then
  ok "just $(just --version | awk '{print $2}')"
else
  fl "just missing" "just (brew install just / cargo install just)"
fi

# node 18+
if command -v node >/dev/null 2>&1; then
  node_v="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if (( node_v >= 18 )); then
    ok "node $(node --version)"
  else
    fl "node $(node --version) (need ≥18)" "node 18+ (https://nodejs.org)"
  fi
else
  fl "node missing" "node 18+ (https://nodejs.org)"
fi

# python 3.11+
if command -v python3 >/dev/null 2>&1; then
  py_v="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  py_major="${py_v%%.*}"; py_minor="${py_v##*.}"
  if (( py_major > 3 )) || { (( py_major == 3 )) && (( py_minor >= 11 )); }; then
    ok "python $py_v"
  else
    fl "python $py_v (need ≥3.11)" "python 3.11+"
  fi
else
  fl "python3 missing" "python 3.11+"
fi

# claude
if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>&1 | head -1 | awk '{print $NF}')"
else
  fl "claude CLI missing" "Claude Code CLI (https://docs.claude.com/en/docs/claude-code)"
fi

# ── Optional tools ────────────────────────────────────────────────────────

hd "optional tools"

if command -v gs >/dev/null 2>&1 || command -v git-spice >/dev/null 2>&1; then
  ok "git-spice (for stacked-PR workflow)"
else
  wn "git-spice missing — /stack-* slashes will print an install hint" \
     "git-spice (brew install git-spice)"
fi

if command -v shellcheck >/dev/null 2>&1; then
  ok "shellcheck (for \`just test\` lint)"
else
  wn "shellcheck missing — \`just test\` will skip the shell lint step" \
     "shellcheck (brew install shellcheck)"
fi

if command -v ruff >/dev/null 2>&1; then
  ok "ruff (for \`just test\` lint)"
else
  wn "ruff missing — \`just test\` will skip the python lint step" \
     "ruff (pip install ruff)"
fi

# ── Required-deps summary ─────────────────────────────────────────────────

if (( ${#missing[@]} > 0 )); then
  hd "missing required tools"
  for m in "${missing[@]}"; do
    printf "  - %s\n" "$m"
  done
  echo
  echo "Install the above, then re-run \`just bootstrap\`."
  exit 1
fi

# ── Install language deps ─────────────────────────────────────────────────

hd "installing language deps"

if [[ -d "$CARTOGRAPH_ROOT/web/node_modules" ]]; then
  ok "web/node_modules present"
else
  echo "  → npm install (this takes a minute)"
  (cd "$CARTOGRAPH_ROOT/web" && npm install --silent) && ok "npm install ok" || fl "npm install failed" "npm"
fi

# Python deps for serve.py + mcp_server.py.
required_py=(fastapi uvicorn pyyaml mcp)
to_install=()
for pkg in "${required_py[@]}"; do
  if ! python3 -c "import $pkg" 2>/dev/null; then
    to_install+=("$pkg")
  fi
done
if (( ${#to_install[@]} > 0 )); then
  echo "  → pip install --user ${to_install[*]}"
  if python3 -m pip install --user --quiet "${to_install[@]}"; then
    ok "python deps installed: ${to_install[*]}"
  else
    wn "pip install failed — install manually: pip install ${to_install[*]}" "python deps"
  fi
else
  ok "all python deps present (${required_py[*]})"
fi

# ── cartograph.env ────────────────────────────────────────────────────────

hd "cartograph.env"

if [[ -f "$CARTOGRAPH_ROOT/cartograph.env" ]]; then
  ok "cartograph.env exists"
else
  if [[ -f "$CARTOGRAPH_ROOT/cartograph.env.example" ]]; then
    cp "$CARTOGRAPH_ROOT/cartograph.env.example" "$CARTOGRAPH_ROOT/cartograph.env"
    ok "copied cartograph.env.example → cartograph.env"
    echo
    echo "  ⚠ EDIT cartograph.env before continuing:"
    echo "       \$EDITOR $CARTOGRAPH_ROOT/cartograph.env"
    echo "    Fill in CARTOGRAPH_GITHUB_USER, _GIT_USER_NAME, _GIT_USER_EMAIL."
    echo
    echo "  Then re-run \`just bootstrap\` to verify config + run doctor."
    exit 0
  else
    fl "cartograph.env.example missing — repo is broken" "manual recovery"
    exit 1
  fi
fi

# ── Verify config ────────────────────────────────────────────────────────

hd "config verification"

source "$CARTOGRAPH_ROOT/scripts/lib/load-config.sh"
for k in CARTOGRAPH_GITHUB_USER CARTOGRAPH_GIT_USER_NAME CARTOGRAPH_GIT_USER_EMAIL; do
  if [[ -z "${!k:-}" || "${!k}" == "your-github-username" || "${!k}" == "you@example.com" ]]; then
    fl "$k not set (still has placeholder value)" "edit cartograph.env"
  else
    ok "$k=${!k}"
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo
  echo "Edit cartograph.env to fill in real values, then re-run \`just bootstrap\`."
  exit 1
fi

# ── Run doctor ───────────────────────────────────────────────────────────

hd "doctor (per-fork health check)"
bash "$CARTOGRAPH_ROOT/scripts/doctor.sh"
doctor_rc=$?

# ── Final summary ────────────────────────────────────────────────────────

hd "next steps"

if (( doctor_rc == 0 )); then
  cat <<EOF
  ✓ cartograph is set up.

  Add your first tracked repo:
    just add-repo <upstream-org>/<repo>

  Then start the local UI:
    just serve     # → http://localhost:47777

  Or run the dev stack (Astro + FastAPI + code-server):
    just dev
EOF
else
  cat <<EOF
  ⚠ Doctor reported issues. Fix the items above, then re-run \`just doctor\`.

  Most common cause: gh auth user doesn't match CARTOGRAPH_GITHUB_USER. Fix:
    gh auth switch -u $CARTOGRAPH_GITHUB_USER
EOF
fi

if (( ${#warnings[@]} > 0 )); then
  echo
  echo "Optional deps you can install later:"
  for w in "${warnings[@]}"; do printf "  - %s\n" "$w"; done
fi
