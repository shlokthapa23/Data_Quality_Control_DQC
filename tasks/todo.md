# Todo

Current state: **clean checkpoint** — no dangling work.

Last major feature (per `HANDOFF.md`): S2D validation Part 4 — multi-table `sql` checks + cross-table key-based parity — shipped and verified. Latest commit `4657bc4` moved cross-table parity execution into Fabric to reduce local compute.

## In-flight (uncommitted working tree)

Modified files (not yet committed):
- `Backend/ai_service.py`, `Backend/app.py`, `Backend/s2d/engine.py` — backend changes
- `Backend/connectors/fabric_connector.py` — small change (~6 lines)
- `Frontend/src/api.js`, `Frontend/src/components/MappingPanel.jsx`, `Frontend/src/components/TestCasePanel.jsx` — frontend changes
- `Backend/check_last_results.py` — new debug script that dumps the last 2 rows of `s2d_test_results`

Purpose of these changes is not documented yet — ask the user before assuming.

## Backlog (from HANDOFF.md, explicitly out of scope until asked)

- `AnalyticsPage.jsx` "Trends" and "Scorecard" tabs — disabled stubs, no data model yet.
- "Isolate Bad Rows" button on `AnalyticsPage.jsx` — disabled, drill-down never implemented.
- PySpark test-case execution — `script_type='pyspark'` returns ERROR "not wired up yet".
- No automated test suite (pytest/jest) — verification is manual.

## Test Suites feature — shipped 2026-07-29

Plan: `C:\Users\shlok164201\.claude\plans\bubbly-honking-russell.md`

**Backend** — all done
- [x] `s2d/db.py`: `s2d_test_suites`, `s2d_test_suite_cases` tables + `_add_missing_test_run_columns()` (nullable `suite_id`)
- [x] `s2d/db.py`: CRUD — `create_suite`, `list_suites`, `get_suite`, `update_suite`, `delete_suite`; extended `create_run` + `list_runs`
- [x] `s2d/engine.py`: `_persist_run` accepts `suite_id`; `run_suite(...)`; refactored to `_execute_test_cases` helper
- [x] `app.py`: routes GET/POST `/api/s2d/suites`, GET/PATCH/DELETE `/api/s2d/suites/<id>`, POST `/api/s2d/suites/<id>/run`

**Frontend** — all done
- [x] `api.js`: 7 new wrappers
- [x] `App.jsx`: `ListChecks` nav item between S2D and History
- [x] `TestSuitesPage.jsx`: two-pane list + detail + Run/Delete
- [x] `TestCasePanel.jsx`: Create Suite selection mode with checkboxes + bottom bar
- [x] `HistoryPage.jsx`: Suite column, colSpan 6 → 7

**Verified**
- Backend `py_compile` clean; migration idempotent (`init_s2d_tables()` ran repeatedly).
- Curl end-to-end: create/list/get/run/get-run all work; validation rejects bad payloads.
- Browser flow: created a suite ("smoke suite (UI)") from S2D page with 2 selected test cases → appears in Test Suites → Run Suite → Analytics shows 2 PASS results → History shows suite name in new column; legacy runs show "—".
- Lint: 13 problems (11 err + 2 warn) — matches pre-change baseline exactly, no new lint debt.

## Scheduled Runs — shipped 2026-07-30

Plan: `C:\Users\shlok164201\.claude\plans\bubbly-honking-russell.md`

**Backend** — all done
- [x] `requirements.txt`: `APScheduler>=3.10.4,<4.0` (installed 3.11.3)
- [x] `s2d/db.py`: tables `s2d_suite_schedules`, `harvest_schedules`, `schedule_events` + CRUD + event log helpers
- [x] `scheduler.py` (new): `init_scheduler`, `add/remove_suite_schedule_job`, `add/remove_harvest_schedule_job`, `compute_next_fires`, `_run_suite_job`, `_run_harvest_job`, misfire listener; APScheduler defaults `max_instances=1, coalesce=True, misfire_grace_time=1800`
- [x] `app.py`: `WERKZEUG_RUN_MAIN` guarded `init_scheduler()` call; suite/harvest schedule CRUD routes + `/api/schedules` (global) + `/api/schedules/preview`

**Frontend** — all done
- [x] `api.js`: 12 new wrappers (7 suite/harvest CRUD + preview + global list)
- [x] `SchedulePicker.jsx` (new): preset dropdown + Custom card (Interval + Specific time tabs) + live preview
- [x] `SchedulesSection.jsx` (new): reusable list/create/toggle/delete/events widget
- [x] `TestSuitesPage.jsx`: Schedules section in suite detail
- [x] `HarvestWizard.jsx`: Schedules section under selected connector

**Verified end-to-end**
- Backend `py_compile` clean; migration idempotent (all 3 new tables + FK created).
- Preview: `POST /api/schedules/preview` returns 5 consecutive Fridays 4pm IST for `0 16 * * 5` cron.
- Real fire: 60s interval suite schedule created via API → APScheduler fired at ~60s → suite ran on live Fabric → run row tagged with `suite_id` → schedule event `'ran'` logged with `run_id` → schedule row `last_status=ran` + `last_fired_at` populated.
- Validation: bad cron rejected with 400; sub-60s interval rejected; unknown suite/connector returns 404.
- UI: Custom picker → Specific time → Friday + 16:00 → preview updates to correct upcoming Fridays; Save → schedule row appears with human-readable summary + next-fire timestamp in local TZ.
- Harvest UI: Schedules section renders under connector selector with same widget.
- Lint: 13 problems, matches pre-change baseline (no new debt).

## Backlog (from HANDOFF.md, still explicitly out of scope)

## Backlog (from HANDOFF.md, still explicitly out of scope)

- `AnalyticsPage.jsx` "Trends" and "Scorecard" tabs — disabled stubs, no data model yet.
- "Isolate Bad Rows" button on `AnalyticsPage.jsx` — disabled.
- PySpark test-case execution — returns ERROR.
- No automated test suite (pytest/jest).
- Cross-mapping test suites (would need engine changes since runs are per-mapping).
- Cascade cleanup of orphaned junction rows on test-case delete (JOIN naturally hides them).

## Uncommitted working tree

New feature files are uncommitted. When ready to commit, also included: prior in-flight changes to `ai_service.py`, `Backend/app.py`, `s2d/engine.py`, `fabric_connector.py`, `Frontend/src/api.js`, `MappingPanel.jsx`, `TestCasePanel.jsx`, and the debug script `check_last_results.py`.
