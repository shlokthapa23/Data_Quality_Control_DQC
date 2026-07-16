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
    rule_target = tc.get("target_table") or ", ".join(
        mapping["source_tables"] if tc["target"] == "source" else mapping["destination_tables"]
    )

    if tc["script_type"] != "sql":
        return "ERROR", tc["script_text"], None, \
            "PySpark execution isn't wired up yet - use a SQL script for live runs.", rule_target

    if tc["target"] == "source":
        connector, container_id = source_connector, mapping["source_container_id"]
    else:
        connector, container_id = destination_connector, mapping["destination_container_id"]

    try:
        row = connector.run_query(container_id, tc["script_text"])
        passed, details = _interpret_row(row)
        return ("PASS" if passed else "FAIL"), tc["script_text"], details, None, rule_target
    except Exception as e:
        return "ERROR", tc["script_text"], None, str(e), rule_target


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
        return "ERROR", evaluated_query, None, f"Source count query failed: {e}", rule_target

    try:
        dest_row = destination_connector.run_query(mapping["destination_container_id"], destination_query)
        dest_count = dest_row["cnt"] if dest_row else None
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Destination count query failed: {e}", rule_target

    passed = source_count == dest_count
    details = f"source tables {source_tables} = {source_count} rows | destination tables {destination_tables} = {dest_count} rows"
    return ("PASS" if passed else "FAIL"), evaluated_query, details, None, rule_target


def run_single_test_case(tc, mapping, source_connector, destination_connector):
    """
    Shared by both the "run everything" pipeline and the "run just this
    one" button - one place that decides how a test case gets executed,
    so the two code paths can never drift apart.
    Returns (status, evaluated_query, details, error_message, rule_target).
    """
    if tc["check_type"] == "row_count_match":
        return _run_row_count_match(tc, mapping, source_connector, destination_connector)
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
        status, evaluated_query, details, error_message, rule_target = run_single_test_case(
            tc, mapping, source_connector, destination_connector
        )
        results.append({
            "test_case_id": tc["id"], "test_label": label, "test_name": tc["name"],
            "rule_target": rule_target, "validation_type": tc["validation_type"],
            "status": status, "evaluated_query": evaluated_query,
            "details": details, "error_message": error_message,
        })

    compute_time_seconds = round(time.monotonic() - run_start, 3)
    return _persist_run(mapping["id"], results, compute_time_seconds)


def run_one(source_connector, destination_connector, mapping, test_case):
    """Runs exactly one test case, still recorded as a normal run (total_checkpoints=1)."""
    run_start = time.monotonic()
    status, evaluated_query, details, error_message, rule_target = run_single_test_case(
        test_case, mapping, source_connector, destination_connector
    )
    result = {
        "test_case_id": test_case["id"], "test_label": "TC-001", "test_name": test_case["name"],
        "rule_target": rule_target, "validation_type": test_case["validation_type"],
        "status": status, "evaluated_query": evaluated_query,
        "details": details, "error_message": error_message,
    }
    compute_time_seconds = round(time.monotonic() - run_start, 3)
    return _persist_run(mapping["id"], [result], compute_time_seconds)