#!/usr/bin/env bash
# scripts/build-extension.sh — build the Cartograph VS Code extension,
# package it as a .vsix, and install it into code-server.
#
# Why a .vsix and not just a folder copy: modern code-server / VS Code
# tracks installed extensions in `extensions/extensions.json`. Dropping a
# folder into the extensions dir does NOT register it — it won't load.
# `code-server --install-extension <vsix>` updates that registry.
#
# Usage: bash scripts/build-extension.sh

set -euo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
EXT_SRC="$CARTOGRAPH_ROOT/extensions/cartograph"
EXT_DIR="$CARTOGRAPH_ROOT/.code-server-data/extensions"

cd "$EXT_SRC"

echo "build-extension: npm install"
npm install --silent --no-audit --no-fund

echo "build-extension: bundling (esbuild)"
node esbuild.mjs

echo "build-extension: packaging .vsix (vsce)"
rm -f ./*.vsix
npx --yes @vscode/vsce@latest package \
  --no-dependencies \
  --allow-missing-repository \
  --skip-license \
  -o cartograph.vsix
VSIX="$EXT_SRC/cartograph.vsix"

# Locate code-server.
CODE_SERVER_BIN="$(command -v code-server 2>/dev/null || true)"
if [[ -z "$CODE_SERVER_BIN" ]]; then
  for c in /usr/local/opt/code-server/bin/code-server \
           /opt/homebrew/opt/code-server/bin/code-server; do
    [[ -x "$c" ]] && CODE_SERVER_BIN="$c" && break
  done
fi
if [[ -z "$CODE_SERVER_BIN" ]]; then
  echo "build-extension: code-server not found — install with 'brew install code-server'" >&2
  exit 1
fi

# Uninstall any prior copy, then install the fresh vsix into the same
# extensions dir code-server serves from.
echo "build-extension: installing into code-server"
"$CODE_SERVER_BIN" --extensions-dir "$EXT_DIR" \
  --uninstall-extension cartograph-local.cartograph 2>/dev/null || true
"$CODE_SERVER_BIN" --extensions-dir "$EXT_DIR" \
  --install-extension "$VSIX"

echo "build-extension: done — restart code-server to load it:"
echo "  bash scripts/serve-code-server.sh --stop && bash scripts/serve-code-server.sh"
