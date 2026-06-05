#!/usr/bin/env bash
# Bootstrap a single fork:
#   gh repo fork → clone → per-repo git config → upstream remote
#   → commit-msg + pre-push hooks → per-fork CLAUDE.md
#   → bedrock guide stubs (overview/architecture/conventions) + empty topics/ dir
#
# Idempotent: safe to re-run. Existing clones are re-configured in place.
# Bedrock stubs are only created if they don't already exist (preserves edits).
#
# Usage: scripts/fork-setup.sh <upstream-org/repo>

set -euo pipefail

source "$(dirname "$0")/lib/load-config.sh"

UPSTREAM="${1:?Usage: $0 <upstream-org/repo>}"
REPO_NAME="${UPSTREAM##*/}"

WORKSPACE="$CARTOGRAPH_ROOT/workspace"
TEMPLATES="$CARTOGRAPH_ROOT/scripts/templates"
GUIDES="$CARTOGRAPH_ROOT/guides"
DEST="$WORKSPACE/$REPO_NAME"

# Required config — fail fast with a useful message if cartograph.env is missing
# or incomplete. The .example file documents the keys.
for k in CARTOGRAPH_GITHUB_USER CARTOGRAPH_GIT_USER_NAME CARTOGRAPH_GIT_USER_EMAIL; do
  if [[ -z "${!k:-}" ]]; then
    echo "fork-setup: $k is not set — copy cartograph.env.example to cartograph.env and fill it in" >&2
    exit 1
  fi
done

FORK_OWNER="$CARTOGRAPH_GITHUB_USER"
ORIGIN_URL="git@${CARTOGRAPH_SSH_HOST_ALIAS}:${FORK_OWNER}/${REPO_NAME}.git"
UPSTREAM_URL="git@${CARTOGRAPH_SSH_HOST_ALIAS}:${UPSTREAM}.git"

# 1. Verify gh is authed as the configured identity (the forking account).
active_user="$(gh api user --jq .login 2>/dev/null || true)"
if [[ "$active_user" != "$CARTOGRAPH_GITHUB_USER" ]]; then
  echo "fork-setup: gh active user is '$active_user', expected '$CARTOGRAPH_GITHUB_USER'" >&2
  echo "fork-setup: run 'gh auth switch -u $CARTOGRAPH_GITHUB_USER' (or 'gh auth login' to add the account)" >&2
  exit 1
fi

# 2. Fork (no-op if $FORK_OWNER/<repo> already exists).
echo "fork-setup: forking $UPSTREAM → $FORK_OWNER/$REPO_NAME"
gh repo fork "$UPSTREAM" --clone=false >/dev/null

# 3. Clone via the configured SSH host alias.
if [[ -d "$DEST/.git" ]]; then
  echo "fork-setup: $DEST already cloned; skipping clone."
else
  echo "fork-setup: cloning to $DEST"
  git clone "$ORIGIN_URL" "$DEST"
fi

cd "$DEST"

# 4. Per-repo git config.
git config user.name        "$CARTOGRAPH_GIT_USER_NAME"
git config user.email       "$CARTOGRAPH_GIT_USER_EMAIL"
if [[ -n "${CARTOGRAPH_SSH_COMMAND:-}" ]]; then
  git config core.sshCommand "$CARTOGRAPH_SSH_COMMAND"
else
  git config --unset core.sshCommand 2>/dev/null || true
fi
git config commit.gpgsign   false
git config pull.rebase      true
git config --unset-all commit.template 2>/dev/null || true

# 5. Reconcile remotes (idempotent). origin always exists post-clone, so
# set-url keeps it correct on re-runs where the host alias changed.
git remote set-url origin "$ORIGIN_URL"
if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$UPSTREAM_URL"
else
  git remote add upstream "$UPSTREAM_URL"
fi

# 6. Install hooks. The hook templates carry __GIT_EMAIL__, __SSH_HOST_ALIAS__,
# __GITHUB_USER__, __FORBIDDEN_REGEX__, and __COAUTHOR_REGEX__ placeholders that
# get baked in here. Hooks run in a context where cartograph.env isn't sourced,
# so the values must be substituted at install time.
forbidden_regex='cartograph|claude code|claude opus|claude sonnet|claude haiku|anthropic'
coauthor_regex='[Cc]laude|[Aa]nthropic|[Cc]artograph'
if [[ -n "${CARTOGRAPH_FORBIDDEN_EXTRAS:-}" ]]; then
  IFS=',' read -r -a _extras <<< "$CARTOGRAPH_FORBIDDEN_EXTRAS"
  for _w in "${_extras[@]}"; do
    _w="${_w## }"; _w="${_w%% }"
    if [[ -n "$_w" ]]; then
      _esc="$(printf '%s' "$_w" | sed 's/[][\\/.*^$()+?{|]/\\&/g')"
      forbidden_regex="${forbidden_regex}|${_esc}"
      coauthor_regex="${coauthor_regex}|${_esc}"
    fi
  done
fi

render_hook() {  # $1 = source path, $2 = dest path
  # Delimiter is '#' not '|': the forbidden/coauthor regexes contain '|'
  # alternations, which would otherwise terminate an "s|...|...|" replacement.
  sed -e "s#__GITHUB_USER__#$CARTOGRAPH_GITHUB_USER#g" \
      -e "s#__GIT_EMAIL__#$CARTOGRAPH_GIT_USER_EMAIL#g" \
      -e "s#__SSH_HOST_ALIAS__#$CARTOGRAPH_SSH_HOST_ALIAS#g" \
      -e "s#__FORBIDDEN_REGEX__#$forbidden_regex#g" \
      -e "s#__COAUTHOR_REGEX__#$coauthor_regex#g" \
      "$1" > "$2"
  chmod 0755 "$2"
}
render_hook "$TEMPLATES/hooks/commit-msg" "$DEST/.git/hooks/commit-msg"
render_hook "$TEMPLATES/hooks/pre-push"   "$DEST/.git/hooks/pre-push"

# 7. Per-fork CLAUDE.md (working-tree, never committed). The template carries
# __GITHUB_USER__ / __GIT_EMAIL__ / __SSH_HOST_ALIAS__ placeholders that
# get substituted from cartograph.env so each operator's fork ends up
# config-correct.
sed -e "s|__GITHUB_USER__|$CARTOGRAPH_GITHUB_USER|g" \
    -e "s|__GIT_EMAIL__|$CARTOGRAPH_GIT_USER_EMAIL|g" \
    -e "s|__SSH_HOST_ALIAS__|$CARTOGRAPH_SSH_HOST_ALIAS|g" \
    "$TEMPLATES/CLAUDE.md" > "$DEST/CLAUDE.md"

# 8. Exclude CLAUDE.md from git locally.
EXCLUDE_FILE="$DEST/.git/info/exclude"
mkdir -p "$(dirname "$EXCLUDE_FILE")"
touch "$EXCLUDE_FILE"
if ! grep -qxF 'CLAUDE.md' "$EXCLUDE_FILE"; then
  echo 'CLAUDE.md' >> "$EXCLUDE_FILE"
fi
# Remove any stale .cartographrc exclude entry from older bootstraps.
if grep -qxF '.cartographrc' "$EXCLUDE_FILE"; then
  sed -i.bak '/^\.cartographrc$/d' "$EXCLUDE_FILE"
  rm -f "${EXCLUDE_FILE}.bak"
fi

# 9. Drop bedrock guide stubs and create topics/ dir under guides/<repo>/.
REPO_GUIDES="$GUIDES/$REPO_NAME"
mkdir -p "$REPO_GUIDES/topics"
TODAY="$(date +%Y-%m-%d)"
for layer in overview architecture conventions; do
  out="$REPO_GUIDES/$layer.md"
  if [[ ! -f "$out" ]]; then
    sed -e "s#REPO_NAME#$REPO_NAME#g" \
        -e "s#UPSTREAM#$UPSTREAM#g" \
        -e "s#TODAY_DATE#$TODAY#g" \
        "$TEMPLATES/$layer.md" > "$out"
  fi
done

# 9b. Record the new repo in the cross-repo seams doc. Seam *content* needs real
# code understanding (written by hand / via `/seam`), but at least make seams.md
# acknowledge the repo so it stops reading as "not set up" and prompts filling in
# the edges. Idempotent: only appends when the repo isn't already mentioned.
SEAMS="$GUIDES/seams.md"
if [[ -f "$SEAMS" ]] && ! grep -qiE "(^|[^[:alnum:]])$REPO_NAME([^[:alnum:]]|$)" "$SEAMS"; then
  {
    printf '\n## %s → ? (stub — fill in)\n\n' "$REPO_NAME"
    printf '> Added by fork-setup on %s. **%s** is now a tracked repo but its\n' "$TODAY" "$REPO_NAME"
    printf '> cross-repo seams are not documented yet. Replace this stub: what does\n'
    printf '> %s consume / what consumes it? Cite `path:NNN` anchors, or run\n' "$REPO_NAME"
    printf '> `/seam %s <other-repo>` to fill it in.\n' "$REPO_NAME"
  } >> "$SEAMS"
  echo "fork-setup: appended a seam stub for '$REPO_NAME' to guides/seams.md (fill it in)"
fi

# 10. Migrate legacy flat conventions stub if it exists (from older bootstrap).
LEGACY="$GUIDES/${REPO_NAME}-conventions.md"
if [[ -f "$LEGACY" ]]; then
  # If the new conventions.md is still the stub (untouched), prefer it (already in place).
  # Either way, remove the legacy flat file.
  rm -f "$LEGACY"
fi

# 11. Report.
cat <<EOF

fork-setup: configured $REPO_NAME
  user.name       = $(git config user.name)
  user.email      = $(git config user.email)
  core.sshCommand = $(git config core.sshCommand)
  origin          = $(git remote get-url origin)
  upstream        = $(git remote get-url upstream)
  hooks           = $(ls -1 .git/hooks | grep -E '^(commit-msg|pre-push)$' | tr '\n' ' ')
  excluded        = $(grep -E '^CLAUDE.md$' .git/info/exclude | tr '\n' ' ')
  bedrock         = $(ls -1 "$REPO_GUIDES"/*.md 2>/dev/null | xargs -I{} basename {} | tr '\n' ' ')
  topics dir      = $REPO_GUIDES/topics/
EOF
