# Changelog

Cartograph publishes flat-history snapshots: each release on the
[releases page](https://github.com/mridul-sahu/cartograph/releases) is one
squashed commit that represents the state of the framework at that date.
Browse a tag to read the source as it shipped; diff two tags to see what
changed between releases.

This file summarizes user-visible changes per release. For mechanism
changes (new hooks, internal refactors), the diff is the source of truth.

## Format

Each entry follows the [Keep a Changelog](https://keepachangelog.com/)
spirit, grouped by:

- **Added** — new features
- **Changed** — behavior changes to existing features
- **Deprecated** — features still working but slated for removal
- **Removed** — features deleted in this release
- **Fixed** — bug fixes
- **Security** — vulnerability fixes

## Unreleased

(Forthcoming changes land here, then move under a new dated heading at
publish time.)

---

## v2026.06.11

### Added

- Eval runner detects refusal-shaped results (usage limits, rate limits,
  overloads): flagged `error`, excluded from summaries, surfaced as a
  rerun hint. Per-run `answer_head` snippet recorded for diagnosis.

### Changed

- `CARTOGRAPH_INJECT_DISABLE=1` now disables **every** injection surface
  (prompt-time orientation + pre-Read + pre-Edit augmentation), making
  the eval harness's off arm truly injection-free.
- Eval docs state what the A/B measures (push vs pull retrieval — the
  off arm can still `Read` the notebook) and require a quiet machine.
- launchd agents use neutral `com.cartograph.*` labels; the installer
  migrates installs made under the earlier labels.

---

## v2026.06.10

### Added

- **Golden-question eval harness** (`scripts/eval/`): graded architecture
  questions per repo, run headlessly with orientation on vs off
  (`CARTOGRAPH_INJECT_DISABLE=1`). The per-arm score/turns deltas are the
  regression gate for retrieval changes.
- **Central error feed**: chassis failures append to
  `.cartograph/errors.log`; surfaced via `GET /api/errors` and a console
  panel.
- **launchd supervision** (`scripts/setup-launchd.sh`, macOS): server
  under KeepAlive + a nightly maintenance pass (drift auto-revision,
  lint, anchor fixes, curation drain, session archival via
  `scripts/maintenance.sh`).
- New API: `/api/injection-cost` (per-repo bedrock token budgets),
  `/api/topic/{repo}/{slug}/touch`, `/api/backfill/all`, pagination on
  list endpoints.
- Web: markdown rendering in note views, errors panel, injection-cost
  card, stale-topic touch action, pagination.
- `bin/cgh`: gh wrapper that runs the content-firewall token scan on PR
  titles/bodies before submitting.

### Changed

- **Orientation injection is lean**: top-1 full note + title/summary
  menus per layer (was top-3 full bodies); IDF-weighted ranking with a
  usage-feedback boost/penalty; cross-layer dedup; identifier-aware
  tokenization. ~40% smaller injections on representative prompts.
- Stop-hook usage attribution: a `Read` of an injected note now counts
  as the note being used; per-session records in `usage-log.jsonl`.
- Curation drains account per task — failed tasks stay queued and retry
  (was: whole batch deleted regardless of outcome).
- Drift: per-citation check window widened to ±15 lines; per-topic drift
  merged into the repo report; frontmatter validated before index builds.
- Lint: episode word ceiling enforced; repo-name catch-all tags banned.

### Fixed

- Injection usage counters were silently never recorded (`grep -c`
  double-output corrupted the count arithmetic).
- Empty-array expansion crash in the eval runner under macOS bash 3.2.

---

<!--
Releases are tagged `vYYYY.MM.DD` by `just publish` unless `--tag` is passed.
Add a section per release as you cut them; bump the heading from
"Unreleased" to the dated tag at publish time.

## v2026.05.27

### Added
- …

### Changed
- …
-->
