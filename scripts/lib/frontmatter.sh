#!/usr/bin/env bash
# Frontmatter helpers — read/write YAML frontmatter fields in markdown files.
# Source this (don't execute). BSD-tool-compatible (no gawk-isms).

# Read a single field from the frontmatter of a markdown file.
# Usage: fm_get <file> <field>
# Returns: value (empty if absent or null/`~`).
fm_get() {
  local file="$1" field="$2"
  [[ -f "$file" ]] || return 0
  # Extract the frontmatter block (between the first two `---` lines).
  local block
  block="$(sed -n '/^---[[:space:]]*$/,/^---[[:space:]]*$/p' "$file" 2>/dev/null | sed '1d;$d')"
  [[ -z "$block" ]] && return 0
  # Find the field line, strip the prefix, strip trailing comment, unquote, normalize null.
  echo "$block" \
    | grep -E "^[[:space:]]*${field}[[:space:]]*:" \
    | head -1 \
    | sed -E "s/^[[:space:]]*${field}[[:space:]]*:[[:space:]]*//" \
    | sed -E 's/[[:space:]]*#.*$//' \
    | sed -E 's/[[:space:]]+$//' \
    | sed -E 's/^"([^"]*)"$/\1/' \
    | sed -E "s/^'([^']*)'$/\1/" \
    | sed -E 's/^~$//'
}

# Set (or insert) a single field in the frontmatter of a markdown file.
# Usage: fm_set <file> <field> <value>
fm_set() {
  local file="$1" field="$2" value="$3"
  [[ -f "$file" ]] || return 1

  local tmp="${file}.fm.tmp"
  awk -v field="$field" -v value="$value" '
    BEGIN { in_fm = 0; seen_open = 0; updated = 0 }
    NR == 1 && /^---[[:space:]]*$/ { in_fm = 1; seen_open = 1; print; next }
    in_fm && /^---[[:space:]]*$/ {
      if (!updated) { print field ": " value }
      print
      in_fm = 0
      next
    }
    in_fm && $0 ~ "^[[:space:]]*" field "[[:space:]]*:" {
      print field ": " value
      updated = 1
      next
    }
    { print }
    END {
      if (!seen_open) exit 2
    }
  ' "$file" > "$tmp" && mv "$tmp" "$file"
}
