# Todo

**Current state: clean checkpoint.** All features below are shipped and verified (backend compiles, frontend lints at the 13-problem baseline, each feature checked against real data in the browser or via curl). Nothing is broken or half-finished. The one open item is that **none of this session's work is committed to git yet** — see "Uncommitted changes" below.

Read `tasks/lessons.md` before touching anything — several of its entries (StrictMode focus-clearing, migration races, no-use-before-define) will save you from re-discovering the same bugs.

## Uncommitted changes (as of 2026-08-07)

Everything below is sitting in the working tree, not yet committed. Confirmed via `git status` — do not trust older notes in this file about which files changed, they were stale.

**Backend, modified**: `ai_service.py`, `app.py`, `catalog/db.py`, `harvest.py`, `s2d/db.py`, `scheduler.py`, `catalog.db` (real data), `local_data_*.duckdb` (real data).

**Frontend, restructured**: the old flat `Frontend/src/components/*.jsx` (9 page files + all sub-components) were **deleted** and rebuilt under `Frontend/src/pages/` and `Frontend/src/components/{connect,catalog,s2d,schedules}/` — this is an intentional move (see "Frontend folder restructure" entry below), not data loss. Also modified: `App.jsx`, `api.js`. New: `scheduleFormat.js`.

When ready to commit, this represents ~10 distinct features shipped across one long session (full changelog below) — consider whether to squash into one commit or split by feature using the dated section headers below as natural boundaries.

## Feature changelog (newest first)

### AI-suggested rule dedup — 2026-08-07

All 3 "AI Suggest Rules" sample-based flows (single-table, column-parity, cross-table-parity) now avoid duplicating rules on repeat clicks. Two layers: a prompt-level nudge (tell the AI what's already covered) plus a hard dedup-on-save guarantee (skip any AI-proposed rule whose signature already exists, regardless of what the AI does). If everything proposed was a duplicate, the response includes an explicit `message` the UI surfaces distinctly instead of a silent "0 created."

- `ai_service.py`: `_already_covered_section()` shared helper + `already_covered_text` param on all 3 prompt builders and their public functions.
- `app.py`: all 3 `ai/suggest-*` routes build a signature set from existing test cases before calling the AI (column-pair signature for parity, key-column signature for cross-table-parity, name-based for single-table), skip matches as `"Duplicate of an existing rule"`, add `message` when `created` is empty but the AI proposed something.
- `TestCasePanel.jsx`: `message` threaded through all 3 summary states, shown as a distinct info callout.
- **Verified against real data**: ran the actual flow 4× in a row against a live mapping (`Bronze to silver`) — 30 total rules, zero duplicate signatures, confirmed by direct signature-collision check.

### Cascade-delete + schema-driven SQL templates — 2026-08-06

**Cascade delete**: `delete_mapping()` now cascades to `s2d_test_suites` / `s2d_test_suite_cases` / `s2d_suite_schedules`, not just `s2d_test_cases` as before. `app.py`'s delete route deregisters live APScheduler jobs *before* the cascade (avoids a circular import between `s2d/db.py` and `scheduler.py`). Run history is deliberately not cascaded. Verified with a full throwaway fixture — all 5 dependent rows confirmed gone, scheduler job confirmed deregistered.

**Schema-driven templates**: 9 of 10 `PREBUILT_TEMPLATES` in `TestCasePanel.jsx` (all but `custom_sql`) now render table/column dropdowns instead of `<table_name>`/`<column_name>` placeholders the tester had to hand-edit. Dropdowns source from `sourceSchema`/`destinationSchema`, already fetched live — zero new network cost. SQL is assembled automatically, shown read-only. `categorical_check` also upgraded from a fixed 3-value slot to an arbitrary comma-separated list. Known limitation: editing an existing template-built test case falls back to raw-text edit (provenance isn't stored, only the final SQL).

### Five UX/workflow improvements — 2026-08-05

1. Validation selector on Test Suites page (filter by mapping or "All Validations").
2. "Add to Suite" redesigned into "Edit Suite Membership" — picking a suite pre-checks its current members, freely toggle to add/remove, full-replace on save. Per-row Run/Edit/Delete added to Test Suites page's test-case table. "Edit Suite" button cross-navigates to S2D pre-targeted at that suite.
3. Catalog is now connector-scoped: `harvested_assets` gained `connector_id` (additive migration + backfill), threaded through the whole harvest pipeline, Catalog page gained a connector selector — needed for when a second connector of the same type exists.
4. "Mapping" → "Validation" in every user-facing string (not internal names/routes).

**Real bug found & fixed**: the cross-page "focus" handoff (Edit Suite/Edit Test Case buttons) silently failed under React 18 StrictMode's dev-only double-mount check — fixed by not auto-clearing the trigger right after consuming it (see `tasks/lessons.md`). Also fixed two real `no-use-before-define` ESLint violations by reordering, not suppressing.

### Frontend folder restructure — 2026-08-04

Flat `Frontend/src/components/*.jsx` (16 files) reorganized into `pages/` (9 routed pages) and `components/{connect,catalog,s2d,schedules}/` (7 shared widgets, grouped by owning domain). Pure file-move + import-path fix, confirmed via `git status` dependency grep before moving anything — no logic changed. Also renamed "Mapping" nav tab → "Validation Setup" and the generic "Fabrics" mapping → "Public Holidays ID Enrichment Check"; added mapping rename support.

### Harvest filtering + Mapping/Suite workflow restructure — 2026-07-31

Harvest now only shows Lakehouse/Warehouse/DataPipeline for Fabric connectors (was showing every item type). New **Validation Setup** tab (originally "Mapping") owns mapping creation + empty test-suite creation; S2D tab keeps only a lightweight mapping dropdown. "Run Integration Test Pipeline" removed, replaced by "Add Test Cases to Test Suite".

### Global Schedules Dashboard, Harvest schedule editing/refresh, Scheduled Runs, Test Suites — 2026-07-29 to 2026-07-30

Built the whole scheduling subsystem: APScheduler in-process (`scheduler.py`), suite + harvest schedules with coalesce/skip semantics, a visual cron/preset picker (`SchedulePicker.jsx`), per-schedule edit/refresh/delete, and a flat cross-cutting dashboard (`SchedulesDashboard.jsx`). Built Test Suites as a first-class concept (`s2d_test_suites`/`s2d_test_suite_cases`) with run/schedule/edit-membership support. See `tasks/lessons.md` for the StrictMode and migration-ordering lessons learned building this.

## Backlog (explicitly out of scope until asked)

- `AnalyticsPage.jsx` "Trends" and "Scorecard" tabs — disabled stubs, no data model yet.
- "Isolate Bad Rows" button on `AnalyticsPage.jsx` — disabled, drill-down never implemented.
- PySpark test-case execution — `script_type='pyspark'` returns ERROR "not wired up yet".
- No automated test suite (pytest/jest) — verification has been manual throughout.
- Cross-mapping test suites (would need engine changes since runs are per-mapping).
- Editing a harvest schedule's `selected_items` inline (today: edit trigger only; refresh adds new items; delete + recreate to remove items).
- `PATCH /api/s2d/suites/<id>` still rejects an empty `test_case_ids` list — a suite can't be emptied via that endpoint (only relevant if "remove all test cases from suite" is requested).

## Reference docs

- `HANDOFF.md` (repo root) — authoritative history of the original S2D Parts 1–4 build (pre-dates this session's work).
- `README.md` (repo root) — architecture overview, connector abstraction, operational gotchas (plaintext secrets, SELECT-only guard, T-SQL vs DuckDB SQL dialect).
- Plan files for every feature above are saved at `C:\Users\shlok164201\.claude\plans\bubbly-honking-russell.md` (overwritten per-feature — only the most recent plan survives there; this todo.md is the durable record).
