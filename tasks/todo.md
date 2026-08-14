# Todo

**Current state: clean checkpoint.** All features below are shipped and verified (backend compiles, frontend lints at the 13-problem baseline, each feature checked against real data in the browser or via curl). Nothing is broken or half-finished. The one open item is that **none of this session's work is committed to git yet** — see "Uncommitted changes" below.

Read `tasks/lessons.md` before touching anything — several of its entries (StrictMode focus-clearing, migration races, no-use-before-define) will save you from re-discovering the same bugs.

## Uncommitted changes (as of 2026-08-07, second session)

Everything through the "AI-suggested rule dedup" entry below **is committed** (`16213cf`). The older note claiming a large uncommitted working tree was stale and has been removed.

Currently uncommitted: the **Column map** feature, the **8-metric column parity** rework, and **Custom SQL across both sides** (top three entries below). They touch overlapping files, so consider three commits split along the changelog headings.

- **Backend, modified**: `app.py`, `ai_service.py`, `s2d/db.py`, `s2d/engine.py`. **New**: `s2d/column_map.py`.
- **Frontend, modified**: `api.js`, `pages/S2DPage.jsx`, `pages/MappingsPage.jsx`, `pages/AnalyticsPage.jsx`, `components/s2d/TestCasePanel.jsx`. **New**: `columnMap.js`, `sqlLint.js`, `components/s2d/ColumnMapModal.jsx`.
- Also modified for the syntax checker: `connectors/base.py`, `connectors/sql_guard.py`, `connectors/fabric_connector.py`, `connectors/local_connector.py`, `local_files/db.py`.
- Pipelines tab: `connectors/base.py`, `connectors/fabric_connector.py`, `app.py`, `App.jsx`, `api.js`. **New**: `pages/PipelinesPage.jsx`.
- Row counts: `connectors/base.py`, `connectors/fabric_connector.py`, `connectors/local_connector.py`, `app.py`, `api.js`, `components/s2d/TestCasePanel.jsx`, `pages/MappingsPage.jsx`.
- `components/connect/ConnectorForm.jsx` also shows as modified — that's a user edit, not part of this work.
- **New**: `.claude/launch.json` (dev-server config for the browser preview — backend on 5000, frontend on 5173).
- `catalog.db` and `local_data_*.duckdb` show as modified: real runtime data, not code.

## Feature changelog (newest first)

### Custom SQL now shows the numbers your query computed — 2026-08-13

Reported: a script `SELECT COUNT(*) AS male_count, TRUE AS passed FROM … WHERE Gender = 'Male'` passed, but the count itself was nowhere to be seen.

Root cause in `s2d/engine.py`: `_interpret_row` only ever surfaced a column literally named `details`, so every other column a script selected was read for pass/fail and then discarded. A tester computing a number had to go and re-run the query somewhere else to actually read it — which defeats the point of writing it here.

Now any column beyond the contract (`passed`, `details`, `violations`, `total_rows`) is surfaced verbatim as `male_count = 592`. No attempt is made to interpret what a column means; it's the tester's output, shown as-is. Applied to the Both-sides scope too (reserving `value`, `details`) so the two Custom SQL modes don't behave differently — an extra column appearing in one mode and vanishing in the other would be its own bug.

Pairs with the earlier fix that made the Result Detail panel render on PASS; without both, a passing check still showed nothing.

**Verified against the real Fabric table**, including the regressions:
1. The reported query → `male_count = 592`, and confirmed end to end by re-running the tester's own saved `gender count test` in the UI.
2. Several computed columns → `total_people = 1000, genders = 2, min_exp = 0.0`.
3. **Template shape unchanged**: a script returning only `passed`/`details` still yields exactly `0 null Gender rows found`, with nothing appended.
4. **`violations`/`total_rows` still feed their own columns** (7 / 99) and do **not** leak into the details text.
5. Explicit `details` plus an extra column shows both: `looks fine | n = 1000`.

### Row counts in every table picker — 2026-08-13

Every table picker now shows its row count automatically, no button. A tester sizing up a validation can see which tables are empty, which side is bigger, and whether source and destination are even in the same ballpark — previously you had to write and run a Row-count-match case just to find out.

Counts ride the table listing (`GET …/containers/<id>/tables?include_row_counts=1`) rather than a separate endpoint, because on Fabric the expensive part is opening the DuckDB attach (~9s), not querying. `FabricConnector.get_schema` already opens exactly one attach, so counting inside it measured **+0.44s overhead**; a second endpoint would have doubled the wait before anything appeared. Opt-in flag, so `ColumnMapModal` and the template dropdowns — which only need columns — don't pay for it. Requested by `TestCasePanel`'s schema fetch (feeding all 12 `TableCheckboxList` usages) and `MappingsPage`'s `EndpointPicker`.

**Counts are deliberately uncached.** During this session `dubai_banking_oac_source` went 1000 → 500 → 1000 and two new tables appeared, because pipeline runs were changing the data. A cached count would actively mislead.

> ### ⚠️ Found a real DuckDB mssql-extension bug — do not "optimise" the counting back into one query
>
> The first implementation used one `UNION ALL` with `COUNT(*)` per arm, so a container cost one round trip. **It silently returned wrong numbers.** For four Fabric tables whose true counts are `[97377, 0, 1000, 883]`, the unioned query returned `[97377, 0, 0, 97377]` — arms 3 and 4 repeating arms 1 and 2. Caught it in the browser: a table showing `0 rows` that a direct `COUNT(*)` said had 1000.
>
> Characterised before fixing:
> - **Two arms are fine, four are not.** Not a threshold anyone should rely on.
> - Happens **with and without** the table-name literal, so it isn't the literal.
> - Several scalar subqueries in one SELECT are corrupted the same way (`[883, 1000, 1000, 883]`), so that's not an alternative either.
> - **Row-level multi-arm unions are UNAFFECTED**: `COUNT(*)` over a four-arm `SELECT 1 FROM t` union returned exactly the right total (99260). This is what matters most — it means `s2d/engine.py`'s `_build_column_union`, and therefore every `column_parity` and `cross_table_parity` check, is **correct as it stands**. The bug is specific to *multiple aggregates in one statement*.
>
> Fix: one `COUNT(*)` per table, on the connection that's already open. The rationale and measurements live in `build_row_count_query`'s docstring in `connectors/base.py`, because "combine these into one query" is exactly what someone will try again.

- `connectors/base.py`: `build_row_count_query(table)` + `list_tables_in_container(container_id, include_row_counts=False)` as a **default argument**, so no existing caller changes.
- `connectors/fabric_connector.py`: `_attach_row_counts` counts per table inside the existing attach, each guarded individually so one unreadable table costs only its own count.
- `connectors/local_connector.py`: same shape, one code path rather than a second subtly-different implementation.
- `app.py`: the flag on the existing route; omitting it returns the original shape exactly.
- `api.js`, `TestCasePanel.jsx` (`TableCheckboxList` gains `rowCounts`), `MappingsPage.jsx`.
- **`??` not `||`** when rendering: an empty table's count is `0`, which is falsy, and `||` would have hidden precisely the case a tester most wants to notice.

**Verified**:
1. Counts correct on both connectors, compared against direct `COUNT(*)`. Because the workspace is live, a mismatch only counts as a bug when two back-to-back direct reads agree with each other and disagree with the endpoint — an earlier version of the test "failed" purely because a table changed between two calls.
2. **Empty table reports `0`, not `None`** — staged a deliberately empty table and confirmed both the API value and that the UI renders `0 rows`.
3. **Default path unchanged**: no `row_count` key when the flag is omitted.
4. **Overhead +0.44s** on Fabric, confirming the count really does share the attach.
5. **Degradation**: with counting forced to fail, every table still lists, each with `—`.
6. **Browser**: counts appear automatically in the S2D pickers and Validation Setup, with thousands separators (`1,000 rows`, `5,000 rows`). Confirmed the previously-wrong Fabric table now reads `1,000 rows` where it read `0` before the fix.
7. Lint at the 9-problem baseline. Throwaway empty table removed.

**Note**: the Flask backend died mid-verification (`ERR_CONNECTION_REFUSED`) — an untracked process from earlier in the session, unrelated to this change. Restarted via `.claude/launch.json`.

### Pipelines tab — trigger a Fabric pipeline from the framework — 2026-08-12

New **Pipelines** tab between Connect and Harvest, matching the data flow: connect → load with a pipeline → harvest what it produced. Requested flow is *start a pipeline → see success/fail → go to Harvest*, and the success card ends with a **"Go to Harvest →"** button so the tester is carried across rather than hunting the nav.

> ### ⚠️ THE LIVE TRIGGER IS UNVERIFIED — READ BEFORE DEMOING
> The user explicitly asked that **no pipeline be triggered during development** (it runs for real and moves real data), so the `POST` was never executed against a valid pipeline id. Confirmed zero POSTs left the app during testing.
>
> **The specific risk**: listing pipelines and reading run history work with the existing service-principal token (both verified), but *starting* a job is a **separate Fabric permission**. If the SP lacks it, the first real click returns **HTTP 403** and the UI shows: *"This connector isn't allowed to start pipeline runs. It can list pipelines and read their history, so this is specifically the run-on-demand permission — the service principal needs at least Contributor on the Fabric workspace."* That message is the fix instruction, not a bug.
>
> **Encouraging but not proof**: a POST to a deliberately nonexistent pipeline id reached Fabric and came back `ItemNotFound` (404), not 401/403 — so the token authenticated and the request got as far as item resolution. Whether Fabric checks existence before permission is unknown, so this doesn't settle it.

- `connectors/fabric_connector.py`: `_api_post` (mirrors `_api_get`'s token/timeout and the corporate-proxy `verify=False`, but returns the raw response — the trigger answers **202 Accepted** with an empty body and the run id in the `Location` header). Plus `list_pipelines`, `run_pipeline`, `get_pipeline_run`, `list_pipeline_runs`, and `_pipeline_run_to_dict` which flattens Fabric's nested `failureReason` and derives `is_running` from the status (`NotStarted`/`InProgress` are live; `Completed`/`Failed`/`Cancelled`/`Deduped` are terminal). If `Location` is missing, `run_pipeline` falls back to the newest run rather than failing — the run has started either way, and losing track of a live run is worse than an extra lookup.
- `connectors/base.py`: the four methods as **non-abstract** stubs raising `NotImplementedError`. Pipelines are Fabric-only; making them abstract would force `LocalConnector` to carry dead overrides.
- `app.py`: four routes plus `_fabric_connector_or_error()`, which refuses non-Fabric connectors up front (400) rather than relying on the base-class error.
- `pages/PipelinesPage.jsx` (new), `App.jsx` nav entry between `connect` and `harvest`, four `api.js` helpers.
- Polling every 5s until terminal, giving up after 15 min with a manual Refresh. **No `setState` in an effect body** — the pipeline load is driven by actions (mount callback, dropdown change) with a `requestedConnectorRef` guard replacing what a cleanup would do, and history refresh happens in the poll's callback rather than in a second effect. Both were restructured rather than suppressed, per `tasks/lessons.md`.

**Verified (everything except the live trigger)**:
1. `import app` clean. `GET /pipelines` against the real workspace → all 5 known pipelines. `GET /runs` history → 200.
2. **Trigger plumbing via a nonexistent pipeline id** — exercised `_api_post`, auth, URL building, response parsing and error mapping end to end while starting nothing. Returned a clean mapped 404, not a stack trace.
3. Non-Fabric connector refused with 400 on all four routes; unknown connector → 404.
4. **Browser**: tab renders between Connect and Harvest; 5 real pipelines with Run buttons. Run lifecycle verified by **stubbing `window.fetch`** — the only honest way to exercise states I'm not permitted to produce: `NotStarted` → `InProgress` → `Completed` with the spinner stopping, the success card and Go-to-Harvest appearing, and history refreshing; then a `Failed` run showing Fabric's failure reason with no Go-to-Harvest offered. Go-to-Harvest lands on Harvest. Network log confirms **only one read-only GET** was ever sent. No console errors.
5. Lint at the 9-problem baseline; `PipelinesPage.jsx` itself is completely clean.

**Not included**: storing runs in the app DB (Fabric's job API is the source of truth), linking a pipeline run to a validation run, scheduling pipelines, pipeline parameters, and notebooks — though the same job API runs notebooks, and the workspace has one called `SampleQueriesToInsertNullsInTable` which is the manual test-data step from the earlier discussion.

### SQL syntax checking + copy-across — 2026-08-12

Two gaps in the Custom SQL editors, both hit for real: the same query had to be typed twice in `Both sides` mode, and three consecutive failed runs were needed to discover mistakes the database could have reported instantly.

**Copy across** — *Copy to destination →* / *← Copy to source* buttons on each editor's label row, with a `confirm()` before overwriting a non-empty different box.

**Syntax checking, two layers.**

1. *Instant hints* (`Frontend/src/sqlLint.js`, new, pure functions): doesn't start with SELECT, `WHERE` before `FROM`, unbalanced quotes/brackets, mid-statement `;`, and **missing the required output column** (`value` for dual_script, `passed` for single_side). Comment- and literal-aware, so `'a--b'` is data and a leading `--` comment is fine. **Hints never block Save** — they're heuristics, so they must not veto something the real parser would accept.
2. *Check syntax button* — `EXPLAIN`s the query on that side's real connector. Authoritative: catches misspelled **column and table names**, which no heuristic can. Measured why it's a button not as-you-type: each EXPLAIN is <0.4s but opening the Fabric connection costs ~5–9s.

- `connectors/base.py` + `fabric_connector.py` + `local_connector.py` + `local_files/db.py` — `validate_query(container_id, sql)` → `(ok, error)`. Runs `validate_select_only()` **before** EXPLAIN so a non-SELECT never reaches the parser; the plan is discarded.
- `app.py` — `POST /api/s2d/mappings/<id>/validate-sql`, returning **200 for both outcomes** (`{ok: true}` / `{ok: false, error}`); a syntax error is a valid result, not a failed request. Non-2xx reserved for "couldn't run the check".
- `sql_guard.py` — `clean_explain_error()` drops the echoed `LINE n:` block. First attempt tried to un-prefix `EXPLAIN` from it, but DuckDB elides long lines (`LINE 1: ...PLAIN select …`) so there was no reliable prefix to strip and its caret pointed at the wrong column. Dropping the block keeps everything useful — the error names the offending token, and DuckDB's `Candidate bindings:` / `Did you mean` suggestions survive.
- `TestCasePanel.jsx` — shared `SqlEditorFooter`, per-editor verdict state cleared on edit (a stale green tick must not vouch for changed SQL), wired into both dual editors and the single-side textarea. Not for PySpark (nothing to parse it against) or template SQL (read-only, always valid).

**Bug found and fixed along the way — two shipped templates could never run.** `validate_select_only` required the text to *start* with `SELECT`, but the `referential_check` and `custom_expression` templates both **open with a `--` comment**, so any test case built from them failed at run time with "Only single SELECT statements are allowed". The same flaw meant a comment mentioning a word like *delete* tripped the forbidden-keyword search. Fixed with a quote-aware `_strip_sql_comments()` — checks now run on comment-stripped text while the original (comments intact) is what executes. Verified 8 legitimate shapes now accepted (both templates, block comments, `-- deletes nothing`, `'a--b'`, trailing `;`) and 4 genuine threats still rejected (bare `DELETE`, `DELETE` after a comment, multi-statement, `DROP` after a subquery).

**Verified**:
1. Route against the **real** validations — no fixture needed, since `validate-sql` writes nothing. Valid → `ok:true`; `WHERE`-before-`FROM` → parser error; bad column → binder error; bad table → catalog error; `DELETE` → blocked by the guard before EXPLAIN. On both a Local and a Fabric side. Bad target / empty sql → 400.
2. `sqlLint` over 18 cases — all three real failures from this session flagged, **zero false positives** on 8 valid shapes.
3. **Browser, on the real `Bronze to silver` validation without ever clicking Save** (deliberately avoiding the throwaway-fixture race): typed the original failing query → both hints appeared with **0 network calls**; Save stayed enabled; *Check syntax* returned the genuine `Parser Error`; editing cleared the stale verdict; the corrected query returned "Valid against the live schema"; copy-across prompted, left the box untouched when declined, and copied when accepted. Confirmed afterwards that **no test case was created**.
4. Lint: 9 problems (was 13 — `TestCasePanel.jsx` errors were fixed separately). Nothing new. No console errors.

### Row count match: dropped the pointless Validation type dropdown — 2026-08-12

The Validation type dropdown offered 10 options for a Row count match check, none of which changed anything. Confirmed the engine only ever *reads* `validation_type` in `_run_column_parity` (`s2d/engine.py:396`) — `_run_row_count_match` never touches it, so for that check type the field was a label and nothing more.

Now hidden when `checkType === 'row_count_match'` (the name input spans the full width instead), and the check-type radio fixes `validation_type` to `Record Volume Integrity`, which is precisely what a row count check is. That value still has to be sent because `_validate_test_case_body` requires a non-empty `validation_type` for every check type.

**Verified in the browser**: dropdown absent for Row count match, present for Custom SQL / Column parity / Cross-table parity, and restored when switching back. Saved and ran one through the UI → PASS, 1000 rows, stored as `validation_type: 'Record Volume Integrity'`.

Not extended to the other scopes, though the same is technically true of them: `cross_table_parity`, `dual_script` and `single_side` don't read `validation_type` either — it's a free-text label for grouping in the results table, which is arguably worth keeping there. Say the word if you'd rather it went from those too.

**Follow-up (same day): the edit path leaked the old label.** The radio's `onChange` fixes the label when you *click* Row count match, but `startEdit()` sets `checkType` straight from the stored row without firing that handler — so opening a pre-existing row_count_match case and re-saving preserved whatever label it already had. `buildPayload` now applies a `fixedValidationType` override (`Record Volume Integrity` for row_count_match, `Custom` for cross_table_parity — the other check whose engine path ignores the field), so the correction sticks on the edit path too.

Not hypothetical: the existing **`Row count match`** test case is stored with `validation_type = 'Null Value Constraint'`, so the Results table currently mislabels it. The pinning corrects it on the next save; the stored row was left alone rather than silently `UPDATE`d.

### Fix: a passing test case displayed no result — 2026-08-12

Reported symptom: *"this query asked for a result and the result is not here, result is visible in sql analytics endpoint but not here."*

Root cause in `pages/AnalyticsPage.jsx`: the trace panel rendered `details` and `evaluated_query` **only when `status !== 'PASS'`**. A PASS got the single line "✓ This test case passed - nothing to trace." The measured numbers were computed, stored and correct — confirmed in `s2d_test_results` (`details: "source value = 140 | destination value = 140"`, matching an independent query against both Lakehouses) — just never shown.

That assumption ("a trace is only for failures") predates checks whose whole output *is* a measured value. It hid the evidence for every scope on PASS: a passing column-parity check likewise never showed `source nulls = 0 | destination nulls = 0`.

- Merged the two conditional branches into one that renders for any selected result, with the status line green + "Assertion held" on PASS and red + the error on failure.
- Panel heading is now status-aware: green "RESULT DETAIL" with a check icon on PASS, red "ERROR TRACE ANALYSIS" with the warning icon otherwise — a PASS under a red ERROR banner read as a failure at a glance.

**Verified in the browser against a real run**: the passing `check test` run now shows the query, `[PASS] Assertion held`, and `source value = 140 | destination value = 140`. A failing run on the same panel still shows the red heading and its parser error unchanged. No console errors; lint at the 13-problem baseline.

### Custom SQL across both sides — 2026-08-12

Solves: a Custom SQL test case could only ever run against **one** side. There was no way to write your own SQL that checks source and destination together.

Two mechanisms, because two physically different situations exist:

**UI note (2026-08-12, later):** originally a fifth check-type radio card, now folded into the existing **Custom SQL script** card to save space — the check-type grid is back to a clean 2×2. The `Runs against:` row gained a third option, **Both sides (compare two scripts)**, which is what switches `check_scope` between `single_side` and `dual_script`. Scope really is a property of a custom script rather than a separate check type, so this reads better than it did as its own card. Picking Source/Destination shows the template picker and the single `passed` editor; Both sides swaps in the two `value` editors. Verified toggling both directions plus a full save→run (correctly FAILed 500 vs 1000 on a deliberately half-scoped source script).

**1. New `check_scope='dual_script'`** — one script per side, each returning one row with a **`value`** column. The engine runs each on its own connector/container and compares the two values → PASS/FAIL. This is the only honest option when the sides live on different systems (every current validation is cross-system), since a single SQL statement executes inside exactly one connection. Chosen over "one script run against both sides" because a single script must be valid against both, which breaks the moment the two sides name columns differently — the exact drift this tool exists to catch.

**2. `single_side` relaxation** — when source and destination share a connector **and** container, a single script may now declare tables from either side and join them. No engine change: `_run_sql_check` already passes SQL through untouched, so this was purely the UI and validation blocking something that already worked.

- `s2d/engine.py`: `shares_connection(mapping)` predicate, `_interpret_value_row` (mirrors `_interpret_row` — a missing row or missing `value` column ERRORs loudly rather than being guessed into a pass), `_run_dual_script_check`, one dispatch line. Other scopes untouched.
- `s2d/db.py`: additive `destination_script_text TEXT`. `script_text` holds the source script, so `single_side` rows need no backfill.
- `app.py`: `dual_script` validation branch; `single_side` `target_tables` accepts the union of both sides when `shares_connection`; field threaded through create/update.
- `TestCasePanel.jsx`: fifth check-type card, two labelled script editors (each showing its side's connector name), `customSqlTableOptions` widened only for the freehand picker — **not** the template dropdowns, whose column lists come from one side's schema and would break.
- The SELECT-only guard needed no new plumbing: it's enforced at the connector layer (`fabric_connector.py:261`, `local_files/db.py:174`), so both scripts are checked on execution.

**Verified against real data**:
1. Migration clean; `destination_script_text` present.
2. **Regression**: `single_side` SQL byte-identical (evaluated_query *is* the script), `cross_table_parity` SQL byte-identical, 13 `column_parity` cases re-run with matching verdict + metric. Nothing drifted.
3. **Cross-system (Local source → Fabric destination, the shape of every real validation)**: matching scripts PASS (1000 = 1000); deliberately mismatched FAIL (1000 vs 592, violations 408, both values named in the details).
4. **Malformed script** with no `value` column → ERROR, `"The source script's result has no 'value' column (columns returned: ['total'])"` — not a silent pass.
5. **Same-connection**: a single script JOINing a source table to a destination table PASSes (450 joined rows); `_validate_test_case_body` accepts cross-side `target_tables` there and still rejects them on a cross-system mapping.
6. **Browser**: dual-script case built and run through the real UI → PASS. Picker offers both sides' tables + explanatory note on a same-connection validation, one side only on a cross-system one.
7. `npm run lint` at the 13-problem baseline. Throwaways torn down; no `ZZ-TEMP` leftovers.

**Important finding for `Bronze to silver`**: that validation is the same connector but **two different Lakehouses** (`1494d1cf…` → `e070d570…`), so it uses the dual-script path, not the single-script one. Probed why: both Lakehouses share one SQL endpoint server, but `_duckdb_attach` attaches only one as `fabric_db`, so a three-part name to the other fails with `Catalog "..." does not exist`. Cross-Lakehouse in one statement is therefore unavailable **as the connector is currently written** — attaching both catalogs in `_duckdb_attach` would plausibly enable it, since the server is shared. Not attempted; recorded in the backlog.

**Known limitations**: comparison is **equality only** — no `>=` or tolerance, which matters for float aggregates and incremental loads. No AI generation of dual scripts.

### Column parity: 3 metrics → 8, with per-table breakdown — 2026-08-10

Solves: connecting several tables for one source↔destination comparison only offered 3 validation types (null count, distinct count, min/max range), while the Custom SQL template library offered ten kinds of check. And when a parity check failed across multiple tables per side, the details gave one aggregate number without saying *which* table was responsible.

**Metrics now available** (`PARITY_METRICS` in `s2d/engine.py` is the single registry): Null Value, Uniqueness, Boundary Range *(existing)* + **Record Volume Integrity** (row count + non-null count), **Length Constraint** (MIN/MAX value length — catches a destination that truncates), **Regex Pattern Check** (count of values matching a pattern), **Data Freshness** (MAX value), **Categorical Constraint** (the exact *set* of distinct values).

Deliberately excluded: **Referential Integrity** (a join within one side, not a two-side comparison — use the `referential_check` template in Custom SQL mode) and **Custom** (no defined metric).

**Mechanism**: one query per side — preserving the "never a cross-database join" design — as a tagged union with `GROUP BY ROLLUP (src_table)`. Named rows give the per-table breakdown; the `src_table IS NULL` grand-total row is the authoritative overall metric. **ROLLUP rather than summing is load-bearing**: per-table distinct counts were 5 and 5 while the correct global value is 10, so summing would silently corrupt Uniqueness, Boundary, Length and Freshness. `_format_breakdown` renders additive metrics as summands (`(a: 3, b: 4)`) and non-additive ones with a `per-table:` prefix so nobody reads `= 10 (per-table: a 5, b 5)` as broken arithmetic. Categorical is the one exception to the metric shape — it fetches distinct `(table, value)` pairs and diffs sets in Python, like `_run_cross_table_parity_check` does for keys.

- `s2d/engine.py`: `_build_column_union(..., tagged=)`, `PARITY_METRICS` registry, `PARITY_VALIDATION_TYPES` (now the single source of truth), `_split_rollup`, `_format_breakdown`, rewritten `_run_column_parity`, new `_run_categorical_parity`, extracted `_destination_total_rows`. `_run_sql_check` / `_run_row_count_match` / `_run_cross_table_parity_check` untouched.
- `s2d/db.py`: additive `parity_config TEXT` (JSON) on `s2d_test_cases` for the regex pattern — one JSON column so a future metric param needs no migration. Parsed to `{}` when absent.
- `app.py`: **fixed a latent drift bug** — the column_parity branch of `_validate_test_case_body` hardcoded the 3 type names inline even though the module already imported `PARITY_VALIDATION_TYPES`; adding metrics without fixing it would have made the API reject exactly what the UI offers. Now imports from `s2d.engine`. Requires `parity_config.pattern` for the regex metric; AI route skips a pattern-less regex proposal; dedup signature now includes the pattern.
- `ai_service.py`: imports `PARITY_VALIDATION_TYPES` from `s2d.engine` (acyclic) instead of restating it, plus `PARITY_METRIC_GUIDE` explaining what each metric compares so the model varies its choices.
- `TestCasePanel.jsx`: 8 metrics in the picker, per-metric hint text, regex pattern input gated to that metric, `parity_config` in `buildPayload`/`startEdit`, `canSave` blocks a pattern-less regex. Removed an unreachable warning callout — the check-type radio already coerces `validationType` into the parity list.

**Verified against real data**:
1. Migration clean against live `catalog.db`; `parity_config` present.
2. **Regression, two kinds.** Column parity's SQL *intentionally* changes shape, so byte-equality doesn't apply — instead **re-ran all 21 existing column_parity cases against live Fabric/local and confirmed every verdict and overall metric matches history**, including the pre-existing `Customer ID Integrity` failure (still 300 vs 290). Separately confirmed cross-table-parity SQL **is** still byte-identical (2 cases).
3. All 8 metrics on a throwaway `ZZ-TEMP` fixture (2 source + 1 destination): baseline identical → all 8 PASS; then one seeded defect at a time → **each defect flips exactly its owning metric**. Sharpest case, `categorical_swap` (a destination value replaced with a new one): Uniqueness still PASSes because the distinct count is unchanged, while Categorical FAILs and names `'PENDING'` as absent, traced to the source tables — the reason Categorical exists.
4. Breakdown arithmetic confirmed both ways: additive sums to the total, Uniqueness deliberately does not (10 ≠ 5+5) and the grand total is what's compared.
5. **Browser**: Categorical and Regex built and run through the real UI → correct FAILs with the breakdown in the details line; pattern input appears only for the regex metric and Save is blocked while it's empty; no console errors. *(No screenshot — the Browser pane isn't displayed in this environment so the page doesn't composite frames; the captured details/SQL text is the evidence.)*
6. **AI**: `ai/suggest-parity-rules` proposed 6 distinct metrics including 3 new ones, sensibly paired (Data Freshness on a timestamp, Length on a name). Pattern-less regex skip branch driven directly with a stubbed AI via Flask's test client → skipped with the right reason while the patterned one saved and persisted its pattern. API guard returns 400 for a manual regex case with no pattern.
7. Fixture torn down, real data confirmed untouched, `npm run lint` at the 13-problem baseline.

**Known limitations**: Categorical transports distinct values, so it's for low-cardinality columns (the UI hint says so) — a high-cardinality column will pull a lot of rows. Boundary Range and Data Freshness overlap on date columns (both compare MAX). Regex uses DuckDB `regexp_matches` syntax on both sides.

### Column map — opt-in common column names per validation — 2026-08-07

Solves: a validation with 3 source tables + 1 destination holding the same data under **different column names** was close to untestable. Cross-table parity stored one `key_column` applied verbatim to every table, the UI only offered columns spelled identically across all of them, and all 3 AI suggest routes rejected anything outside the literal intersection.

Now a tester can press **Map Columns** on a validation and declare common names (`order_id` → `OrderID` here, `order_no` there, `OrderKey` on the destination). Test cases reference the common name; the engine resolves it to each table's own physical column at run time.

- **Storage**: one additive `column_map TEXT` column on `s2d_mappings` (JSON array of `{name, source:{table:col}, destination:{table:col}}`). No new tables, no change to `s2d_test_cases` — the existing `key_column` / `source_column` / `destination_column` now hold *either* a physical name or a common name. Cascade delete works for free; the engine already loads the mapping, so resolution costs zero extra queries.
- **`s2d/column_map.py`** (new, pure functions, no DB): `physical_column` / `columns_for` / `common_names` / `describe` / `prepare`. **`physical_column` falling back to the name it was given is the entire opt-in guarantee** — no map, or a table the tester chose not to map, behaves exactly as before.
- **Engine**: `_build_column_union` / `_build_parity_metric_query` / `_build_row_count_query` now take a `{table: column}` dict instead of one shared column name. `_run_column_parity` and `_run_cross_table_parity_check` resolve per side *and* per table. `_run_sql_check` deliberately untouched — free-text SQL is pushed down verbatim, so a common name there would reference nothing; the single-table AI suggest route is likewise **not** given the map for the same reason.
- **API**: new `PUT /api/s2d/mappings/<id>/column-map` (full replace). The three literal-intersection checks now also accept a common name covering every selected table. `ai/generate-test-case` accepts an optional `mapping_id` so it can load the map.
- **AI**: `_column_map_section()` in `ai_service.py`, threaded as `column_map_text` through the parity / key-column prompt builders and their wrappers, mirroring how `already_covered_text` works.
- **UI**: `ColumnMapModal.jsx` — grid of common names × every table in the validation, with an **Auto-match by name** button that groups columns matching after normalizing case/underscores/spaces (proposes only; nothing saves until Save). Opened from a `Columns3` button on each Validation Setup row (deliberately outside the hover-reveal cluster — an opt-in feature nobody can see isn't opt-in) and from the S2D header. Common names appear in the column dropdowns tagged `(column map)`, only once they cover every selected table.

**Verified against real data**:
1. Migration ran clean against the live `catalog.db`; `column_map` present, all existing rows NULL.
2. **Regression**: rebuilt the query for all 15 historical engine-built test cases and diffed against the `evaluated_query` stored from previous runs — **15/15 byte-identical**, including the existing cross-table-parity case.
3. Built a throwaway `ZZ-TEMP` validation (3 source + 1 destination, key spelled `OrderID` / `order_no` / `ORD_IDENT` / `OrderKey`), mapped it, ran a cross-table-parity case: PASS with all 9 keys matched, and the emitted SQL shows each `UNION ALL` arm selecting its own physical column. Deleting one destination row correctly flipped it to FAIL naming key 5.
4. **Browser**: drove the real UI end to end — auto-match found the two genuinely-identical fields and correctly did *not* invent a match for the four differently-spelled keys; added that key by hand; saved (200); `order_id (column map)` appeared in the key-column dropdown where nothing was previously selectable; created (201) and ran the test case → PASS, no console errors.
5. **AI**: `ai/suggest-cross-table-parity-rules` returned a rule keyed on `order_id`, the common name — previously it could return nothing at all for this shape. Ran it: PASS.
6. Throwaway fixture fully torn down, real data confirmed untouched. `npm run lint` back at the 13-problem baseline (one new `set-state-in-effect` error was fixed by seeding state at `useState` time, not suppressed).

**Known limitations**: mapped columns aren't re-verified against live schema on save (a column renamed upstream surfaces as a query error on the next run); 1:1 renames only, no concat/cast/split; free-text `single_side` SQL still needs physical column names.

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
- Column map: no live-schema validation on save, and no many-to-one / expression mappings (concat, cast, split) — 1:1 renames only.
- `dual_script` compares values for **equality only** — no `>=` / `<=` / tolerance operator. Wanted for float aggregates and incremental loads.
- **Cross-Lakehouse single-script joins**: two Lakehouses in one workspace share a SQL endpoint server, but `FabricConnector._duckdb_attach` attaches only one as `fabric_db`, so three-part names to the other fail. Attaching both catalogs would likely let a same-connector/different-container validation (e.g. `Bronze to silver`) use one joined script instead of two. Unproven — would need its own verification.

## Reference docs

- `HANDOFF.md` (repo root) — authoritative history of the original S2D Parts 1–4 build (pre-dates this session's work).
- `README.md` (repo root) — architecture overview, connector abstraction, operational gotchas (plaintext secrets, SELECT-only guard, T-SQL vs DuckDB SQL dialect).
- Plan files for every feature above are saved at `C:\Users\shlok164201\.claude\plans\bubbly-honking-russell.md` (overwritten per-feature — only the most recent plan survives there; this todo.md is the durable record).
