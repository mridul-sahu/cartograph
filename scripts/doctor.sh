#!/usr/bin/env bash
# Re-runnable identity + setup verification for all configured forks.
# Exits non-zero if anything is drifted, so it can gate other operations
# (e.g., refuse to fork-setup-add a new repo if doctor is unhappy).

set -uo pipefail

source "$(dirname "$0")/lib/load-config.sh"

WORKSPACE="$CARTOGRAPH_ROOT/workspace"
GUIDES="$CARTOGRAPH_ROOT/guides"

# Required config — without these, per-fork checks would be vacuous.
missing_config=0
for k in CARTOGRAPH_GITHUB_USER CARTOGRAPH_GIT_USER_NAME CARTOGRAPH_GIT_USER_EMAIL; do
  if [[ -z "${!k:-}" ]]; then
    echo "  FAIL $k is not set in cartograph.env"
    missing_config=$((missing_config + 1))
  fi
done
if (( missing_config > 0 )); then
  echo "[doctor] copy cartograph.env.example to cartograph.env and fill it in"
  exit 1
fi

EXPECTED_EMAIL="$CARTOGRAPH_GIT_USER_EMAIL"
EXPECTED_NAME="$CARTOGRAPH_GIT_USER_NAME"
EXPECTED_SSH_HOST="git@${CARTOGRAPH_SSH_HOST_ALIAS}:"
EXPECTED_OWNER="$CARTOGRAPH_GITHUB_USER"

problems=0
forks=0

# Enumerate forks (directories inside workspace/ with a .git/ subdir).
if [[ -d "$WORKSPACE" ]]; then
  while IFS= read -r -d '' d; do
    [[ -d "$d/.git" ]] || continue
    forks=$((forks + 1))
    repo="$(basename "$d")"
    fail() { echo "  FAIL $repo: $1"; problems=$((problems + 1)); }

    email="$(git -C "$d" config user.email 2>/dev/null || echo '')"
    [[ "$email" == "$EXPECTED_EMAIL" ]] || fail "user.email='$email' (want $EXPECTED_EMAIL)"

    name="$(git -C "$d" config user.name 2>/dev/null || echo '')"
    [[ "$name" == "$EXPECTED_NAME" ]] || fail "user.name='$name' (want $EXPECTED_NAME)"

    gpg="$(git -C "$d" config commit.gpgsign 2>/dev/null || echo '')"
    [[ "$gpg" == "false" ]] || fail "commit.gpgsign='$gpg' (want false)"

    # core.sshCommand: only enforce if cartograph.env opted in.
    ssh_cmd="$(git -C "$d" config core.sshCommand 2>/dev/null || echo '')"
    if [[ -n "${CARTOGRAPH_SSH_COMMAND:-}" ]]; then
      [[ "$ssh_cmd" == "$CARTOGRAPH_SSH_COMMAND" ]] \
        || fail "core.sshCommand='$ssh_cmd' (want '$CARTOGRAPH_SSH_COMMAND')"
    fi

    origin="$(git -C "$d" remote get-url origin 2>/dev/null || echo '')"
    [[ "$origin" == "${EXPECTED_SSH_HOST}${EXPECTED_OWNER}/${repo}.git" ]] \
      || fail "origin='$origin' (want ${EXPECTED_SSH_HOST}${EXPECTED_OWNER}/${repo}.git)"

    upstream="$(git -C "$d" remote get-url upstream 2>/dev/null || echo 'MISSING')"
    [[ "$upstream" == "$EXPECTED_SSH_HOST"*"/${repo}.git" ]] \
      || fail "upstream='$upstream'"

    [[ -x "$d/.git/hooks/commit-msg" ]] || fail "commit-msg hook missing or not executable"
    [[ -x "$d/.git/hooks/pre-push" ]]   || fail "pre-push hook missing or not executable"

    [[ -f "$d/CLAUDE.md" ]]      || fail "CLAUDE.md missing"

    grep -qxF 'CLAUDE.md' "$d/.git/info/exclude" 2>/dev/null \
      || fail "CLAUDE.md not in .git/info/exclude"

    # Bedrock guides exist for this repo
    for layer in overview.md architecture.md conventions.md; do
      [[ -f "$GUIDES/$repo/$layer" ]] || fail "guides/$repo/$layer missing"
    done
    [[ -d "$GUIDES/$repo/topics" ]] || fail "guides/$repo/topics/ missing"

  done < <(find "$WORKSPACE" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
fi

# Top-level Cartograph state.
[[ -f "$CARTOGRAPH_ROOT/CLAUDE.md" ]]              || { echo "  FAIL cartograph/CLAUDE.md missing"; problems=$((problems + 1)); }
[[ -f "$CARTOGRAPH_ROOT/.claude/settings.json" ]]  || { echo "  FAIL cartograph/.claude/settings.json missing"; problems=$((problems + 1)); }
[[ -f "$CARTOGRAPH_ROOT/guides/seams.md" ]]        || echo "  WARN cartograph/guides/seams.md missing (write it when seam-seeding happens)"

# SSH alias check: only run if the configured alias is non-default.
if [[ "$CARTOGRAPH_SSH_HOST_ALIAS" != "github.com" ]]; then
  if ! grep -qE "^Host[[:space:]]+${CARTOGRAPH_SSH_HOST_ALIAS}\b" "$HOME/.ssh/config" 2>/dev/null; then
    echo "  FAIL ~/.ssh/config missing Host ${CARTOGRAPH_SSH_HOST_ALIAS}"
    problems=$((problems + 1))
  fi
fi

# Server supervision: if the launchd agent is installed, confirm launchd
# actually owns the listen port (not an orphan). Report-only — the heal runs
# in SessionStart + maintenance; doctor just surfaces drift for a manual look.
# shellcheck source=lib/serve-control.sh
source "$(dirname "$0")/lib/serve-control.sh" 2>/dev/null || true
if declare -f cg_launchd_managed >/dev/null 2>&1 && cg_launchd_managed; then
  managed_pid="$(cg_launchd_pid)"
  port_pids="$(cg_serve_port_listeners | tr '\n' ' ' | sed 's/ *$//')"
  foreign=""
  for p in $port_pids; do [[ "$p" == "$managed_pid" ]] || foreign+="$p "; done
  if [[ -n "$foreign" ]]; then
    echo "  WARN serve supervision drift: foreign listener(s) [$foreign] hold :$CG_SERVE_PORT, not launchd pid '$managed_pid'"
    echo "       heal: bash scripts/serve-cartograph.sh --restart  (or it self-heals next SessionStart)"
  elif [[ -z "$port_pids" && -z "$managed_pid" ]]; then
    echo "  WARN serve down: launchd agent installed but nothing on :$CG_SERVE_PORT — self-heals next SessionStart"
  else
    echo "  OK   serve supervised by launchd (pid $managed_pid on :$CG_SERVE_PORT)"
  fi
fi

# Active gh user — warn if it doesn't match the configured account, so
# operations that go through `gh` (PR queries, fork-setup) don't silently
# act as the wrong identity.
gh_user="$(gh api user --jq .login 2>/dev/null || echo '?')"
if [[ "$gh_user" != "$CARTOGRAPH_GITHUB_USER" ]]; then
  echo "  WARN gh active='$gh_user' but CARTOGRAPH_GITHUB_USER='$CARTOGRAPH_GITHUB_USER'"
  echo "       run: gh auth switch -u $CARTOGRAPH_GITHUB_USER"
fi

echo
if (( problems == 0 )); then
  echo "[doctor] OK — $forks fork(s) configured; gh active=$gh_user"
  exit 0
else
  echo "[doctor] $problems problem(s) across $forks fork(s); gh active=$gh_user"
  exit 1
fi
