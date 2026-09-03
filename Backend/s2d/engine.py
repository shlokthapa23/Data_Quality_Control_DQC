import re
import time
import json
from datetime import datetime, timezone

from s2d import column_map
from collections import Counter

from s2d import db as s2d_db
from s2d import results_store
from notifications import db as notifications_db

# Cap on how long a PySpark test-case run is allowed to sit "InProgress"
# before this is treated as a failure - Spark cold-starts commonly take a
# couple of minutes, so this is generous, but a suite run (this executes
# synchronously, blocking whatever called it - see _run_pyspark_check) can't
# wait forever on one check.
_PYSPARK_POLL_INTERVAL_SECONDS = 5
_PYSPARK_POLL_MAX_ATTEMPTS = 96  # 96 * 5s = 8 minutes


def _interpret_row(row):
    """
    A 'sql' test-case script may return a 'passed' column (any of 1/0,
    True/False, 'true'/'false') and optionally a 'details' column.

    Returns (passed, details, asserted).

    'passed' is OPTIONAL. A script without it - `SELECT COUNT(*) FROM t WHERE
    ...` - isn't asserting anything, it's asking a question, and answering it
    beats failing over missing boilerplate. Such a run reports asserted=False so
    the caller can say plainly that nothing was verified; that label matters,
    because otherwise a screen of measurements would read as a wall of passes.

    A malformed 'passed' value is still surfaced loudly rather than guessed at -
    if the script says it's asserting, it has to be interpretable.
    """
    if row is None:
        return False, "Query returned no rows - expected exactly one row", True

    if "passed" not in row:
        return True, None, False

    raw = row["passed"]
    if isinstance(raw, bool):
        passed = raw
    elif isinstance(raw, (int, float)):
        passed = bool(raw)
    elif isinstance(raw, str):
        passed = raw.strip().lower() in ("1", "true", "yes")
    else:
        return False, f"Could not interpret 'passed' value: {raw!r}", True

    return passed, row.get("details"), True


def shares_connection(mapping):
    """
    True when source and destination live on the same connector AND the same
    container - the classic bronze/silver-in-one-Lakehouse case. Only then can a
    single SQL statement reach both sides, since SQL executes inside exactly one
    connection. Used to decide whether a single_side script may reference the
    other side's tables.
    """
    return (mapping["source_connector_id"] == mapping["destination_connector_id"]
            and mapping["source_container_id"] == mapping["destination_container_id"])


# Columns each script contract already consumes; everything else a script
# returns is the tester's own output.
_SQL_CHECK_RESERVED = ("passed", "details", "violations", "total_rows")
_DUAL_SCRIPT_RESERVED = ("value", "details")


def _describe_extra_columns(row, reserved):
    """
    "male_count = 140" for any column a script returned beyond the pass/fail
    contract.

    A tester writing `SELECT COUNT(*) AS male_count, TRUE AS passed ...` wants to
    READ that number, not merely assert on it. Without this the run showed a bare
    PASS and the value the query was written to produce was discarded - so the
    only way to see it was to go and run the query somewhere else.

    Anything not consumed by the contract is treated as the tester's own output
    and surfaced verbatim; no attempt is made to guess what a column means.
    """
    if not row:
        return None
    extras = [f"{key} = {value}" for key, value in row.items() if key not in reserved]
    return ", ".join(extras) if extras else None


def _interpret_value_row(row, side):
    """
    Pulls the number a 'dual_script' side is contributing to the comparison.
    Returns (value, error_message, column_used) - error_message is None when
    valid. column_used lets the caller avoid repeating that column in the
    "extra columns" detail, which would otherwise print the same number twice.

    A 'value' column is used when present, but is NOT required: a script
    returning exactly one column is unambiguous, so `SELECT COUNT(*) FROM t`
    works as-is rather than forcing an `AS value` alias onto every query. (Both
    connectors name that column count_star(), but the name is irrelevant - being
    the only column is what makes it unambiguous.)

    Two or more columns with no 'value' among them IS ambiguous, and that stays
    a loud error: guessing which one to compare could silently compare the wrong
    numbers and still look like a healthy PASS.
    """
    if row is None:
        return None, f"The {side} script returned no rows - expected exactly one row", None
    if "value" in row:
        return row["value"], None, "value"
    if len(row) == 1:
        only_column = next(iter(row))
        return row[only_column], None, only_column
    return None, (
        f"The {side} script returns {len(row)} columns and none is named 'value', so there's no "
        f"way to tell which to compare - alias one of them, e.g. ... AS value "
        f"(columns returned: {list(row.keys())})"
    ), None


def _build_summed_count_query(tables):
    """
    One table -> a plain COUNT(*). Multiple tables -> COUNT(*) per table,
    UNION ALL'd together, then summed - one single-connection query
    regardless of how many tables were picked, since every table on one
    side already shares the same container/connection.
    """
    if len(tables) == 1:
        return f"SELECT COUNT(*) AS cnt FROM {tables[0]}"
    parts = [f"SELECT COUNT(*) AS cnt FROM {t}" for t in tables]
    union_sql = " UNION ALL ".join(parts)
    return f"SELECT SUM(cnt) AS cnt FROM ({union_sql}) agg"


def _run_pyspark_check(tc, connector, container_id, rule_target):
    """
    Runs a tester-authored PySpark script as a Fabric notebook job and
    blocks (synchronously, like every other check here) until it reaches a
    terminal state. See fabric_pyspark_test_notebook_template.py for the
    'result' dict contract the script is expected to follow - it's read
    back through the exact same _interpret_row/_describe_extra_columns
    logic a SQL script's returned row already goes through, so a PySpark
    check's Result-table entry looks identical to a SQL one.

    Fabric's Notebook Jobs API is only implemented on FabricConnector - a
    PySpark check against a Local connector has nowhere to run, so that's
    reported plainly rather than attempted.
    """
    if not hasattr(connector, "run_pyspark_test_case"):
        return "ERROR", tc["script_text"], None, \
            "PySpark checks require a Fabric connector - Local connectors have no Spark to run this on.", \
            rule_target, None, None

    try:
        notebook_id, job_id, result_path = connector.run_pyspark_test_case(container_id, tc["script_text"])
    except Exception as e:
        return "ERROR", tc["script_text"], None, f"Could not start the PySpark job: {e}", rule_target, None, None
    if not job_id:
        return "ERROR", tc["script_text"], None, \
            "The PySpark job started but its job id could not be resolved.", rule_target, None, None

    run = None
    for _ in range(_PYSPARK_POLL_MAX_ATTEMPTS):
        try:
            run = connector.get_notebook_job(notebook_id, job_id)
        except Exception as e:
            return "ERROR", tc["script_text"], None, f"Could not read the PySpark job's status: {e}", rule_target, None, None
        if not run["is_running"]:
            break
        time.sleep(_PYSPARK_POLL_INTERVAL_SECONDS)
    else:
        return "ERROR", tc["script_text"], None, \
            "Timed out waiting for the PySpark job to finish (over 8 minutes) - check the Fabric portal directly.", \
            rule_target, None, None

    if run["status"] != "Completed":
        return "ERROR", tc["script_text"], None, \
            run["failure_reason"] or f'PySpark job ended with status "{run["status"]}"', rule_target, None, None

    try:
        raw = connector.read_onelake_file(container_id, result_path)
        row = json.loads(raw)
    except Exception as e:
        return "ERROR", tc["script_text"], None, f"PySpark job finished but its result couldn't be read: {e}", rule_target, None, None
    finally:
        try:
            connector.cleanup_staging_file(container_id, result_path)
        except Exception:
            pass  # best-effort, same as every other staging cleanup in this app

    if not isinstance(row, dict):
        return "ERROR", tc["script_text"], None, f"PySpark result was not a JSON object: {row!r}", rule_target, None, None

    passed, details, asserted = _interpret_row(row)
    violations = row.get("violations")
    total_rows = row.get("total_rows")
    extras = _describe_extra_columns(row, _SQL_CHECK_RESERVED)
    if extras:
        details = f"{details} | {extras}" if details else extras
    if not asserted:
        note = 'Measured only - the script set no "passed" key, so nothing was asserted'
        details = f"{note}: {details}" if details else note
    return ("PASS" if passed else "FAIL"), tc["script_text"], details, None, rule_target, violations, total_rows


def _run_sql_check(tc, mapping, source_connector, destination_connector):
    # target_tables (plural) supersedes the legacy singular target_table;
    # fall back to it for any not-yet-backfilled row, then to the mapping's
    # full table list for that side if neither is set.
    target_tables = tc.get("target_tables") or ([tc["target_table"]] if tc.get("target_table") else None)
    rule_target = ", ".join(target_tables) if target_tables else ", ".join(
        mapping["source_tables"] if tc["target"] == "source" else mapping["destination_tables"]
    )

    if tc["target"] == "source":
        connector, container_id = source_connector, mapping["source_container_id"]
    else:
        connector, container_id = destination_connector, mapping["destination_container_id"]

    if tc["script_type"] != "sql":
        return _run_pyspark_check(tc, connector, container_id, rule_target)

    try:
        row = connector.run_query(container_id, tc["script_text"])
        passed, details, asserted = _interpret_row(row)
        # Optional - a script can additionally return "violations"/"total_rows"
        # columns to populate the Results table's row-level counts; scripts
        # written before this existed simply don't have them, so both fall
        # back to None (rendered as '-' in the UI) rather than being required.
        violations = row.get("violations") if row else None
        total_rows = row.get("total_rows") if row else None
        # Whatever else the script selected is the tester's own output - show it.
        # A script computing `COUNT(*) AS male_count` is asking a question, and a
        # bare PASS with the answer discarded makes them go and re-run it by hand.
        extras = _describe_extra_columns(row, _SQL_CHECK_RESERVED)
        if extras:
            details = f"{details} | {extras}" if details else extras
        if not asserted:
            # Lead with the caveat: this run proves nothing, it only reports a
            # number, and a green PASS beside it would otherwise overstate what
            # happened.
            note = 'Measured only - the script has no "passed" column, so nothing was asserted'
            details = f"{note}: {details}" if details else note
        return ("PASS" if passed else "FAIL"), tc["script_text"], details, None, rule_target, violations, total_rows
    except Exception as e:
        return "ERROR", tc["script_text"], None, str(e), rule_target, None, None


def _compare_dual_rows(source_row, destination_row, evaluated_query, rule_target):
    """
    Shared by both dual_script paths (SQL and PySpark) - takes each side's
    already-fetched row (a dict either way: a DuckDB row via run_query, or a
    PySpark job's JSON result file) and does the actual value comparison.
    Splitting this out means neither execution mechanism needs to know
    anything about how the OTHER one runs.
    """
    source_value, error, source_column = _interpret_value_row(source_row, "source")
    if error:
        return "ERROR", evaluated_query, None, error, rule_target, None, None
    destination_value, error, destination_column = _interpret_value_row(destination_row, "destination")
    if error:
        return "ERROR", evaluated_query, None, error, rule_target, None, None

    passed = source_value == destination_value
    details = f"source value = {source_value} | destination value = {destination_value}"
    # Each side may also return a 'details' entry to explain its own number,
    # and anything else it returned is surfaced too - same reasoning as the
    # single-side path, so every dual_script mode behaves identically here.
    extra = []
    for side, r, used in (("source", source_row, source_column),
                          ("destination", destination_row, destination_column)):
        # The column that supplied the value is already reported above, so leave
        # it out here rather than printing the same number twice.
        reserved = _DUAL_SCRIPT_RESERVED + ((used,) if used else ())
        parts = [p for p in (r.get("details"), _describe_extra_columns(r, reserved)) if p]
        if parts:
            extra.append(f"{side}: " + ", ".join(str(p) for p in parts))
    if extra:
        details += " (" + "; ".join(extra) + ")"

    # A numeric gap is a meaningful violation count; anything else (strings,
    # dates, NULLs) can only be a 0/1 flag.
    if isinstance(source_value, (int, float)) and isinstance(destination_value, (int, float)) \
            and not isinstance(source_value, bool) and not isinstance(destination_value, bool):
        violations = abs(source_value - destination_value)
    else:
        violations = 0 if passed else 1

    return ("PASS" if passed else "FAIL"), evaluated_query, details, None, rule_target, violations, None


def _run_dual_pyspark_check(tc, mapping, source_connector, destination_connector, evaluated_query, rule_target):
    """
    PySpark counterpart to the SQL dual_script path above: one script per
    side, each ending by setting a `result` dict with either a 'value' key
    or exactly one key (same _interpret_value_row contract SQL dual_script
    already uses - see fabric_pyspark_test_notebook_template.py's contract,
    unchanged from the single_side case). Genuinely separate Fabric
    connectors need genuinely separate Spark jobs - a single notebook run
    can't span two workspaces/service principals.

    Both jobs are SUBMITTED first, then polled together (not one full
    submit-wait-submit-wait sequence) so the wall-clock cost is roughly
    max(source, destination) rather than their sum - each side's Spark
    cold-start already costs a couple of minutes on its own.
    """
    for side, connector in (("source", source_connector), ("destination", destination_connector)):
        if not hasattr(connector, "run_pyspark_test_case"):
            return "ERROR", evaluated_query, None, \
                f"PySpark checks require a Fabric connector - the {side} connector has no Spark to run this on.", \
                rule_target, None, None

    try:
        source_job = source_connector.run_pyspark_test_case(mapping["source_container_id"], tc["script_text"])
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Could not start the source PySpark job: {e}", rule_target, None, None
    try:
        destination_job = destination_connector.run_pyspark_test_case(
            mapping["destination_container_id"], tc["destination_script_text"])
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Could not start the destination PySpark job: {e}", rule_target, None, None

    jobs = {
        "source": {"connector": source_connector, "container_id": mapping["source_container_id"],
                   "notebook_id": source_job[0], "job_id": source_job[1], "result_path": source_job[2], "run": None},
        "destination": {"connector": destination_connector, "container_id": mapping["destination_container_id"],
                         "notebook_id": destination_job[0], "job_id": destination_job[1], "result_path": destination_job[2], "run": None},
    }
    for side, j in jobs.items():
        if not j["job_id"]:
            return "ERROR", evaluated_query, None, \
                f"The {side} PySpark job started but its job id could not be resolved.", rule_target, None, None

    for _ in range(_PYSPARK_POLL_MAX_ATTEMPTS):
        still_running = False
        for side, j in jobs.items():
            if j["run"] and not j["run"]["is_running"]:
                continue
            try:
                j["run"] = j["connector"].get_notebook_job(j["notebook_id"], j["job_id"])
            except Exception as e:
                return "ERROR", evaluated_query, None, f"Could not read the {side} PySpark job's status: {e}", rule_target, None, None
            if j["run"]["is_running"]:
                still_running = True
        if not still_running:
            break
        time.sleep(_PYSPARK_POLL_INTERVAL_SECONDS)
    else:
        return "ERROR", evaluated_query, None, \
            "Timed out waiting for the PySpark jobs to finish (over 8 minutes) - check the Fabric portal directly.", \
            rule_target, None, None

    rows = {}
    for side, j in jobs.items():
        if j["run"]["status"] != "Completed":
            return "ERROR", evaluated_query, None, \
                j["run"]["failure_reason"] or f'{side} PySpark job ended with status "{j["run"]["status"]}"', \
                rule_target, None, None
        try:
            raw = j["connector"].read_onelake_file(j["container_id"], j["result_path"])
            rows[side] = json.loads(raw)
        except Exception as e:
            return "ERROR", evaluated_query, None, f"{side} PySpark job finished but its result couldn't be read: {e}", rule_target, None, None
        finally:
            try:
                j["connector"].cleanup_staging_file(j["container_id"], j["result_path"])
            except Exception:
                pass
        if not isinstance(rows[side], dict):
            return "ERROR", evaluated_query, None, f"{side} PySpark result was not a JSON object: {rows[side]!r}", rule_target, None, None

    return _compare_dual_rows(rows["source"], rows["destination"], evaluated_query, rule_target)


def _run_dual_script_check(tc, mapping, source_connector, destination_connector):
    """
    One script per side, each returning a single row with a 'value' column;
    the engine runs each on its OWN connector/container and compares the two
    values. This is the only way to check both sides at once when they live on
    different systems (Local source, Fabric destination, ...) - a single SQL
    statement can't span two connections, which is the same reason
    row_count_match and column_parity are shaped this way.

    The scripts stay independent on purpose: each is written in its own side's
    column names, so a rename between source and destination - exactly the drift
    this tool exists to catch - doesn't break the check.

    Both scripts pass through the connector-level SELECT-only guard on
    execution (connectors/sql_guard.py), so nothing extra is needed here.
    """
    source_sql = tc.get("script_text")
    destination_sql = tc.get("destination_script_text")
    rule_target = (
        f"{', '.join(mapping['source_tables'])} -> {', '.join(mapping['destination_tables'])}"
    )
    evaluated_query = f"[source] {source_sql}  |  [destination] {destination_sql}"

    if not source_sql or not destination_sql:
        return "ERROR", evaluated_query, None, \
            "Both a source and a destination script are required for this check.", rule_target, None, None

    if tc.get("script_type") != "sql":
        return _run_dual_pyspark_check(tc, mapping, source_connector, destination_connector, evaluated_query, rule_target)

    try:
        source_row = source_connector.run_query(mapping["source_container_id"], source_sql)
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Source script failed: {e}", rule_target, None, None

    try:
        destination_row = destination_connector.run_query(mapping["destination_container_id"], destination_sql)
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Destination script failed: {e}", rule_target, None, None

    return _compare_dual_rows(source_row, destination_row, evaluated_query, rule_target)


def _run_row_count_match(tc, mapping, source_connector, destination_connector):
    """
    Sums COUNT(*) across whichever source tables and destination tables
    this specific test case selected (each side is one summed query, run
    through that side's own connector/container), then compares in Python.
    """
    source_tables = tc["row_count_source_tables"]
    destination_tables = tc["row_count_destination_tables"]
    rule_target = f"{', '.join(source_tables)} -> {', '.join(destination_tables)}"

    source_query = _build_summed_count_query(source_tables)
    destination_query = _build_summed_count_query(destination_tables)
    evaluated_query = f"[source] {source_query}  |  [destination] {destination_query}"

    try:
        source_row = source_connector.run_query(mapping["source_container_id"], source_query)
        source_count = source_row["cnt"] if source_row else None
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Source count query failed: {e}", rule_target, None, None

    try:
        dest_row = destination_connector.run_query(mapping["destination_container_id"], destination_query)
        dest_count = dest_row["cnt"] if dest_row else None
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Destination count query failed: {e}", rule_target, None, None

    passed = source_count == dest_count
    details = f"source tables {source_tables} = {source_count} rows | destination tables {destination_tables} = {dest_count} rows"
    violations = abs(source_count - dest_count) if source_count is not None and dest_count is not None else None
    total_rows = source_count
    return ("PASS" if passed else "FAIL"), evaluated_query, details, None, rule_target, violations, total_rows


def _sql_string_literal(value):
    """
    A well-formed SQL string literal. Table names arrive already double-quoted
    for Fabric ('"dbo"."t"'), so only single quotes need escaping.
    """
    return "'" + str(value).replace("'", "''") + "'"


def _build_column_union(column_by_table, tagged=False):
    """
    One table -> a plain "SELECT col AS val FROM t". Multiple tables ->
    UNION ALL'd together first - same shape as _build_summed_count_query,
    just aliasing to "val" so the outer aggregate query never has to
    re-quote the real column name. Works identically for 1 or many tables,
    no single-table special case needed (unlike the count-query version).

    Takes {table: physical column} rather than one shared column name so each
    arm can select a differently-named column - that's what lets a validation
    whose tables use different names for the same field be checked at all.
    Callers build the dict with s2d.column_map.columns_for(), which resolves
    to the given name verbatim when no map covers a table, so an unmapped
    validation produces byte-identical SQL to before this took a dict.

    tagged=True also selects the table name as a literal "src_table" column, so
    one GROUP BY ROLLUP query can report a metric per table AND overall in a
    single round trip. cross_table_parity leaves it False, keeping its SQL
    exactly as it was.
    """
    parts = []
    for t, column in column_by_table.items():
        tag = f"{_sql_string_literal(t)} AS src_table, " if tagged else ""
        parts.append(f'SELECT {tag}"{column}" AS val FROM {t}')
    return " UNION ALL ".join(parts)


# One entry per column_parity metric. "exprs" is spliced into the SELECT list of
# the ROLLUP wrapper in _build_parity_metric_query, so adding a metric is one
# entry here plus one line in PARITY_VALIDATION_TYPES.
#
# "kind" says how to compare and render the result:
#   'count'  - one number; the per-table figures do sum to the overall one
#   'count2' - total rows plus non-null rows
#   'range'  - a low/high pair compared as a pair
#   'scalar' - one non-additive value compared for equality (never subtracted -
#              Data Freshness' metric is a timestamp string)
#
# "additive" is presentational only: it decides whether the breakdown is
# rendered as summands. COUNT(DISTINCT) across two tables is NOT the sum of
# their per-table counts, so showing those as if they added up would read as a
# bug - see _format_breakdown.
#
# "Categorical Constraint" is deliberately absent: it compares the SET of
# distinct values rather than an aggregate, so it takes the _run_categorical_
# parity path instead.
PARITY_METRICS = {
    "Null Value Constraint": {
        "kind": "count", "additive": True, "label": "nulls",
        "exprs": "SUM(CASE WHEN val IS NULL THEN 1 ELSE 0 END) AS metric",
    },
    "Uniqueness Constraint": {
        "kind": "count", "additive": False, "label": "distinct values",
        "exprs": "COUNT(DISTINCT val) AS metric",
    },
    "Boundary Range Constraint": {
        "kind": "range", "additive": False, "label": "range",
        "exprs": "MIN(val) AS min_val, MAX(val) AS max_val",
    },
    "Record Volume Integrity": {
        "kind": "count2", "additive": True, "label": "volume",
        "exprs": "COUNT(*) AS metric, COUNT(val) AS non_null",
    },
    "Length Constraint": {
        "kind": "range", "additive": False, "label": "value length",
        "exprs": ("MIN(LENGTH(CAST(val AS VARCHAR))) AS min_val, "
                  "MAX(LENGTH(CAST(val AS VARCHAR))) AS max_val"),
    },
    "Regex Pattern Check": {
        "kind": "count", "additive": True, "label": "values matching the pattern",
        "needs_pattern": True,
        "exprs": ("SUM(CASE WHEN val IS NOT NULL AND "
                  "regexp_matches(CAST(val AS VARCHAR), '<pattern>') THEN 1 ELSE 0 END) AS metric"),
    },
    "Data Freshness": {
        "kind": "scalar", "additive": False, "label": "most recent value",
        "exprs": "CAST(MAX(val) AS VARCHAR) AS metric",
    },
}

# The metrics the engine can actually execute. Both app.py's request validation
# and ai_service.py's prompt vocabulary import this, so the API can never
# accept - nor the AI propose - a metric with no implementation behind it.
PARITY_VALIDATION_TYPES = list(PARITY_METRICS) + ["Categorical Constraint"]


def _build_parity_metric_query(validation_type, column_by_table, parity_config=None):
    spec = PARITY_METRICS.get(validation_type)
    if not spec:
        raise ValueError(f"Unsupported column_parity validation_type: {validation_type}")

    exprs = spec["exprs"]
    if spec.get("needs_pattern"):
        pattern = (parity_config or {}).get("pattern")
        if not pattern:
            raise ValueError(f"{validation_type} needs a regex pattern - edit the test case and set one")
        exprs = exprs.replace("<pattern>", str(pattern).replace("'", "''"))

    union_sql = _build_column_union(column_by_table, tagged=True)
    # ROLLUP yields one row per table PLUS a grand-total row (src_table IS
    # NULL). The total row is aggregated over the whole union, so it stays
    # correct for metrics that don't sum across tables - COUNT(DISTINCT) above
    # all, where summing the per-table rows would be plain wrong.
    return (
        f"SELECT src_table, {exprs} FROM ({union_sql}) combined "
        f"GROUP BY ROLLUP (src_table) ORDER BY src_table"
    )


def _split_rollup(rows):
    """
    (grand_total_row, {table: row}) out of a ROLLUP result. The grand total is
    the row with a NULL src_table - unambiguous because every tagged union arm
    selects a non-null string literal for it.
    """
    total = None
    per_table = {}
    for row in rows:
        if row["src_table"] is None:
            total = row
        else:
            per_table[row["src_table"]] = row
    return total, per_table


def _format_breakdown(per_table, render, additive):
    """
    The per-table detail the tester needs to see WHICH table is off. Additive
    metrics read as summands ("(a: 3, b: 4)"); non-additive ones get an
    explicit "per-table:" prefix so nobody reads "distinct = 2 (a: 2, b: 2)"
    as broken arithmetic.
    """
    if len(per_table) < 2:
        return ""  # a single table adds nothing the overall figure didn't say
    if additive:
        return " (" + ", ".join(f"{t}: {render(r)}" for t, r in per_table.items()) + ")"
    return " (per-table: " + ", ".join(f"{t} {render(r)}" for t, r in per_table.items()) + ")"


def _build_row_count_query(column_by_table):
    union_sql = _build_column_union(column_by_table)
    return f"SELECT COUNT(*) AS cnt FROM ({union_sql}) combined"


def _destination_total_rows(mapping, destination_connector, destination_columns):
    """
    Total rows scanned on the destination side - the "current state" being
    validated. Best-effort: a failure here doesn't invalidate the parity result
    itself, so it just leaves total_rows as None.
    """
    try:
        row = destination_connector.run_query(
            mapping["destination_container_id"],
            _build_row_count_query(destination_columns),
        )
        return row["cnt"] if row else None
    except Exception:
        return None


def _run_column_parity(tc, mapping, source_connector, destination_connector):
    """
    Computes the same metric across ALL selected source tables (unioned
    together) and ALL selected destination tables (unioned together), then
    compares them - proving the data that left the source side arrived on the
    destination side intact, the same way _run_row_count_match proves it at the
    whole-table level. See PARITY_METRICS for the metrics available.

    Multiple tables per side are expected to represent similarly-shaped data
    (e.g. daily partitions) - and they no longer have to share a column name,
    since the validation's column map lets each table contribute its own
    physical column under one shared name.

    Every metric query is grouped with ROLLUP, so one round trip per side
    returns both the overall figure that decides PASS/FAIL and the per-table
    figures that tell the tester WHICH table is responsible.
    """
    validation_type = tc["validation_type"]
    source_tables, source_column = tc["source_tables"], tc["source_column"]
    destination_tables, destination_column = tc["destination_tables"], tc["destination_column"]
    rule_target = (
        f"{', '.join(source_tables)}.{source_column} -> "
        f"{', '.join(destination_tables)}.{destination_column}"
    )

    source_columns = column_map.columns_for(mapping, "source", source_tables, source_column)
    destination_columns = column_map.columns_for(mapping, "destination", destination_tables, destination_column)

    if validation_type == "Categorical Constraint":
        return _run_categorical_parity(
            mapping, source_connector, destination_connector,
            source_columns, destination_columns, rule_target,
        )

    try:
        source_query = _build_parity_metric_query(validation_type, source_columns, tc.get("parity_config"))
        destination_query = _build_parity_metric_query(validation_type, destination_columns, tc.get("parity_config"))
    except ValueError as e:
        # A misconfigured test case (unknown metric, or a regex check saved
        # without a pattern) is the test case's fault, not the data's - surface
        # it as ERROR rather than letting it read as a data failure.
        return "ERROR", "", None, str(e), rule_target, None, None

    evaluated_query = f"[source] {source_query}  |  [destination] {destination_query}"

    try:
        source_rows = source_connector.run_query_all(mapping["source_container_id"], source_query)
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Source query failed: {e}", rule_target, None, None

    try:
        destination_rows = destination_connector.run_query_all(mapping["destination_container_id"], destination_query)
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Destination query failed: {e}", rule_target, None, None

    source_total, source_per_table = _split_rollup(source_rows)
    destination_total, destination_per_table = _split_rollup(destination_rows)
    if source_total is None or destination_total is None:
        return "ERROR", evaluated_query, None, \
            "Metric query returned no grand-total row - the tables may be empty", rule_target, None, None

    total_rows = _destination_total_rows(mapping, destination_connector, destination_columns)

    spec = PARITY_METRICS[validation_type]
    kind, label, additive = spec["kind"], spec["label"], spec["additive"]

    if kind == "range":
        def render(row):
            return f"[{row['min_val']}, {row['max_val']}]"
        source_value = (source_total["min_val"], source_total["max_val"])
        destination_value = (destination_total["min_val"], destination_total["max_val"])
        passed = source_value == destination_value
        source_text, destination_text = render(source_total), render(destination_total)
        # A range mismatch isn't naturally a per-row count without embedding the
        # bound values back into a follow-up query (risky across value types -
        # dates, decimals, etc - through a plain SQL string), so this is a flag
        # rather than an exact row-level violation count.
        violations = 0 if passed else 1
    elif kind == "count2":
        def render(row):
            return f"{row['metric']} rows/{row['non_null']} non-null"
        source_value = (source_total["metric"], source_total["non_null"])
        destination_value = (destination_total["metric"], destination_total["non_null"])
        passed = source_value == destination_value
        source_text, destination_text = render(source_total), render(destination_total)
        violations = sum(
            abs(s - d) for s, d in zip(source_value, destination_value)
            if s is not None and d is not None
        )
    else:  # 'count' and 'scalar'
        def render(row):
            return row["metric"]
        source_value, destination_value = source_total["metric"], destination_total["metric"]
        passed = source_value == destination_value
        source_text, destination_text = str(source_value), str(destination_value)
        # 'scalar' metrics are never subtracted - Data Freshness compares a
        # timestamp rendered as a string.
        violations = (
            abs(source_value - destination_value)
            if kind == "count" and source_value is not None and destination_value is not None
            else (0 if passed else 1)
        )

    details = (
        f"source {label} = {source_text}{_format_breakdown(source_per_table, render, additive)}"
        f" | destination {label} = {destination_text}"
        f"{_format_breakdown(destination_per_table, render, additive)}"
    )
    return ("PASS" if passed else "FAIL"), evaluated_query, details, None, rule_target, violations, total_rows


def _run_categorical_parity(mapping, source_connector, destination_connector,
                             source_columns, destination_columns, rule_target):
    """
    Compares the SET of distinct values on each side rather than a count, so a
    value that exists on the source but never arrived on the destination is
    caught even when both sides happen to hold the same NUMBER of distinct
    values - which a plain distinct-count comparison would pass.

    Fetches distinct (table, value) pairs and diffs in Python, the same shape
    _run_cross_table_parity_check uses for keys. That transports values rather
    than an aggregate, so this is for low-cardinality columns (status codes,
    flags, categories), not free text.
    """
    def build(column_by_table):
        return (
            f"SELECT DISTINCT src_table, CAST(val AS VARCHAR) AS val "
            f"FROM ({_build_column_union(column_by_table, tagged=True)}) combined"
        )

    source_query, destination_query = build(source_columns), build(destination_columns)
    evaluated_query = f"[source] {source_query}  |  [destination] {destination_query}"

    try:
        source_rows = source_connector.run_query_all(mapping["source_container_id"], source_query)
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Source query failed: {e}", rule_target, None, None

    try:
        destination_rows = destination_connector.run_query_all(mapping["destination_container_id"], destination_query)
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Destination query failed: {e}", rule_target, None, None

    # Which table(s) each value came from, so a missing value can be traced back
    # to the table that still has it.
    source_origin = {}
    for row in source_rows:
        source_origin.setdefault(row["val"], []).append(row["src_table"])
    destination_values = {row["val"] for row in destination_rows}
    source_values = set(source_origin)

    missing_in_destination = source_values - destination_values
    extra_in_destination = destination_values - source_values
    passed = not missing_in_destination and not extra_in_destination

    def _sample(values, n=5):
        return ", ".join(repr(v) for v in sorted(values, key=lambda v: (v is None, str(v)))[:n])

    parts = []
    if missing_in_destination:
        traced = ", ".join(
            f"{v!r} (in {', '.join(source_origin[v])})"
            for v in sorted(missing_in_destination, key=lambda v: (v is None, str(v)))[:5]
        )
        parts.append(f"{len(missing_in_destination)} source value(s) absent from destination: {traced}")
    if extra_in_destination:
        parts.append(
            f"{len(extra_in_destination)} destination value(s) with no source counterpart: "
            f"{_sample(extra_in_destination)}"
        )
    details = "; ".join(parts) if parts else (
        f"all {len(source_values)} distinct value(s) present on both sides"
    )

    violations = len(missing_in_destination) + len(extra_in_destination)
    total_rows = _destination_total_rows(mapping, destination_connector, destination_columns)
    return ("PASS" if passed else "FAIL"), evaluated_query, details, None, rule_target, violations, total_rows


ALL_COLUMNS = "*"

# Whole-row comparison pulls both sides into memory to diff them, so it needs a
# ceiling. Past this it stops and names the check to use instead, rather than
# stalling the run or quietly comparing a truncated slice - a parity check that
# silently compared half a table would be worse than no check at all.
MAX_ROWS_PER_SIDE = 100000


# Pre-filter: only try strptime when the string *looks* like a date (digit
# groups separated by - or /).  This avoids accidentally re-formatting IDs or
# version numbers that happen to share the same character pattern.
_DATE_LIKE = re.compile(r'^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$')

# Ordered from most-specific to least-specific. %y (2-digit year) is tried
# after all %Y variants so 2001-09-25 is matched as YYYY-MM-DD, not re-parsed
# as a 2-digit-year format by accident.
_DATE_FORMATS = [
    '%Y-%m-%d',   # 2001-09-25  (ISO — source DuckDB)
    '%Y/%m/%d',   # 2001/09/25
    '%d-%m-%Y',   # 25-09-2001
    '%d/%m/%Y',   # 25/09/2001
    '%m-%d-%Y',   # 09-25-2001  (US)
    '%m/%d/%Y',   # 09/25/2001  (US)
    '%y-%m-%d',   # 01-09-25    (Fabric 2-digit-year — the common mismatch)
    '%d-%m-%y',   # 25-09-01
    '%d/%m/%y',   # 25/09/01
]


def _try_iso_date(text):
    """
    Parse a date-like string from any of the formats the two sides commonly
    use and return it as YYYY-MM-DD, or None if it doesn't match any of them.
    Python's %y: 00-68 -> 2000-2068, 69-99 -> 1969-1999 — good enough for
    the business-data range this app handles.
    """
    if not _DATE_LIKE.match(text):
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _normalise_cell(value):
    """
    One text form per value, so 5 and "5" - or a DATE and a TIMESTAMP at
    midnight - don't read as a mismatch just because the two systems typed them
    differently. Also normalises date strings to ISO YYYY-MM-DD regardless of
    the format the source connector chose (e.g. DuckDB returns 2001-09-25 while
    Fabric may store 01-09-25 as a 2-digit-year string) — enforced here on
    every whole-row parity check so callers never need per-test workarounds.
    """
    if value is None:
        return ""
    text = str(value).strip()
    if len(text) == 19 and text[4:5] == "-" and text.endswith("00:00:00"):
        return text[:10]                      # midnight timestamp == that date
    if text.endswith(".0"):                   # 5.0 from a float vs 5 from an int
        head = text[:-2]
        if head.lstrip("-").isdigit():
            return head
    iso = _try_iso_date(text)
    if iso:
        return iso
    return text


def _rename_to_common(mapping, side, table, row):
    """
    Re-key one row by the validation's common names wherever the column map
    covers this table, so "OrderID" here and "order_no" there line up. Columns
    the map doesn't mention keep their own name.
    """
    names = column_map.common_names(mapping, side, [table])
    if not names:
        return row
    physical_to_common = {}
    for common in names:
        physical = column_map.physical_column(mapping, side, table, common)
        if physical:
            physical_to_common[physical] = common
    return {physical_to_common.get(k, k): v for k, v in row.items()}


def _collect_side(connector, container_id, tables, mapping, side):
    """
    Every row of every selected table on one side, keyed by common name.
    Returns (rows, error).

    One query per table rather than a UNION: the selected tables need not share
    a shape, and unioning mismatched shapes is exactly the kind of silent wrong
    answer this check exists to catch.
    """
    rows = []
    for table in tables:
        try:
            fetched = connector.run_query_all(container_id, "SELECT * FROM " + table)
        except Exception as e:
            return None, "%s query failed on %s: %s" % (side.capitalize(), table, e)
        rows.extend(_rename_to_common(mapping, side, table, r) for r in fetched)
        if len(rows) > MAX_ROWS_PER_SIDE:
            return None, (
                "The %s side has more than %s rows, which is too many to compare row by row. "
                "Use Row count match for volume, or Column parity on a key column - both "
                "compare without transporting every row." % (side, format(MAX_ROWS_PER_SIDE, ",")))
    return rows, None


def _run_full_row_parity(tc, mapping, source_connector, destination_connector):
    """
    Does every row exist, identically, on both sides - across ALL columns?

    The single-key mode answers "is every key present". This answers "did the
    data arrive unchanged", which is the question a tester actually has after a
    load. Rows are compared as MULTISETS, so a row duplicated on one side only
    counts as a difference instead of being absorbed by set semantics.

    Only columns present on both sides are compared, and any skipped are named:
    a destination carrying an extra audit column shouldn't fail every row, but
    nobody should have to guess that it was ignored.
    """
    source_tables = tc["source_target_tables"]
    destination_tables = tc["destination_target_tables"]
    rule_target = "%s -> %s (all columns)" % (", ".join(source_tables), ", ".join(destination_tables))
    evaluated_query = "[source] SELECT * FROM %s  |  [destination] SELECT * FROM %s" % (
        ", ".join(source_tables), ", ".join(destination_tables))

    source_rows, error = _collect_side(
        source_connector, mapping["source_container_id"], source_tables, mapping, "source")
    if error:
        return "ERROR", evaluated_query, None, error, rule_target, None, None
    destination_rows, error = _collect_side(
        destination_connector, mapping["destination_container_id"], destination_tables,
        mapping, "destination")
    if error:
        return "ERROR", evaluated_query, None, error, rule_target, None, None

    if not source_rows and not destination_rows:
        return ("PASS", evaluated_query, "Both sides are empty - nothing to compare.",
                None, rule_target, 0, 0)

    source_columns = set().union(*(r.keys() for r in source_rows)) if source_rows else set()
    destination_columns = set().union(*(r.keys() for r in destination_rows)) if destination_rows else set()
    shared = sorted(source_columns & destination_columns)
    if not shared:
        return ("ERROR", evaluated_query, None,
                "The two sides share no column names, so their rows can't be lined up. "
                "Map the columns first, or compare a single key column instead.",
                rule_target, None, None)

    def fingerprint(row):
        return tuple(_normalise_cell(row.get(c)) for c in shared)

    source_counts = Counter(fingerprint(r) for r in source_rows)
    destination_counts = Counter(fingerprint(r) for r in destination_rows)
    missing = source_counts - destination_counts
    extra = destination_counts - source_counts

    missing_total = sum(missing.values())
    extra_total = sum(extra.values())
    matched = len(source_rows) - missing_total
    skipped = sorted((source_columns | destination_columns) - set(shared))

    def sample(counter, n=3):
        out = []
        for row in list(counter)[:n]:
            pairs = ", ".join("%s=%s" % (c, v) for c, v in zip(shared, row) if v != "")
            out.append("(" + pairs[:120] + ")")
        return "; ".join(out)

    if not missing_total and not extra_total:
        details = ("All %s rows are present on both sides, identical across %d compared column(s)."
                   % (format(len(source_rows), ","), len(shared)))
    else:
        parts = ["%s of %s source rows matched" % (format(matched, ","), format(len(source_rows), ","))]
        if missing_total:
            parts.append("%s row(s) missing from destination e.g. %s"
                         % (format(missing_total, ","), sample(missing)))
        if extra_total:
            parts.append("%s row(s) in destination with no source match e.g. %s"
                         % (format(extra_total, ","), sample(extra)))
        details = ". ".join(parts) + "."
    if skipped:
        details += (" Columns on only one side, so not compared: %s%s."
                    % (", ".join(skipped[:8]), " ..." if len(skipped) > 8 else ""))

    passed = not missing_total and not extra_total
    return (("PASS" if passed else "FAIL"), evaluated_query, details, None, rule_target,
            missing_total + extra_total, len(source_rows))


def _run_cross_table_parity_check(tc, mapping, source_connector, destination_connector):
    """
    Engine-computed key-based existence check: fetches the full set of
    key_column values from the unioned source_target_tables and the
    unioned destination_target_tables (via run_query_all - a full result
    set, not run_query's one-row contract), then diffs the two sets in
    Python. This is deliberately never a single cross-database SQL join -
    it runs exactly one query per side and compares in Python, so it works
    identically whether source and destination share a connector or are
    completely different systems (Fabric source, Local destination, etc).

    key_column holds either a physical column name (the original behaviour,
    when every selected table happens to name the key identically) or a common
    name from the validation's column map - resolved independently per side
    AND per table below, which is what makes "3 source tables + 1 destination,
    same data under different column names" checkable.
    """
    if tc.get("key_column") == ALL_COLUMNS:
        return _run_full_row_parity(tc, mapping, source_connector, destination_connector)

    key_column = tc["key_column"]
    source_tables = tc["source_target_tables"]
    destination_tables = tc["destination_target_tables"]
    rule_target = f"{', '.join(source_tables)} -> {', '.join(destination_tables)} (key: {key_column})"

    source_columns = column_map.columns_for(mapping, "source", source_tables, key_column)
    destination_columns = column_map.columns_for(mapping, "destination", destination_tables, key_column)

    source_query = (
        f"SELECT COALESCE(CAST(TRY_CAST(val AS DATE) AS VARCHAR), CAST(val AS VARCHAR)) AS val "
        f"FROM ({_build_column_union(source_columns)}) combined"
    )
    destination_query = (
        f"SELECT COALESCE(CAST(TRY_CAST(val AS DATE) AS VARCHAR), CAST(val AS VARCHAR)) AS val "
        f"FROM ({_build_column_union(destination_columns)}) combined"
    )
    evaluated_query = f"[source] {source_query}  |  [destination] {destination_query}"

    try:
        source_rows = source_connector.run_query_all(mapping["source_container_id"], source_query)
        source_keys = {r["val"] for r in source_rows}
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Source query failed: {e}", rule_target, None, None

    try:
        destination_rows = destination_connector.run_query_all(mapping["destination_container_id"], destination_query)
        destination_keys = {r["val"] for r in destination_rows}
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Destination query failed: {e}", rule_target, None, None

    missing_in_destination = source_keys - destination_keys
    extra_in_destination = destination_keys - source_keys
    passed = not missing_in_destination and not extra_in_destination

    def _sample(values, n=5):
        return ", ".join(str(v) for v in list(values)[:n])

    # Say what held, not only what broke: a bare count reads as a warning even
    # when everything is fine.
    if passed:
        details = "All %s '%s' values are present on both sides." % (
            format(len(source_keys), ","), key_column)
    else:
        matched = len(source_keys) - len(missing_in_destination)
        parts = ["%s of %s source '%s' values matched" % (
            format(matched, ","), format(len(source_keys), ","), key_column)]
        if missing_in_destination:
            parts.append("%s missing from destination (e.g. %s)" % (
                format(len(missing_in_destination), ","), _sample(missing_in_destination)))
        if extra_in_destination:
            parts.append("%s in destination with no source row (e.g. %s)" % (
                format(len(extra_in_destination), ","), _sample(extra_in_destination)))
        details = ". ".join(parts) + "."

    violations = len(missing_in_destination) + len(extra_in_destination)
    total_rows = len(source_keys)

    return ("PASS" if passed else "FAIL"), evaluated_query, details, None, rule_target, violations, total_rows


def run_single_test_case(tc, mapping, source_connector, destination_connector):
    """
    Shared by both the "run everything" pipeline and the "run just this
    one" button - one place that decides how a test case gets executed,
    so the two code paths can never drift apart.
    Returns (status, evaluated_query, details, error_message, rule_target, violations, total_rows).
    """
    if tc["check_type"] == "row_count_match":
        return _run_row_count_match(tc, mapping, source_connector, destination_connector)
    if tc["check_type"] == "column_parity":
        return _run_column_parity(tc, mapping, source_connector, destination_connector)
    if tc["check_type"] == "sql" and tc.get("check_scope") == "cross_table_parity":
        return _run_cross_table_parity_check(tc, mapping, source_connector, destination_connector)
    if tc["check_type"] == "sql" and tc.get("check_scope") == "dual_script":
        return _run_dual_script_check(tc, mapping, source_connector, destination_connector)
    return _run_sql_check(tc, mapping, source_connector, destination_connector)


def _persist_run(mapping_id, results, compute_time_seconds, suite_id=None):
    started_at = datetime.now(timezone.utc).isoformat()
    pass_count = sum(1 for r in results if r["status"] == "PASS")
    fail_count = len(results) - pass_count
    overall_status = "passed" if fail_count == 0 else "failed"

    run_id = results_store.create_run(
        mapping_id=mapping_id, status=overall_status,
        total_checkpoints=len(results), pass_count=pass_count, fail_count=fail_count,
        compute_time_seconds=compute_time_seconds,
        started_at=started_at, finished_at=datetime.now(timezone.utc).isoformat(),
        suite_id=suite_id,
    )
    for r in results:
        results_store.add_result(run_id=run_id, **r)
    return run_id


def _execute_test_cases(source_connector, destination_connector, mapping, test_cases):
    """Runs the given test cases and returns (results, compute_time_seconds)."""
    run_start = time.monotonic()
    results = []
    for i, tc in enumerate(test_cases, start=1):
        label = f"TC-{i:03d}"
        test_start = time.monotonic()
        status, evaluated_query, details, error_message, rule_target, violations, total_rows = run_single_test_case(
            tc, mapping, source_connector, destination_connector
        )
        results.append({
            "test_case_id": tc["id"], "test_label": label, "test_name": tc["name"],
            "rule_target": rule_target, "validation_type": tc["validation_type"],
            "status": status, "evaluated_query": evaluated_query,
            "details": details, "error_message": error_message,
            "violations": violations, "total_rows": total_rows,
            "duration_seconds": round(time.monotonic() - test_start, 3),
            "executed_at": datetime.now(timezone.utc).isoformat(),
        })
    return results, round(time.monotonic() - run_start, 3)


def run_pipeline(source_connector, destination_connector, mapping, test_cases):
    """Runs every test case attached to a mapping, in one run record."""
    results, compute_time_seconds = _execute_test_cases(
        source_connector, destination_connector, mapping, test_cases
    )
    return _persist_run(mapping["id"], results, compute_time_seconds)


def run_suite(source_connector, destination_connector, mapping, suite_id, test_cases):
    """Runs the given (already active-filtered) test cases and tags the run with suite_id."""
    results, compute_time_seconds = _execute_test_cases(
        source_connector, destination_connector, mapping, test_cases
    )
    run_id = _persist_run(mapping["id"], results, compute_time_seconds, suite_id=suite_id)

    # Covers both a manual "Run" click and a scheduled fire - run_suite is
    # the one function both paths call, so this is the single point of
    # truth for "a test suite ran" regardless of what triggered it.
    passed = sum(1 for r in results if r["status"] == "PASS")
    notifications_db.record_notification(
        "suite_run",
        f'Test suite on "{mapping["name"]}" finished: {passed} of {len(results)} checks passed.',
    )
    return run_id


def run_one(source_connector, destination_connector, mapping, test_case):
    """Runs exactly one test case, still recorded as a normal run (total_checkpoints=1)."""
    run_start = time.monotonic()
    status, evaluated_query, details, error_message, rule_target, violations, total_rows = run_single_test_case(
        test_case, mapping, source_connector, destination_connector
    )
    compute_time_seconds = round(time.monotonic() - run_start, 3)
    result = {
        "test_case_id": test_case["id"], "test_label": "TC-001", "test_name": test_case["name"],
        "rule_target": rule_target, "validation_type": test_case["validation_type"],
        "status": status, "evaluated_query": evaluated_query,
        "details": details, "error_message": error_message,
        "violations": violations, "total_rows": total_rows,
        "duration_seconds": compute_time_seconds,
        "executed_at": datetime.now(timezone.utc).isoformat(),
    }
    return _persist_run(mapping["id"], [result], compute_time_seconds)
