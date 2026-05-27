#!/usr/bin/env bash
# scripts/lib/load-config.sh — source from other bash scripts.
#
# Resolves CARTOGRAPH_ROOT from the sourcing script's location, loads
# cartograph.env if present, and sets defaults for optional keys.
#
# Real environment variables win over file values (set -a + source +
# setdefault semantics handled here: env-already-set is preserved).
#
# Usage:
#   source "$(dirname "$0")/lib/load-config.sh"

if [[ -z "${CARTOGRAPH_ROOT:-}" ]]; then
  # This lib lives at scripts/lib/load-config.sh — root is two levels up.
  CARTOGRAPH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

if [[ -f "$CARTOGRAPH_ROOT/cartograph.env" ]]; then
  # Read each KEY=value; only set if not already in the environment, so a
  # parent-process override wins.
  while IFS= read -r _cg_line || [[ -n "$_cg_line" ]]; do
    _cg_line="${_cg_line%$'\r'}"
    [[ -z "${_cg_line// }" || "${_cg_line#"${_cg_line%%[![:space:]]*}"}" == \#* ]] && continue
    [[ "$_cg_line" != *=* ]] && continue
    _cg_key="${_cg_line%%=*}"
    _cg_key="${_cg_key#"${_cg_key%%[![:space:]]*}"}"   # ltrim
    _cg_key="${_cg_key%"${_cg_key##*[![:space:]]}"}"   # rtrim
    _cg_val="${_cg_line#*=}"
    # Strip one matching pair of surrounding quotes.
    if [[ "$_cg_val" =~ ^\".*\"$ ]]; then
      _cg_val="${_cg_val:1:${#_cg_val}-2}"
    elif [[ "$_cg_val" =~ ^\'.*\'$ ]]; then
      _cg_val="${_cg_val:1:${#_cg_val}-2}"
    fi
    if [[ -z "${!_cg_key+x}" ]]; then
      printf -v "$_cg_key" '%s' "$_cg_val"
      export "$_cg_key"
    fi
  done < "$CARTOGRAPH_ROOT/cartograph.env"
  unset _cg_line _cg_key _cg_val
fi

: "${CARTOGRAPH_SSH_HOST_ALIAS:=github.com}"
: "${CARTOGRAPH_FORBIDDEN_EXTRAS:=}"
export CARTOGRAPH_ROOT CARTOGRAPH_SSH_HOST_ALIAS CARTOGRAPH_FORBIDDEN_EXTRAS
