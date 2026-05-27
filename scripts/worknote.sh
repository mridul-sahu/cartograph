#!/usr/bin/env bash
# scripts/worknote.sh — advisory lease for parallel agents.
#
# Writes/reads/removes .cartograph/in-flight/<slug>.md so concurrent
# agents can see who's mid-revision on a topic. Soft / cooperative;
# nothing enforces compliance — callers (slash commands, auto-scripts)
# check before mutating.
#
# Usage:
#   worknote.sh acquire <slug> [--intent "<text>"] [--ttl <minutes>]
#   worknote.sh release <slug>
#   worknote.sh status [<slug>]
#
# Exit codes:
#   0 — acquired / released / status fine
#   75 (EX_TEMPFAIL) — fresh lease exists on `acquire`
#   2 — bad usage
#
# Design: claude-designs/cartograph/worknote-lease/README.md

set -uo pipefail

CARTOGRAPH_ROOT="${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}"
LEASE_DIR="$CARTOGRAPH_ROOT/.cartograph/in-flight"
DEFAULT_TTL="${CARTOGRAPH_WORKNOTE_TTL:-30}"

mkdir -p "$LEASE_DIR"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date +%s; }

# Read the acquired_at and ttl_minutes; return 0 if lease is fresh.
# Strip only the first `key:` prefix — ISO timestamps contain colons.
is_fresh() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  local acquired_at ttl_min acquired_epoch now expiry
  acquired_at="$(sed -nE 's/^acquired_at:[[:space:]]*//p' "$file" | head -1)"
  ttl_min="$(sed -nE 's/^ttl_minutes:[[:space:]]*//p' "$file" | head -1)"
  [[ -z "$acquired_at" || -z "$ttl_min" ]] && return 1
  # macOS-friendly ISO → epoch.
  acquired_epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$acquired_at" +%s 2>/dev/null \
                    || date -u -d "$acquired_at" +%s 2>/dev/null \
                    || echo 0)"
  [[ "$acquired_epoch" -eq 0 ]] && return 1
  now="$(now_epoch)"
  expiry=$((acquired_epoch + ttl_min * 60))
  [[ "$now" -lt "$expiry" ]]
}

acquire() {
  local slug="$1" intent="$2" ttl="$3"
  local file="$LEASE_DIR/$slug.md"
  if [[ -f "$file" ]]; then
    if is_fresh "$file"; then
      printf 'worknote: lease busy → %s\n' "$file" >&2
      cat "$file" >&2
      return 75
    fi
    # stale — reap and proceed
    rm -f "$file"
  fi
  cat > "$file" <<EOF
---
slug: $slug
acquired_at: $(now_iso)
pid: $$
agent: ${USER:-unknown}
intent: ${intent:-(unspecified)}
ttl_minutes: $ttl
---
EOF
  printf '%s\n' "$file"
}

release() {
  local slug="$1"
  local file="$LEASE_DIR/$slug.md"
  rm -f "$file"
}

status_one() {
  local slug="$1"
  local file="$LEASE_DIR/$slug.md"
  if [[ ! -f "$file" ]]; then
    echo "no lease for $slug"
    return 0
  fi
  if is_fresh "$file"; then
    echo "▸ fresh lease — $file"
    cat "$file"
  else
    echo "▸ stale lease (will be reaped on next acquire) — $file"
    cat "$file"
  fi
}

status_all() {
  shopt -s nullglob
  local files=( "$LEASE_DIR"/*.md )
  if [[ ${#files[@]} -eq 0 ]]; then
    echo "no active leases"
    return 0
  fi
  for f in "${files[@]}"; do
    if is_fresh "$f"; then
      echo "▸ fresh   ${f#$CARTOGRAPH_ROOT/}"
    else
      echo "▸ stale   ${f#$CARTOGRAPH_ROOT/}"
      rm -f "$f"
    fi
  done
}

usage() {
  sed -n 's/^# \?//; 3,16p' "$0"
  exit 2
}

cmd="${1:-}"
case "$cmd" in
  acquire)
    slug="${2:-}"; [[ -z "$slug" ]] && usage
    intent=""
    ttl="$DEFAULT_TTL"
    shift 2
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --intent) intent="${2:-}"; shift 2 ;;
        --ttl)    ttl="${2:-$DEFAULT_TTL}"; shift 2 ;;
        *) shift ;;
      esac
    done
    acquire "$slug" "$intent" "$ttl"
    ;;
  release)
    slug="${2:-}"; [[ -z "$slug" ]] && usage
    release "$slug"
    ;;
  status)
    if [[ -n "${2:-}" ]]; then
      status_one "$2"
    else
      status_all
    fi
    ;;
  *)
    usage
    ;;
esac
