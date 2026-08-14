import time
from datetime import datetime, timezone

from s2d import column_map
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
    A 'dual_script' side must return one row with a 'value' column. Same stance
    as _interpret_row: a malformed script is surfaced loudly rather than guessed
    into a pass, because silently comparing None to None would look like a
    healthy PASS.
    Returns (value, error_message) - error_message is None when valid.
    """
    if row is None:
        return None, f"The {side} script returned no rows - expected exactly one row with a 'value' column"
    if "value" not in row:
        return None, (f"The {side} script's result has no 'value' column "
                      f"(columns returned: {list(row.keys())})")
    return row["value"], None


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
        # Whatever else the script selected is the tester's own output - show it.
        # A script computing `COUNT(*) AS male_count` is asking a question, and a
        # bare PASS with the answer discarded makes them go and re-run it by hand.
        extras = _describe_extra_columns(row, _SQL_CHECK_RESERVED)
        if extras:
            details = f"{details} | {extras}" if details else extras
        return ("PASS" if passed else "FAIL"), tc["script_text"], details, None, rule_target, violations, total_rows
    except Exception as e:
        return "ERROR", tc["script_text"], None, str(e), rule_target, None, None


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

    if tc.get("script_type") != "sql":
        return "ERROR", evaluated_query, None, \
            "PySpark execution isn't wired up yet - use a SQL script for live runs.", rule_target, None, None
    if not source_sql or not destination_sql:
        return "ERROR", evaluated_query, None, \
            "Both a source and a destination script are required for this check.", rule_target, None, None

    try:
        source_row = source_connector.run_query(mapping["source_container_id"], source_sql)
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Source script failed: {e}", rule_target, None, None

    try:
        destination_row = destination_connector.run_query(mapping["destination_container_id"], destination_sql)
    except Exception as e:
        return "ERROR", evaluated_query, None, f"Destination script failed: {e}", rule_target, None, None

    source_value, error = _interpret_value_row(source_row, "source")
    if error:
        return "ERROR", evaluated_query, None, error, rule_target, None, None
    destination_value, error = _interpret_value_row(destination_row, "destination")
    if error:
        return "ERROR", evaluated_query, None, error, rule_target, None, None

    passed = source_value == destination_value
    details = f"source value = {source_value} | destination value = {destination_value}"
    # Each side may also return a 'details' column to explain its own number, and
    # anything else it selected is surfaced too - same reasoning as the
    # single-side path, so the two Custom SQL modes don't behave differently.
    extra = []
    for side, r in (("source", source_row), ("destination", destination_row)):
        parts = [p for p in (r.get("details"), _describe_extra_columns(r, _DUAL_SCRIPT_RESERVED)) if p]
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
    if tc["check_type"] == "sql" and tc.get("check_scope") == "dual_script":
        return _run_dual_script_check(tc, mapping, source_connector, destination_connector)
    return _run_sql_check(tc, mapping, source_connector, destination_connector)


def _persist_run(mapping_id, results, compute_time_seconds, suite_id=None):
    started_at = datetime.now(timezone.utc).isoformat()
    pass_count = sum(1 for r in results if r["status"] == "PASS")
    fail_count = len(results) - pass_count
    overall_status = "passed" if fail_count == 0 else "failed"

    run_id = s2d_db.create_run(
        mapping_id=mapping_id, status=overall_status,
        total_checkpoints=len(results), pass_count=pass_count, fail_count=fail_count,
        compute_time_seconds=compute_time_seconds,
        started_at=started_at, finished_at=datetime.now(timezone.utc).isoformat(),
        suite_id=suite_id,
    )
    for r in results:
        s2d_db.add_result(run_id=run_id, **r)
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
    return _persist_run(mapping["id"], results, compute_time_seconds, suite_id=suite_id)


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
