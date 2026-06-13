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

## v2026.06.13

### Fixed

- **launchd supervision can no longer drift.** Previously a detached
  server started outside launchd (by a restart helper) could win the
  listen port and lock the supervisor into bind-fail backoff —
  supervision silently disabled while the site still worked. Now a single
  supervision-aware control layer (`scripts/lib/serve-control.sh`) routes
  every start/restart through `launchctl` when the agent is installed, so
  no competing detached process is ever spawned.
- The error logger was silently a no-op when its lib was sourced from a
  non-bash shell (it resolved its path via `BASH_SOURCE`); now anchored to
  the project root, so drift repairs are always recorded.

### Added

- **Supervision self-heal**: `cg_serve_heal` runs at SessionStart and in
  nightly maintenance — if an orphan holds the port or the server is down,
  it clears the holder, re-binds launchd, and logs the repair.
  `scripts/doctor.sh` gained a report-only supervision check (OK / drift /
  down), and SessionStart warns the error feed if the nightly maintenance
  pass goes stale (>36h).
- **Data-driven seam graph**: new `GET /api/seams-graph` derives the graph
  from the live tracked-repo list + `guides/seams.md`; the `/seams/`
  visualization fetches it and lays out a deterministic radial graph (hub =
  most-connected repo). It auto-updates as forks are added/removed — no
  hand-maintained node list.

### Changed

- The published presentation reads as a general-purpose framework: the
  about page, README, operational docs, and all slash-command help no
  longer enumerate specific tracked repos (use `<repo>` / "a tracked
  fork"). The seam graph and adjacency view are data-driven, so a forked
  instance shows its own repos rather than this one's.

---

## v2026.06.12

### Added

- **Drift auto-fix loop**: the server now resolves open drift reports on
  an interval (default 30 min) — repo-level reports via the auto-revise
  path, per-topic reports via the per-citation fixer — instead of waiting
  for a manual `/auto-revise` or the nightly maintenance pass. New
  `scripts/drift-drain.sh` runs one pass over all open reports and stops
  early when the agent cap is occupied; deferred reports retry next pass.
  Toggle with `CARTOGRAPH_DRIFT_AUTOFIX`, interval via
  `CARTOGRAPH_DRIFT_AUTOFIX_INTERVAL` (both in the settings UI).
- **Auto-review pipeline**: `scripts/auto-review-scan.sh` enqueues notes
  awaiting review (≤12 per scan); the batched curation agent judges each
  against the quality bar with anchor spot-checks, writes UI-readable
  opinions, and at high confidence auto-acts (`rejected: true` for
  concrete defects, `superseded_by` for near-duplicate episodes). Runs
  at SessionStart and in nightly maintenance, under the single-agent
  concurrency cap. Files are never deleted.

### Changed

- Review surfaces hide auto-approved notes (`auto_approved_hidden` count
  in the payload); contested reject opinions stay visible, pre-annotated.
  An opinion older than the note's last edit is void.
- Anti-bloat retrieval: rejected notes leave the BM25 corpus, reverse
  index, and injection menus; superseded episodes leave BM25 + menus.

### Fixed

- The per-topic drift fixer now routes through the global headless-agent
  cap — it previously spawned `claude -p` directly, uncapped and outside
  the recursion guard. When the cap is occupied it reports `deferred`
  and keeps the report for a later pass instead of erroring.
- Query language `!key` now treats explicit boolean `false` as unset.
  The canonical template writes `rejected: false`, so `!rejected`
  matched nothing and the review queue had been silently empty — the
  root cause of zero rejections ever being recorded.

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
