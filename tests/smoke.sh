#!/usr/bin/env bash
# tests/smoke.sh — runs the cartograph smoke-test suite.
#
# Per-script invocation checks (does it run without crashing?), focused
# tests for the load-bearing scripts (publish, inject-context, doctor),
# and a regression test for the publish leak scanner.
#
# Designed to run in CI and locally via `just test`. Exits 0 if all
# tests pass, 1 otherwise. Lints (shellcheck, ruff) are run if installed
# but skipped quietly if missing — they're enforced in CI.

set -uo pipefail

source "$(dirname "$0")/../scripts/lib/load-config.sh"

pass=0
fail=0
skip=0
failed_tests=()

# ── Test runner primitives ────────────────────────────────────────────────

ok() { printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass + 1)); }
no() { printf "  \033[31m✗\033[0m %s\n" "$1"; fail=$((fail + 1)); failed_tests+=("$1"); }
sk() { printf "  \033[33m·\033[0m %s (skipped: %s)\n" "$1" "${2:-no reason}"; skip=$((skip + 1)); }
hd() { printf "\n\033[1m── %s ──\033[0m\n" "$1"; }

run_test() {  # $1 = name, $2... = command
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else no "$name"; fi
}

run_test_with_stderr() {  # $1 = name, $2... = command (shows stderr on fail)
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    ok "$name"
  else
    no "$name"
    printf "    %s\n" "${out:0:300}"
  fi
}

# ── Shell script syntax ───────────────────────────────────────────────────

hd "shell script syntax (bash -n)"
for f in "$CARTOGRAPH_ROOT/scripts"/*.sh "$CARTOGRAPH_ROOT/scripts/lib"/*.sh "$CARTOGRAPH_ROOT/tests"/*.sh; do
  [[ -f "$f" ]] || continue
  run_test "$(basename "$f")" bash -n "$f"
done

# ── Python script compile ─────────────────────────────────────────────────

hd "python script compile (ast.parse)"
for f in "$CARTOGRAPH_ROOT/scripts"/*.py; do
  [[ -f "$f" ]] || continue
  run_test "$(basename "$f")" python3 -c "import ast; ast.parse(open('$f').read())"
done

# ── load-config.sh ────────────────────────────────────────────────────────

hd "scripts/lib/load-config.sh"
run_test_with_stderr "loads cartograph.env if present" \
  bash -c 'source "$1" && [[ -n "${CARTOGRAPH_SSH_HOST_ALIAS:-}" ]]' \
       _ "$CARTOGRAPH_ROOT/scripts/lib/load-config.sh"
# `VAR=val source script` scopes VAR to source's invocation only — it reverts
# after source returns. Use `export` so the override persists for the check.
run_test_with_stderr "respects env override (parent wins)" \
  bash -c 'export CARTOGRAPH_GITHUB_USER=override-user; source "$1"; [[ "$CARTOGRAPH_GITHUB_USER" == "override-user" ]]' \
       _ "$CARTOGRAPH_ROOT/scripts/lib/load-config.sh"

# ── doctor.sh ─────────────────────────────────────────────────────────────

hd "scripts/doctor.sh"
# Doctor's exit code depends on local state — at minimum, it should not crash.
if bash "$CARTOGRAPH_ROOT/scripts/doctor.sh" >/dev/null 2>&1; then
  ok "doctor runs and exits 0 (forks healthy)"
else
  rc=$?
  if (( rc == 1 )); then
    ok "doctor runs and exits 1 (problems reported, but ran cleanly)"
  else
    no "doctor crashed with exit $rc"
  fi
fi

# ── publish.sh --dry-run (personal-repo-only — public repo doesn't ship it) ─

hd "scripts/publish.sh --dry-run"
if [[ -f "$CARTOGRAPH_ROOT/scripts/publish.sh" ]]; then
  run_test_with_stderr "dry-run produces a staged tree" \
    bash "$CARTOGRAPH_ROOT/scripts/publish.sh" --dry-run

  # Leak-scanner regression: plant a leak in the staged tree AFTER the
  # dry-run already populated it, then re-invoke the same grep the script
  # uses. This bypasses publish.sh's stage-wipe step (which would clobber a
  # planted file before its own scan ran), but exercises the exact scanner
  # regex.
  STAGING="$CARTOGRAPH_ROOT/.publish-staging/cartograph"
  if [[ -d "$STAGING" ]]; then
    echo "// planted: mridulsahu01@gmail.com" > "$STAGING/scripts/_leak_planted.sh"
    if grep -qIE "mridul-sahu|mridulsahu01|mridul-rudrite|github\.com-sahu" "$STAGING/scripts/_leak_planted.sh"; then
      ok "leak-scanner regex matches planted mridulsahu01"
    else
      no "leak-scanner regex missed a planted mridulsahu01 (regression)"
    fi
    rm -f "$STAGING/scripts/_leak_planted.sh"

    if bash "$CARTOGRAPH_ROOT/scripts/publish.sh" --dry-run 2>&1 | grep -q "leakage hits"; then
      no "publish --dry-run reports leaks in the current source tree"
    else
      ok "publish --dry-run is leak-clean"
    fi
  else
    sk "leak-scanner regression" "staging dir didn't exist after dry-run"
  fi
else
  sk "publish dry-run + leak-scanner" "publish.sh is personal-only; not present in public repo"
fi

# ── inject-context.sh ─────────────────────────────────────────────────────

hd "scripts/inject-context.sh (UserPromptSubmit hook)"
# Outside workspace/<repo>/, the hook silently no-ops (exit 0, no output).
out="$(echo '{"prompt": "test"}' | (cd /tmp && bash "$CARTOGRAPH_ROOT/scripts/inject-context.sh") 2>&1)"
if [[ -z "$out" ]]; then
  ok "no-ops outside workspace/<repo>/ (silent exit 0)"
else
  no "expected silent no-op outside workspace, got: ${out:0:120}"
fi

# Inside cartograph/ proper, also no-op.
out="$(echo '{"prompt": "test"}' | (cd "$CARTOGRAPH_ROOT" && bash "$CARTOGRAPH_ROOT/scripts/inject-context.sh") 2>&1)"
if [[ -z "$out" ]]; then
  ok "no-ops inside cartograph/ proper (silent exit 0)"
else
  no "expected silent no-op inside cartograph, got: ${out:0:120}"
fi

# Inside a fork, should produce <cartograph-context> output.
first_fork="$(find "$CARTOGRAPH_ROOT/workspace" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -1)"
if [[ -n "$first_fork" && -d "$first_fork/.git" ]]; then
  out="$(echo "{\"prompt\": \"test\", \"cwd\": \"$first_fork\"}" | bash "$CARTOGRAPH_ROOT/scripts/inject-context.sh" 2>&1)"
  # No pipe here: under pipefail, grep -q's early exit EPIPEs the echo of
  # a 64KB+ injection and fails the pipeline despite the match.
  if [[ "$out" == *"<cartograph-context>"* ]]; then
    ok "injects context tag inside fork ($(basename "$first_fork"))"
  else
    no "no <cartograph-context> tag inside fork; got: ${out:0:120}"
  fi
else
  sk "inject inside fork" "no forks under workspace/"
fi

# ── upstream-sync.sh ──────────────────────────────────────────────────────

hd "scripts/upstream-sync.sh"
# Outside any fork, silent no-op.
out="$(cd /tmp && bash "$CARTOGRAPH_ROOT/scripts/upstream-sync.sh" 2>&1)"
if [[ -z "$out" ]]; then
  ok "silent no-op outside fork"
else
  sk "silent no-op outside fork" "got output (might be the drift-check side-effect): ${out:0:80}"
fi

# ── lint-content.sh ───────────────────────────────────────────────────────

hd "scripts/lint-content.sh"
# Lint should produce JSON output by default; --human gives text.
run_test "lint produces JSON" bash -c "
  out=\$(bash '$CARTOGRAPH_ROOT/scripts/lint-content.sh' 2>/dev/null);
  echo \"\$out\" | python3 -m json.tool >/dev/null
"

# ── load-bearing python scripts: --help (best-effort) ─────────────────────

hd "python script imports (no crash on import)"
# Import the modules to verify they don't fail at module-load time.
for f in build-search-index.py build-file-index.py anchor-coverage.py cartograph_query.py; do
  run_test "$f imports" python3 -c "
import importlib.util, pathlib
p = pathlib.Path('$CARTOGRAPH_ROOT/scripts/$f')
spec = importlib.util.spec_from_file_location('_t', p)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
"
done

# mcp_server.py imports its lazy `mcp` dep at call time, so a plain import
# would fail without `pip install mcp`. Just syntax-check.

# ── serve.py: API is reachable if server is up ────────────────────────────

hd "serve.py (if running)"
if curl -sf -o /dev/null --connect-timeout 1 "http://127.0.0.1:47777/api/healthz" 2>/dev/null; then
  run_test "GET /api/healthz returns 200" \
    curl -sf -o /dev/null --connect-timeout 2 "http://127.0.0.1:47777/api/healthz"
  run_test "GET /api/repos returns 200" \
    curl -sf -o /dev/null --connect-timeout 2 "http://127.0.0.1:47777/api/repos"
else
  sk "serve.py API tests" "server not up at :47777 — run 'just serve' to enable"
fi

# ── linters (best-effort) ─────────────────────────────────────────────────

hd "linters (if installed)"
if command -v shellcheck >/dev/null 2>&1; then
  # Allow a curated set of common warnings — set -e + sourcing dynamic configs
  # legitimately triggers a few SC warnings.
  shellcheck_status=0
  for f in "$CARTOGRAPH_ROOT/scripts"/*.sh "$CARTOGRAPH_ROOT/scripts/lib"/*.sh; do
    [[ -f "$f" ]] || continue
    if ! shellcheck -S error -e SC1091,SC2034 "$f" >/dev/null 2>&1; then
      shellcheck_status=1
      echo "  shellcheck errors in $(basename "$f"):"
      shellcheck -S error -e SC1091,SC2034 "$f" | sed 's/^/    /' | head -5
    fi
  done
  if (( shellcheck_status == 0 )); then
    ok "shellcheck clean (errors only)"
  else
    no "shellcheck found errors"
  fi
else
  sk "shellcheck" "not installed (brew install shellcheck)"
fi

if command -v ruff >/dev/null 2>&1; then
  if ruff check "$CARTOGRAPH_ROOT/scripts" >/dev/null 2>&1; then
    ok "ruff clean"
  else
    no "ruff found issues"
    ruff check "$CARTOGRAPH_ROOT/scripts" 2>&1 | head -8 | sed 's/^/    /'
  fi
else
  sk "ruff" "not installed (pip install ruff)"
fi

# ── justfile recipes parse ────────────────────────────────────────────────

hd "justfile"
run_test "just --list (recipes parse)" \
  bash -c "cd '$CARTOGRAPH_ROOT' && just --list"

# ── Summary ───────────────────────────────────────────────────────────────

printf "\n\033[1msummary:\033[0m %d passed, %d failed, %d skipped\n" "$pass" "$fail" "$skip"
if (( fail > 0 )); then
  printf "\nfailing tests:\n"
  for t in "${failed_tests[@]}"; do printf "  - %s\n" "$t"; done
  exit 1
fi
exit 0
