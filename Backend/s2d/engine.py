import time
from datetime import datetime, timezone

from s2d import db as s2d_db


def _interpret_row(row):
    """
    A 'sql' test-case script must return one row with a 'passed' column
    (any of 1/0, True/False, 'true'/'false') and optionally a 'details'
    column. Anything else is treated as a malformed test case, not a
    silent pass - we'd rather surface that loudly than guess.
    """
    if row is None:
        return False, "Query returned no rows - expected exactly one row with a 'passed' column"

    if "passed" not in row:
        return False, f"Query result has no 'passed' column (columns returned: {list(row.keys())})"

    raw = row["passed"]
    if isinstance(raw, bool):
        passed = raw
    elif isinstance(raw, (int, float)):
        passed = bool(raw)
    elif isinstance(raw, str):
        passed = raw.strip().lower() in ("1", "true", "yes")
    else:
        return False, f"Could not interpret 'passed' value: {raw!r}"

    details = row.get("details")
    return passed, details


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


def _run_sql_check(tc, mapping, source_connector, destination_connector):
    # target_tables (plural) supersedes the legacy singular target_table;
    # fall back to it for any not-yet-backfilled row, then to the mapping's
    # full table list for that side if neither is set.
    target_tables = tc.get("target_tables") or ([tc["target_table"]] if tc.get("target_table") else None)
    rule_target = ", ".join(target_tables) if target_tables else ", ".join(
        mapping["source_tables"] if tc["target"] == "source" else mapping["destination_tables"]
    )

    if tc["script_type"] != "sql":
        return "ERROR", tc["script_text"], None, \
            "PySpark execution isn't wired up yet - use a SQL script for live runs.", rule_target, None, None

    if tc["target"] == "source":
        connector, container_id = source_connector, mapping["source_container_id"]
    else:
        connector, container_id = destination_connector, mapping["destination_container_id"]

    try:
        row = connector.run_query(container_id, tc["script_text"])
        passed, details = _interpret_row(row)
        # Optional - a script can additionally return "violations"/"total_rows"
        # columns to populate the Results table's row-level counts; scripts
        # written before this existed simply don't have them, so both fall
        # back to None (rendered as '-' in the UI) rather than being required.
        violations = row.get("violations") if row else None
        total_rows = row.get("total_rows") if row else None
        return ("PASS" if passed else "FAIL"), tc["script_text"], details, None, rule_target, violations, total_rows
    except Exception as e:
        return "ERROR", tc["script_text"], None, str(e), rule_target, None, None


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


def _build_column_union(tables, column):
    """
    One table -> a plain "SELECT col AS val FROM t". Multiple tables ->
    UNION ALL'd together first - same shape as _build_summed_count_query,
    just aliasing to "val" so the outer aggregate query never has to
    re-quote the real column name. Works identically for 1 or many tables,
    no single-table special case needed (unlike the count-query version).
    """
    quoted = f'"{column}"'
    parts = [f"SELECT {quoted} AS val FROM {t}" for t in tables]
    return " UNION ALL ".join(parts)


def _build_parity_metric_query(validation_type, tables, column):
    union_sql = _build_column_union(tables, column)
    if validation_type == "Null Value Constraint":
        return f"SELECT SUM(CASE WHEN val IS NULL THEN 1 ELSE 0 END) AS metric FROM ({union_sql}) combined"
    if validation_type == "Uniqueness Constraint":
        return f"SELECT COUNT(DISTINCT val) AS metric FROM ({union_sql}) combined"
    if validation_type == "Boundary Range Constraint":
        return f"SELECT MIN(val) AS min_val, MAX(val) AS max_val FROM ({union_sql}) combined"
    raise ValueError(f"Unsupported column_parity validation_type: {validation_type}")


def _build_row_count_query(tables, column):
    union_sql = _build_column_union(tables, column)
    return f"SELECT COUNT(*) AS cnt FROM ({union_sql}) combined"


def _run_column_parity(tc, mapping, source_connector, destination_connector):
    """
    Computes the same metric (null count / distinct count / min-max range)
    across ALL selected source tables (unioned together) and ALL selected
    destination tables (unioned together), then compares them - proving
    the data that left the source side arrived on the destination side
    intact, the same way _run_row_count_match proves it at the
    whole-table level. Multiple tables per side are expected to share the
    same column name and represent similarly-shaped data (e.g. daily
    partitions), same assumption row_count_match already makes.
    """
    validation_type = tc["validation_type"]
    source_tables, source_column = tc["source_tables"], tc["source_column"]
    destination_tables, destination_column = tc["destination_tables"], tc["destination_column"]
    rule_target = (
        f"{', '.join(source_tables)}.{source_column} -> "
        f"{', '.join(destination_tables)}.{destination_column}"
    )

    source_query = _build_parity_metric_query(validation_type, source_tables, source_column)
    destination_query = _build_parity_metric_query(validation_type, destination_tables, destination_column)
    evaluated_query = f"[source] {source_query}  |  [destination] {destination_query}"

    try:
        source_row = source_connector.run_query(mapping["source_container_id"], source_query)
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Source query failed: {e}", rule_target, None, None

    try:
        destination_row = destination_connector.run_query(mapping["destination_container_id"], destination_query)
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Destination query failed: {e}", rule_target, None, None

    # Total rows scanned on the destination side - the "current state"
    # being validated. Best-effort: a failure here doesn't invalidate the
    # parity result itself, so it just leaves total_rows as None.
    total_rows = None
    try:
        total_row = destination_connector.run_query(
            mapping["destination_container_id"],
            _build_row_count_query(destination_tables, destination_column),
        )
        total_rows = total_row["cnt"] if total_row else None
    except Exception:
        total_rows = None

    if validation_type == "Boundary Range Constraint":
        source_min, source_max = source_row["min_val"], source_row["max_val"]
        dest_min, dest_max = destination_row["min_val"], destination_row["max_val"]
        passed = source_min == dest_min and source_max == dest_max
        details = f"source range = [{source_min}, {source_max}] | destination range = [{dest_min}, {dest_max}]"
        # A range mismatch isn't naturally a per-row count without embedding
        # the bound values back into a follow-up query (risky across value
        # types - dates, decimals, etc - through a plain SQL string), so this
        # is a flag rather than an exact row-level violation count.
        violations = 0 if passed else 1
    else:
        source_metric = source_row["metric"]
        dest_metric = destination_row["metric"]
        label = "nulls" if validation_type == "Null Value Constraint" else "distinct values"
        passed = source_metric == dest_metric
        details = f"source {label} = {source_metric} | destination {label} = {dest_metric}"
        violations = (
            abs(source_metric - dest_metric)
            if source_metric is not None and dest_metric is not None else None
        )

    return ("PASS" if passed else "FAIL"), evaluated_query, details, None, rule_target, violations, total_rows


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
    """
    key_column = tc["key_column"]
    source_tables = tc["source_target_tables"]
    destination_tables = tc["destination_target_tables"]
    rule_target = f"{', '.join(source_tables)} -> {', '.join(destination_tables)} (key: {key_column})"

    source_query = f"SELECT val FROM ({_build_column_union(source_tables, key_column)}) combined"
    destination_query = f"SELECT val FROM ({_build_column_union(destination_tables, key_column)}) combined"
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

    details_parts = []
    if missing_in_destination:
        details_parts.append(
            f"{len(missing_in_destination)} key(s) in source missing from destination (e.g. {_sample(missing_in_destination)})"
        )
    if extra_in_destination:
        details_parts.append(
            f"{len(extra_in_destination)} key(s) in destination with no matching source row (e.g. {_sample(extra_in_destination)})"
        )
    details = "; ".join(details_parts) if details_parts else f"all {len(source_keys)} key(s) matched on both sides"

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
    return _run_sql_check(tc, mapping, source_connector, destination_connector)


def _persist_run(mapping_id, results, compute_time_seconds):
    started_at = datetime.now(timezone.utc).isoformat()
    pass_count = sum(1 for r in results if r["status"] == "PASS")
    fail_count = len(results) - pass_count
    overall_status = "passed" if fail_count == 0 else "failed"

    run_id = s2d_db.create_run(
        mapping_id=mapping_id, status=overall_status,
        total_checkpoints=len(results), pass_count=pass_count, fail_count=fail_count,
        compute_time_seconds=compute_time_seconds,
        started_at=started_at, finished_at=datetime.now(timezone.utc).isoformat(),
    )
    for r in results:
        s2d_db.add_result(run_id=run_id, **r)
    return run_id


def run_pipeline(source_connector, destination_connector, mapping, test_cases):
    """Runs every test case attached to a mapping, in one run record."""
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

    compute_time_seconds = round(time.monotonic() - run_start, 3)
    return _persist_run(mapping["id"], results, compute_time_seconds)


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
