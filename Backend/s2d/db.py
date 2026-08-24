import json
import uuid
from datetime import datetime, timezone

from catalog.db import get_conn  # reuse the same catalog.db connection helper


def _migrate_stale_schema_if_needed():
    """
    s2d_mappings changed shape again (single source_table/destination_table
    strings -> source_tables/destination_tables JSON arrays, to support
    picking multiple tables per side). Same situation as last time:
    CREATE TABLE IF NOT EXISTS won't touch an existing table with the old
    columns, so detect that and drop the S2D tables to recreate fresh.
    Only s2d_* tables are affected - connectors and the Harvest catalog
    are untouched.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='s2d_mappings'"
        ).fetchone()
        if not row:
            return  # nothing to migrate, fresh install

        columns = {r[1] for r in conn.execute("PRAGMA table_info(s2d_mappings)").fetchall()}
        if "source_tables" in columns:
            return  # already on the new schema

        for table in ("s2d_test_results", "s2d_test_runs", "s2d_test_cases", "s2d_mappings"):
            conn.execute(f"DROP TABLE IF EXISTS {table}")


def _add_missing_test_case_columns():
    """
    Additive migration: s2d_test_cases gained origin/severity/active/
    description columns for the AI sample-based rule generator. Existing
    rows get the defaults (origin='manual', severity='error', active=1) so
    they render correctly in the new rule-list UI without needing backfill.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='s2d_test_cases'"
        ).fetchone()
        if not row:
            return  # fresh install - CREATE TABLE below already includes the columns

        existing = {r[1] for r in conn.execute("PRAGMA table_info(s2d_test_cases)").fetchall()}
        if "origin" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'")
        if "severity" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN severity TEXT NOT NULL DEFAULT 'error'")
        if "active" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
        if "description" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN description TEXT")
        if "source_table" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN source_table TEXT")
        if "source_column" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN source_column TEXT")
        if "destination_table" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN destination_table TEXT")
        if "destination_column" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN destination_column TEXT")

        # column_parity gained multi-table support - source_table/destination_table
        # (single string) are superseded by source_tables/destination_tables (JSON
        # arrays). Old columns are kept (unused going forward) rather than dropped,
        # and existing column_parity rows get backfilled into the new array shape.
        if "source_tables" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN source_tables TEXT")
        if "destination_tables" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN destination_tables TEXT")

        # Backfilled in Python (not raw SQL string concat) since Fabric table
        # names are themselves already double-quoted (e.g. '"dbo"."table"'),
        # which would corrupt a naive '["' || col || '"]' JSON string build.
        stale_rows = conn.execute("""
            SELECT id, source_table, destination_table FROM s2d_test_cases
            WHERE check_type = 'column_parity' AND source_tables IS NULL AND source_table IS NOT NULL
        """).fetchall()
        for row in stale_rows:
            conn.execute(
                "UPDATE s2d_test_cases SET source_tables = ?, destination_tables = ? WHERE id = ?",
                (json.dumps([row["source_table"]]), json.dumps([row["destination_table"]]), row["id"]),
            )

        # 'sql' checks gained multi-table support (target_tables, JSON array,
        # supersedes the single target_table) and a check_scope sub-mode:
        # 'single_side' (today's behavior, now multi-table-capable) or
        # 'cross_table_parity' (new - engine-computed key-column existence
        # check, no arbitrary SQL). Both new columns are additive; existing
        # target_table stays in the schema, unused going forward.
        if "target_tables" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN target_tables TEXT")
        if "check_scope" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN check_scope TEXT")
        if "key_column" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN key_column TEXT")
        if "source_target_tables" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN source_target_tables TEXT")
        if "destination_target_tables" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN destination_target_tables TEXT")

        # column_parity grew from 3 comparison metrics to 8; the ones that need
        # a parameter (today only Regex Pattern Check's pattern) keep it here as
        # JSON. Nullable with nothing to backfill - the 3 original metrics are
        # all parameterless, so existing rows are already complete.
        if "parity_config" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN parity_config TEXT")

        # 'sql' checks gained a third scope, 'dual_script': one script per side,
        # each returning a 'value' the engine compares - the only way to check
        # both sides at once when they live on different systems. The source
        # script reuses script_text, so single_side rows need no backfill.
        if "destination_script_text" not in existing:
            conn.execute("ALTER TABLE s2d_test_cases ADD COLUMN destination_script_text TEXT")

        stale_sql_rows = conn.execute("""
            SELECT id, target_table FROM s2d_test_cases
            WHERE check_type = 'sql' AND (target_tables IS NULL OR check_scope IS NULL)
        """).fetchall()
        for row in stale_sql_rows:
            target_tables_json = json.dumps([row["target_table"]]) if row["target_table"] else None
            conn.execute(
                "UPDATE s2d_test_cases SET target_tables = COALESCE(target_tables, ?), check_scope = COALESCE(check_scope, 'single_side') WHERE id = ?",
                (target_tables_json, row["id"]),
            )


def init_s2d_tables():
    _migrate_stale_schema_if_needed()

    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS s2d_mappings (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,

                source_connector_id TEXT NOT NULL,
                source_connector_name TEXT NOT NULL,
                source_container_id TEXT NOT NULL,
                source_container_name TEXT NOT NULL,
                source_tables TEXT NOT NULL,       -- JSON array of table names

                destination_connector_id TEXT NOT NULL,
                destination_connector_name TEXT NOT NULL,
                destination_container_id TEXT NOT NULL,
                destination_container_name TEXT NOT NULL,
                destination_tables TEXT NOT NULL,  -- JSON array of table names

                -- Opt-in per-validation column map: JSON array of
                -- {name, source:{table:col}, destination:{table:col}}, letting
                -- differently-named columns across tables share one common name.
                -- NULL when the tester hasn't opted in - see s2d/column_map.py.
                column_map TEXT,

                -- 'source_to_destination' (compare two sides) or 'source_only'
                -- (check a source before there is anything to compare it to,
                -- e.g. proving a file's quality before loading it anywhere).
                -- The destination_* columns above are NOT NULL, so a
                -- source_only row stores empty strings and an empty table list
                -- rather than NULL - dropping NOT NULL would mean rebuilding
                -- the table, and migrations here are additive only.
                validation_kind TEXT NOT NULL DEFAULT 'source_to_destination',

                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS s2d_test_cases (
                id TEXT PRIMARY KEY,
                mapping_id TEXT NOT NULL,
                name TEXT NOT NULL,
                validation_type TEXT NOT NULL,     -- e.g. "Null Value Constraint"
                check_type TEXT NOT NULL,           -- 'sql' | 'row_count_match' | 'column_parity'

                -- 'sql' checks only:
                target TEXT,                        -- 'source' | 'destination' (single_side scope only)
                target_table TEXT,                  -- deprecated, superseded by target_tables (JSON array)
                target_tables TEXT,                  -- JSON array (subset of that side's tables), unioned together - single_side scope only
                check_scope TEXT,                    -- 'single_side' | 'cross_table_parity' (only meaningful for check_type='sql')
                key_column TEXT,                     -- join/match column - cross_table_parity scope only
                source_target_tables TEXT,           -- JSON array - cross_table_parity scope only
                destination_target_tables TEXT,      -- JSON array - cross_table_parity scope only
                script_type TEXT,                   -- 'sql' | 'pyspark'
                script_text TEXT,                   -- the script; for dual_script scope this is the SOURCE script
                destination_script_text TEXT,       -- dual_script scope only - the destination-side script.
                                                    -- Both return one row with a 'value' column, which the
                                                    -- engine compares; see _run_dual_script_check.

                -- 'row_count_match' checks only:
                row_count_source_tables TEXT,       -- JSON array (subset of mapping.source_tables)
                row_count_destination_tables TEXT,  -- JSON array (subset of mapping.destination_tables)

                -- 'column_parity' checks only:
                source_table TEXT,       -- deprecated, superseded by source_tables (JSON array)
                source_column TEXT,
                destination_table TEXT,  -- deprecated, superseded by destination_tables (JSON array)
                destination_column TEXT,
                source_tables TEXT,       -- JSON array (subset of mapping.source_tables), unioned together
                destination_tables TEXT,  -- JSON array (subset of mapping.destination_tables), unioned together
                parity_config TEXT,       -- JSON object of extra params for the chosen metric
                                          -- (today: {"pattern": "..."} for Regex Pattern Check).
                                          -- One JSON column rather than a typed column per
                                          -- param, so a future metric needs no new migration.

                origin TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'ai'
                severity TEXT NOT NULL DEFAULT 'error',  -- 'critical' | 'error' | 'warning'
                active INTEGER NOT NULL DEFAULT 1,
                description TEXT,

                created_at TEXT NOT NULL,
                FOREIGN KEY (mapping_id) REFERENCES s2d_mappings(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS s2d_test_runs (
                id TEXT PRIMARY KEY,
                mapping_id TEXT NOT NULL,
                suite_id TEXT,                       -- NULL for legacy "Run all" runs
                status TEXT NOT NULL,               -- 'passed' | 'failed'
                total_checkpoints INTEGER NOT NULL,
                pass_count INTEGER NOT NULL,
                fail_count INTEGER NOT NULL,
                compute_time_seconds REAL NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT NOT NULL,
                FOREIGN KEY (mapping_id) REFERENCES s2d_mappings(id),
                FOREIGN KEY (suite_id) REFERENCES s2d_test_suites(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS s2d_test_results (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                test_case_id TEXT NOT NULL,
                test_label TEXT NOT NULL,           -- "TC-001" style display id
                test_name TEXT NOT NULL,
                rule_target TEXT NOT NULL,           -- e.g. "students, students2 -> students_info"
                validation_type TEXT NOT NULL,
                status TEXT NOT NULL,                -- 'PASS' | 'FAIL' | 'ERROR'
                evaluated_query TEXT,
                details TEXT,
                error_message TEXT,
                violations INTEGER,
                total_rows INTEGER,
                duration_seconds REAL,
                executed_at TEXT,
                FOREIGN KEY (run_id) REFERENCES s2d_test_runs(id)
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS s2d_test_suites (
                id TEXT PRIMARY KEY,
                mapping_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (mapping_id) REFERENCES s2d_mappings(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS s2d_test_suite_cases (
                suite_id TEXT NOT NULL,
                test_case_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY (suite_id, test_case_id),
                FOREIGN KEY (suite_id) REFERENCES s2d_test_suites(id),
                FOREIGN KEY (test_case_id) REFERENCES s2d_test_cases(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS s2d_suite_schedules (
                id TEXT PRIMARY KEY,
                suite_id TEXT NOT NULL,
                trigger_type TEXT NOT NULL,
                trigger_config TEXT NOT NULL,
                timezone TEXT NOT NULL DEFAULT 'UTC',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                last_fired_at TEXT,
                last_run_id TEXT,
                last_status TEXT,
                misfire_count INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (suite_id) REFERENCES s2d_test_suites(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS harvest_schedules (
                id TEXT PRIMARY KEY,
                connector_id TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'incremental',
                selected_items TEXT,             -- JSON array of {id, name, type}; NULL = legacy "harvest all live"
                trigger_type TEXT NOT NULL,
                trigger_config TEXT NOT NULL,
                timezone TEXT NOT NULL DEFAULT 'UTC',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                last_fired_at TEXT,
                last_status TEXT,
                misfire_count INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pipeline_schedules (
                id TEXT PRIMARY KEY,
                connector_id TEXT NOT NULL,
                pipeline_item_id TEXT NOT NULL,   -- the Fabric DataPipeline item id
                pipeline_name TEXT,               -- display name, cached so a renamed/deleted
                                                  -- pipeline still shows something meaningful
                trigger_type TEXT NOT NULL,
                trigger_config TEXT NOT NULL,
                timezone TEXT NOT NULL DEFAULT 'UTC',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                last_fired_at TEXT,
                last_run_id TEXT,                 -- Fabric job-instance id, like suite schedules
                last_status TEXT,
                misfire_count INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS schedule_events (
                id TEXT PRIMARY KEY,
                schedule_kind TEXT NOT NULL,
                schedule_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                run_id TEXT,
                fired_at TEXT NOT NULL,
                message TEXT
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_schedule_events_lookup
                ON schedule_events (schedule_kind, schedule_id, fired_at DESC)
        """)

    _add_missing_test_case_columns()
    _add_missing_test_result_columns()
    _add_missing_test_run_columns()
    _add_missing_mapping_columns()


def _add_missing_mapping_columns():
    """
    Additive migration: s2d_mappings gained column_map, the opt-in per-
    validation map of common column name -> physical column per table.
    Nullable with no default and nothing to backfill - a NULL column_map is
    precisely "the tester hasn't opted in", which every read path already
    treats as today's literal-name behaviour.

    Then validation_kind, which is 'source_to_destination' for every existing
    row - the default makes that true without a backfill - or 'source_only' for
    a validation that checks a source before it has a destination to compare
    against, which is the whole point of testing a file before loading it.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='s2d_mappings'"
        ).fetchone()
        if not row:
            return  # fresh install - CREATE TABLE above already includes the column

        existing = {r[1] for r in conn.execute("PRAGMA table_info(s2d_mappings)").fetchall()}
        if "column_map" not in existing:
            conn.execute("ALTER TABLE s2d_mappings ADD COLUMN column_map TEXT")
        if "validation_kind" not in existing:
            conn.execute(
                "ALTER TABLE s2d_mappings ADD COLUMN validation_kind TEXT "
                "NOT NULL DEFAULT 'source_to_destination'")


def _add_missing_test_run_columns():
    """
    Additive migration: s2d_test_runs gained suite_id so a run row can
    remember which test suite triggered it (NULL for legacy "Run all" runs).
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='s2d_test_runs'"
        ).fetchone()
        if not row:
            return  # fresh install - CREATE TABLE above already includes the column

        existing = {r[1] for r in conn.execute("PRAGMA table_info(s2d_test_runs)").fetchall()}
        if "suite_id" not in existing:
            conn.execute("ALTER TABLE s2d_test_runs ADD COLUMN suite_id TEXT")

        # harvest_schedules gained selected_items so scheduled harvests only
        # pull the user-chosen assets, not everything the connector sees.
        hs_row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='harvest_schedules'"
        ).fetchone()
        if hs_row:
            hs_existing = {r[1] for r in conn.execute("PRAGMA table_info(harvest_schedules)").fetchall()}
            if "selected_items" not in hs_existing:
                conn.execute("ALTER TABLE harvest_schedules ADD COLUMN selected_items TEXT")


def _add_missing_test_result_columns():
    """
    Additive migration: s2d_test_results gained violations/total_rows/
    duration_seconds/executed_at so the Results table can show real
    per-check numbers instead of just pass/fail. Existing rows simply get
    NULL for all four (rendered as '-' in the UI) since that historical
    data was never captured.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='s2d_test_results'"
        ).fetchone()
        if not row:
            return  # fresh install - CREATE TABLE above already includes the columns

        existing = {r[1] for r in conn.execute("PRAGMA table_info(s2d_test_results)").fetchall()}
        if "violations" not in existing:
            conn.execute("ALTER TABLE s2d_test_results ADD COLUMN violations INTEGER")
        if "total_rows" not in existing:
            conn.execute("ALTER TABLE s2d_test_results ADD COLUMN total_rows INTEGER")
        if "duration_seconds" not in existing:
            conn.execute("ALTER TABLE s2d_test_results ADD COLUMN duration_seconds REAL")
        if "executed_at" not in existing:
            conn.execute("ALTER TABLE s2d_test_results ADD COLUMN executed_at TEXT")


# --- Mappings ---------------------------------------------------------

def _mapping_row_to_dict(row):
    m = dict(row)
    m["source_tables"] = json.loads(m["source_tables"])
    m["destination_tables"] = json.loads(m["destination_tables"])
    # Always a list, never None - "no column map" and "an empty column map"
    # mean the same thing (nobody opted in) to every consumer.
    m["column_map"] = json.loads(m["column_map"]) if m.get("column_map") else []
    # Rows written before this column existed are source-to-destination.
    m["validation_kind"] = m.get("validation_kind") or "source_to_destination"
    return m


def create_mapping(name,
                    source_connector_id, source_connector_name, source_container_id,
                    source_container_name, source_tables,
                    destination_connector_id=None, destination_connector_name=None,
                    destination_container_id=None, destination_container_name=None,
                    destination_tables=None,
                    validation_kind="source_to_destination"):
    mapping_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    # A source_only validation has no destination at all. The columns are
    # NOT NULL, so store empties - every read path already treats an empty
    # table list as "nothing on that side".
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO s2d_mappings (
                id, name,
                source_connector_id, source_connector_name, source_container_id, source_container_name, source_tables,
                destination_connector_id, destination_connector_name, destination_container_id, destination_container_name, destination_tables,
                validation_kind, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            mapping_id, name,
            source_connector_id, source_connector_name, source_container_id, source_container_name, json.dumps(source_tables),
            destination_connector_id or "", destination_connector_name or "",
            destination_container_id or "", destination_container_name or "",
            json.dumps(destination_tables or []),
            validation_kind, now,
        ))
    return mapping_id


def list_mappings():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM s2d_mappings ORDER BY created_at DESC").fetchall()
        return [_mapping_row_to_dict(r) for r in rows]


def get_mapping(mapping_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM s2d_mappings WHERE id = ?", (mapping_id,)).fetchone()
        return _mapping_row_to_dict(row) if row else None


def rename_mapping(mapping_id, name):
    with get_conn() as conn:
        conn.execute("UPDATE s2d_mappings SET name = ? WHERE id = ?", (name, mapping_id))


def update_mapping_tables(mapping_id, source_tables=None, destination_tables=None):
    """
    Change which tables a test layer covers, without touching its connectors or
    containers - adding a newly-uploaded file to an existing layer, or dropping
    one that's no longer relevant.

    Each side is optional and updated independently, so passing only
    source_tables leaves the destination exactly as it was. Callers pass the
    full list for a side, not a delta: the picker always knows the whole
    selection, and a full replace can't drift out of step with it.
    """
    sets, params = [], []
    if source_tables is not None:
        sets.append("source_tables = ?")
        params.append(json.dumps(source_tables))
    if destination_tables is not None:
        sets.append("destination_tables = ?")
        params.append(json.dumps(destination_tables))
    if not sets:
        return
    params.append(mapping_id)
    with get_conn() as conn:
        conn.execute(f"UPDATE s2d_mappings SET {', '.join(sets)} WHERE id = ?", params)


def update_mapping_endpoint(mapping_id, side, connector_id, connector_name,
                             container_id, container_name, tables):
    """
    Repoints one side of a layer (source or destination) at a different
    connector+container+tables - a deliberate exception to update_mapping_tables'
    "connectors and containers stay fixed" rule above. Callers MUST have
    already deleted this mapping's test cases (delete_test_cases_for_mapping)
    before calling this: their stored SQL/rules were written against the OLD
    location, and there is no way to know if it still means anything once the
    layer points somewhere else.
    """
    if side not in ("source", "destination"):
        raise ValueError(f"Unknown side: {side!r}")
    with get_conn() as conn:
        conn.execute(f"""
            UPDATE s2d_mappings
            SET {side}_connector_id = ?, {side}_connector_name = ?,
                {side}_container_id = ?, {side}_container_name = ?,
                {side}_tables = ?
            WHERE id = ?
        """, (connector_id, connector_name, container_id, container_name,
              json.dumps(tables), mapping_id))


def mappings_using_connector(connector_id):
    """
    Every test layer that reads from or writes to this connector, with how much
    work is stored against each. Deleting a connector out from under these would
    leave layers pointing at a system that no longer exists, and their test
    cases erroring on the next run rather than saying why.
    """
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT m.id, m.name,
                   (SELECT COUNT(*) FROM s2d_test_cases tc WHERE tc.mapping_id = m.id) AS test_case_count,
                   (SELECT COUNT(*) FROM s2d_test_suites s WHERE s.mapping_id = m.id) AS suite_count
            FROM s2d_mappings m
            WHERE m.source_connector_id = ? OR m.destination_connector_id = ?
            ORDER BY m.name
        """, (connector_id, connector_id)).fetchall()
        return [dict(r) for r in rows]


def delete_mapping(mapping_id):
    """Deletes a mapping and everything that lives inside it - test cases,
    test suites, suite membership, and suite schedules. Run history
    (s2d_test_runs/s2d_test_results) is deliberately NOT cascaded here -
    HistoryPage already renders "(deleted validation)" for orphaned runs,
    keeping the audit trail intact after its validation is gone is the
    existing, deliberate design. Callers that also need the live
    APScheduler jobs for any suite_schedules deregistered before calling
    this (app.py's delete route does exactly that)."""
    with get_conn() as conn:
        conn.execute("""
            DELETE FROM s2d_suite_schedules
            WHERE suite_id IN (SELECT id FROM s2d_test_suites WHERE mapping_id = ?)
        """, (mapping_id,))
        conn.execute("""
            DELETE FROM s2d_test_suite_cases
            WHERE suite_id IN (SELECT id FROM s2d_test_suites WHERE mapping_id = ?)
        """, (mapping_id,))
        conn.execute("DELETE FROM s2d_test_suites WHERE mapping_id = ?", (mapping_id,))
        conn.execute("DELETE FROM s2d_test_cases WHERE mapping_id = ?", (mapping_id,))
        conn.execute("DELETE FROM s2d_mappings WHERE id = ?", (mapping_id,))


# --- Test cases ---------------------------------------------------------

def _test_case_row_to_dict(row):
    tc = dict(row)
    tc["row_count_source_tables"] = json.loads(tc["row_count_source_tables"]) if tc["row_count_source_tables"] else None
    tc["row_count_destination_tables"] = json.loads(tc["row_count_destination_tables"]) if tc["row_count_destination_tables"] else None
    tc["source_tables"] = json.loads(tc["source_tables"]) if tc["source_tables"] else None
    tc["destination_tables"] = json.loads(tc["destination_tables"]) if tc["destination_tables"] else None
    tc["target_tables"] = json.loads(tc["target_tables"]) if tc["target_tables"] else None
    tc["source_target_tables"] = json.loads(tc["source_target_tables"]) if tc["source_target_tables"] else None
    tc["destination_target_tables"] = json.loads(tc["destination_target_tables"]) if tc["destination_target_tables"] else None
    # Always a dict, never None - the engine reads .get("pattern") off it
    # unconditionally, and "no config" and "empty config" mean the same thing.
    tc["parity_config"] = json.loads(tc["parity_config"]) if tc.get("parity_config") else {}
    tc["active"] = bool(tc["active"])
    return tc


def create_test_case(mapping_id, name, validation_type, check_type,
                      target=None, target_table=None, script_type=None, script_text=None,
                      row_count_source_tables=None, row_count_destination_tables=None,
                      source_tables=None, source_column=None, destination_tables=None, destination_column=None,
                      target_tables=None, check_scope=None, key_column=None,
                      source_target_tables=None, destination_target_tables=None,
                      parity_config=None, destination_script_text=None,
                      origin='manual', severity='error', active=True, description=None):
    test_case_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO s2d_test_cases
                (id, mapping_id, name, validation_type, check_type, target, target_table,
                 script_type, script_text, destination_script_text,
                 row_count_source_tables, row_count_destination_tables,
                 source_tables, source_column, destination_tables, destination_column,
                 target_tables, check_scope, key_column, source_target_tables, destination_target_tables,
                 parity_config, origin, severity, active, description, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            test_case_id, mapping_id, name, validation_type, check_type, target, target_table,
            script_type, script_text, destination_script_text,
            json.dumps(row_count_source_tables) if row_count_source_tables is not None else None,
            json.dumps(row_count_destination_tables) if row_count_destination_tables is not None else None,
            json.dumps(source_tables) if source_tables is not None else None, source_column,
            json.dumps(destination_tables) if destination_tables is not None else None, destination_column,
            json.dumps(target_tables) if target_tables is not None else None, check_scope, key_column,
            json.dumps(source_target_tables) if source_target_tables is not None else None,
            json.dumps(destination_target_tables) if destination_target_tables is not None else None,
            json.dumps(parity_config) if parity_config else None,
            origin, severity, 1 if active else 0, description,
            now,
        ))
    return test_case_id


def update_test_case(test_case_id, name, validation_type, check_type,
                      target=None, target_table=None, script_type=None, script_text=None,
                      row_count_source_tables=None, row_count_destination_tables=None,
                      source_tables=None, source_column=None, destination_tables=None, destination_column=None,
                      target_tables=None, check_scope=None, key_column=None,
                      source_target_tables=None, destination_target_tables=None,
                      parity_config=None, destination_script_text=None,
                      severity=None, description=None):
    with get_conn() as conn:
        if severity is None:
            existing = conn.execute("SELECT severity FROM s2d_test_cases WHERE id = ?", (test_case_id,)).fetchone()
            severity = existing["severity"] if existing else 'error'
        conn.execute("""
            UPDATE s2d_test_cases SET
                name = ?, validation_type = ?, check_type = ?, target = ?, target_table = ?,
                script_type = ?, script_text = ?, destination_script_text = ?,
                row_count_source_tables = ?, row_count_destination_tables = ?,
                source_tables = ?, source_column = ?, destination_tables = ?, destination_column = ?,
                target_tables = ?, check_scope = ?, key_column = ?, source_target_tables = ?, destination_target_tables = ?,
                parity_config = ?, severity = ?, description = ?
            WHERE id = ?
        """, (
            name, validation_type, check_type, target, target_table, script_type, script_text,
            destination_script_text,
            json.dumps(row_count_source_tables) if row_count_source_tables is not None else None,
            json.dumps(row_count_destination_tables) if row_count_destination_tables is not None else None,
            json.dumps(source_tables) if source_tables is not None else None, source_column,
            json.dumps(destination_tables) if destination_tables is not None else None, destination_column,
            json.dumps(target_tables) if target_tables is not None else None, check_scope, key_column,
            json.dumps(source_target_tables) if source_target_tables is not None else None,
            json.dumps(destination_target_tables) if destination_target_tables is not None else None,
            json.dumps(parity_config) if parity_config else None,
            severity, description,
            test_case_id,
        ))


def set_test_case_active(test_case_id, active):
    with get_conn() as conn:
        conn.execute(
            "UPDATE s2d_test_cases SET active = ? WHERE id = ?",
            (1 if active else 0, test_case_id),
        )


def list_test_cases(mapping_id):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM s2d_test_cases WHERE mapping_id = ? ORDER BY created_at ASC",
            (mapping_id,),
        ).fetchall()
        return [_test_case_row_to_dict(r) for r in rows]


def get_test_case(test_case_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM s2d_test_cases WHERE id = ?", (test_case_id,)).fetchone()
        return _test_case_row_to_dict(row) if row else None


def delete_test_case(test_case_id):
    with get_conn() as conn:
        # Suite membership first - a dangling s2d_test_suite_cases row pointing
        # at a deleted test case is exactly the kind of orphan delete_mapping's
        # own cascade (above) is careful to avoid.
        conn.execute("DELETE FROM s2d_test_suite_cases WHERE test_case_id = ?", (test_case_id,))
        conn.execute("DELETE FROM s2d_test_cases WHERE id = ?", (test_case_id,))


def count_test_cases(mapping_id):
    """How many test cases a layer has - the number a Lakehouse-change
    confirmation needs to state honestly before anything is deleted."""
    with get_conn() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM s2d_test_cases WHERE mapping_id = ?", (mapping_id,)
        ).fetchone()[0]


def delete_test_cases_for_mapping(mapping_id):
    """
    Deletes every test case belonging to a mapping, and their suite
    membership - same cascade delete_mapping already does for test cases,
    minus the mapping/suites themselves. Used when a Lakehouse change makes a
    layer's existing test cases' stored SQL/rules point at the wrong system;
    the suites that contained them survive, just emptied. Returns the count
    deleted.
    """
    with get_conn() as conn:
        conn.execute("""
            DELETE FROM s2d_test_suite_cases
            WHERE test_case_id IN (SELECT id FROM s2d_test_cases WHERE mapping_id = ?)
        """, (mapping_id,))
        cursor = conn.execute("DELETE FROM s2d_test_cases WHERE mapping_id = ?", (mapping_id,))
        return cursor.rowcount


# --- Runs + results ---------------------------------------------------------

def create_run(mapping_id, status, total_checkpoints, pass_count, fail_count,
               compute_time_seconds, started_at, finished_at, suite_id=None):
    run_id = str(uuid.uuid4())
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO s2d_test_runs
                (id, mapping_id, suite_id, status, total_checkpoints, pass_count, fail_count,
                 compute_time_seconds, started_at, finished_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (run_id, mapping_id, suite_id, status, total_checkpoints, pass_count, fail_count,
              compute_time_seconds, started_at, finished_at))
    return run_id


def add_result(run_id, test_case_id, test_label, test_name, rule_target,
               validation_type, status, evaluated_query=None, details=None, error_message=None,
               violations=None, total_rows=None, duration_seconds=None, executed_at=None):
    result_id = str(uuid.uuid4())
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO s2d_test_results
                (id, run_id, test_case_id, test_label, test_name, rule_target,
                 validation_type, status, evaluated_query, details, error_message,
                 violations, total_rows, duration_seconds, executed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (result_id, run_id, test_case_id, test_label, test_name, rule_target,
              validation_type, status, evaluated_query, details, error_message,
              violations, total_rows, duration_seconds, executed_at))
    return result_id


def get_run(run_id):
    with get_conn() as conn:
        run_row = conn.execute("SELECT * FROM s2d_test_runs WHERE id = ?", (run_id,)).fetchone()
        if not run_row:
            return None
        run = dict(run_row)

        mapping_row = conn.execute(
            "SELECT * FROM s2d_mappings WHERE id = ?", (run["mapping_id"],)
        ).fetchone()
        run["mapping"] = _mapping_row_to_dict(mapping_row) if mapping_row else None

        result_rows = conn.execute(
            "SELECT * FROM s2d_test_results WHERE run_id = ? ORDER BY test_label ASC", (run_id,)
        ).fetchall()
        run["results"] = [dict(r) for r in result_rows]

        return run


def analytics_results(mapping_ids=None, basis="latest", include_orphans=False, since=None):
    """
    The result rows a dashboard should aggregate, with their run and test layer
    attached.

    basis='latest' takes only each layer's most recent run, so the numbers
    describe the data as it is NOW - re-running a layer after a fix moves them.
    basis='all' pools every run for those layers, which is what you want when a
    layer has only been run once or twice and the latest run alone says little.

    include_orphans covers runs whose test layer has since been deleted. They
    are excluded whenever a layer filter is applied - they cannot belong to a
    layer that was named, and counting them would make the totals impossible to
    reconcile with the filter. They ARE included in the unfiltered view, because
    "every test case that has been run" is exactly what that view answers, and
    this workspace's history is overwhelmingly made of them. They appear under
    "(deleted test layer)" rather than being folded into a surviving one.
    """
    where, params = [], []
    if mapping_ids:
        where.append(f"r.mapping_id IN ({','.join('?' * len(mapping_ids))})")
        params.extend(mapping_ids)
    if since:
        where.append("r.started_at >= ?")
        params.append(since)
    if basis == "latest":
        # The most recent run per layer WITHIN the window, not the most recent
        # overall - otherwise narrowing to "last month" would blank a layer whose
        # newest run predates it, instead of showing that layer's newest run
        # inside the period actually being asked about.
        sub_where = "r2.mapping_id = r.mapping_id"
        if since:
            sub_where += " AND r2.started_at >= ?"
        where.append(f"""r.started_at = (
            SELECT MAX(r2.started_at) FROM s2d_test_runs r2 WHERE {sub_where}
        )""")
        if since:
            params.append(since)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    join = "LEFT JOIN" if include_orphans else "JOIN"

    with get_conn() as conn:
        rows = conn.execute(f"""
            SELECT tr.*, r.mapping_id, r.started_at AS run_started_at, r.id AS run_id,
                   COALESCE(m.name, '(deleted test layer)') AS mapping_name
            FROM s2d_test_results tr
            JOIN s2d_test_runs r ON r.id = tr.run_id
            {join} s2d_mappings m ON m.id = r.mapping_id
            {clause}
            ORDER BY r.started_at ASC
        """, params).fetchall()
        return [dict(r) for r in rows]


def analytics_runs(mapping_ids=None, include_orphans=False, since=None):
    """
    Run-level history for the trend line. Always the full history for the layers
    in scope, whatever the basis - a trend across a single run isn't a trend.
    """
    where, params = [], []
    if mapping_ids:
        where.append(f"r.mapping_id IN ({','.join('?' * len(mapping_ids))})")
        params.extend(mapping_ids)
    if since:
        where.append("r.started_at >= ?")
        params.append(since)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    join = "LEFT JOIN" if include_orphans else "JOIN"
    with get_conn() as conn:
        rows = conn.execute(f"""
            SELECT r.id, r.mapping_id, r.started_at, r.status, r.pass_count, r.fail_count,
                   r.total_checkpoints, COALESCE(m.name, '(deleted test layer)') AS mapping_name
            FROM s2d_test_runs r
            {join} s2d_mappings m ON m.id = r.mapping_id
            {clause}
            ORDER BY r.started_at ASC
        """, params).fetchall()
        return [dict(r) for r in rows]


def analytics_orphaned_run_count():
    """Runs whose test layer has been deleted - excluded everywhere above."""
    with get_conn() as conn:
        return conn.execute("""
            SELECT COUNT(*) FROM s2d_test_runs r
            LEFT JOIN s2d_mappings m ON m.id = r.mapping_id
            WHERE m.id IS NULL
        """).fetchone()[0]


def prune_test_runs_before(cutoff_iso):
    """
    Deletes every s2d_test_run (and its s2d_test_results) started before
    cutoff_iso. Children before parent, same order delete_mapping already
    uses for its cascade, since s2d_test_results.run_id references
    s2d_test_runs.id. Returns the number of runs deleted, so the caller can
    log something other than silence.

    Retention policy (how far back cutoff_iso reaches) is decided by
    s2d.results_store, not here - this function only knows how to delete
    runs older than whatever cutoff it's given.
    """
    with get_conn() as conn:
        conn.execute("""
            DELETE FROM s2d_test_results WHERE run_id IN (
                SELECT id FROM s2d_test_runs WHERE started_at < ?
            )
        """, (cutoff_iso,))
        cursor = conn.execute("DELETE FROM s2d_test_runs WHERE started_at < ?", (cutoff_iso,))
        return cursor.rowcount


def list_runs(mapping_id=None):
    """
    Powers the History tab - joins in the mapping name and suite name so the
    list is readable without a second round-trip per row.
    """
    query = """
        SELECT r.*, m.name AS mapping_name, s.name AS suite_name
        FROM s2d_test_runs r
        LEFT JOIN s2d_mappings m ON m.id = r.mapping_id
        LEFT JOIN s2d_test_suites s ON s.id = r.suite_id
    """
    params = []
    if mapping_id:
        query += " WHERE r.mapping_id = ?"
        params.append(mapping_id)
    query += " ORDER BY r.started_at DESC"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]


# --- Test suites ---------------------------------------------------------

def create_suite(mapping_id, name, description, test_case_ids):
    suite_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO s2d_test_suites (id, mapping_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)",
            (suite_id, mapping_id, name, description, now),
        )
        for position, tc_id in enumerate(test_case_ids):
            conn.execute(
                "INSERT INTO s2d_test_suite_cases (suite_id, test_case_id, position) VALUES (?, ?, ?)",
                (suite_id, tc_id, position),
            )
    return suite_id


def list_suites(mapping_id=None):
    """
    Powers the Test Suites page. Includes mapping_name and test_case_count
    so the list is renderable without a round-trip per row.
    """
    query = """
        SELECT s.*, m.name AS mapping_name,
               (SELECT COUNT(*) FROM s2d_test_suite_cases sc WHERE sc.suite_id = s.id) AS test_case_count
        FROM s2d_test_suites s
        LEFT JOIN s2d_mappings m ON m.id = s.mapping_id
    """
    params = []
    if mapping_id:
        query += " WHERE s.mapping_id = ?"
        params.append(mapping_id)
    query += " ORDER BY s.created_at DESC"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]


def get_suite(suite_id):
    with get_conn() as conn:
        suite_row = conn.execute(
            "SELECT * FROM s2d_test_suites WHERE id = ?", (suite_id,)
        ).fetchone()
        if not suite_row:
            return None
        suite = dict(suite_row)

        mapping_row = conn.execute(
            "SELECT * FROM s2d_mappings WHERE id = ?", (suite["mapping_id"],)
        ).fetchone()
        suite["mapping"] = _mapping_row_to_dict(mapping_row) if mapping_row else None

        tc_rows = conn.execute("""
            SELECT tc.*
            FROM s2d_test_suite_cases sc
            JOIN s2d_test_cases tc ON tc.id = sc.test_case_id
            WHERE sc.suite_id = ?
            ORDER BY sc.position ASC
        """, (suite_id,)).fetchall()
        suite["test_cases"] = [_test_case_row_to_dict(r) for r in tc_rows]

        return suite


def update_suite(suite_id, name=None, description=None, test_case_ids=None):
    with get_conn() as conn:
        if name is not None or description is not None:
            existing = conn.execute(
                "SELECT name, description FROM s2d_test_suites WHERE id = ?", (suite_id,)
            ).fetchone()
            if not existing:
                return False
            new_name = name if name is not None else existing["name"]
            new_desc = description if description is not None else existing["description"]
            conn.execute(
                "UPDATE s2d_test_suites SET name = ?, description = ? WHERE id = ?",
                (new_name, new_desc, suite_id),
            )
        if test_case_ids is not None:
            conn.execute("DELETE FROM s2d_test_suite_cases WHERE suite_id = ?", (suite_id,))
            for position, tc_id in enumerate(test_case_ids):
                conn.execute(
                    "INSERT INTO s2d_test_suite_cases (suite_id, test_case_id, position) VALUES (?, ?, ?)",
                    (suite_id, tc_id, position),
                )
    return True


def delete_suite(suite_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM s2d_test_suite_cases WHERE suite_id = ?", (suite_id,))
        conn.execute("DELETE FROM s2d_test_suites WHERE id = ?", (suite_id,))


# --- Schedules --------------------------------------------------------------

def _schedule_row_to_dict(row):
    s = dict(row)
    if s.get("trigger_config"):
        s["trigger_config"] = json.loads(s["trigger_config"])
    if "selected_items" in s and s["selected_items"]:
        s["selected_items"] = json.loads(s["selected_items"])
    s["active"] = bool(s["active"])
    return s


def create_suite_schedule(suite_id, trigger_type, trigger_config, timezone_name):
    schedule_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO s2d_suite_schedules
                (id, suite_id, trigger_type, trigger_config, timezone, active, created_at)
            VALUES (?, ?, ?, ?, ?, 1, ?)
        """, (schedule_id, suite_id, trigger_type, json.dumps(trigger_config), timezone_name, now))
    return schedule_id


def list_suite_schedules(suite_id=None):
    query = """
        SELECT s.*, ts.name AS suite_name, ts.mapping_id AS suite_mapping_id
        FROM s2d_suite_schedules s
        LEFT JOIN s2d_test_suites ts ON ts.id = s.suite_id
    """
    params = []
    if suite_id:
        query += " WHERE s.suite_id = ?"
        params.append(suite_id)
    query += " ORDER BY s.created_at DESC"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return [_schedule_row_to_dict(r) for r in rows]


def get_suite_schedule(schedule_id):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM s2d_suite_schedules WHERE id = ?", (schedule_id,)
        ).fetchone()
        return _schedule_row_to_dict(row) if row else None


def update_suite_schedule(schedule_id, trigger_type=None, trigger_config=None, timezone_name=None, active=None):
    with get_conn() as conn:
        current = conn.execute(
            "SELECT * FROM s2d_suite_schedules WHERE id = ?", (schedule_id,)
        ).fetchone()
        if not current:
            return False
        new_trigger_type = trigger_type if trigger_type is not None else current["trigger_type"]
        new_trigger_config = json.dumps(trigger_config) if trigger_config is not None else current["trigger_config"]
        new_tz = timezone_name if timezone_name is not None else current["timezone"]
        new_active = (1 if active else 0) if active is not None else current["active"]
        conn.execute("""
            UPDATE s2d_suite_schedules
            SET trigger_type = ?, trigger_config = ?, timezone = ?, active = ?
            WHERE id = ?
        """, (new_trigger_type, new_trigger_config, new_tz, new_active, schedule_id))
    return True


def delete_suite_schedule(schedule_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM s2d_suite_schedules WHERE id = ?", (schedule_id,))


def touch_suite_schedule(schedule_id, last_status, last_run_id=None):
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            UPDATE s2d_suite_schedules
            SET last_fired_at = ?, last_status = ?, last_run_id = COALESCE(?, last_run_id)
            WHERE id = ?
        """, (now, last_status, last_run_id, schedule_id))


# The one place a schedule kind maps to its table. Deliberately a dict and not
# an if/else chain: this was `'s2d_suite_schedules' if kind == 'suite' else
# 'harvest_schedules'`, so ANY new kind silently issued its UPDATE against the
# harvest table - no exception, no log, misfire counts quietly lost. A KeyError
# on an unknown kind is far better than a wrong-table write.
SCHEDULE_TABLES = {
    'suite': 's2d_suite_schedules',
    'harvest': 'harvest_schedules',
    'pipeline': 'pipeline_schedules',
}


def bump_schedule_misfire(schedule_kind, schedule_id):
    table = SCHEDULE_TABLES[schedule_kind]
    with get_conn() as conn:
        conn.execute(f"UPDATE {table} SET misfire_count = misfire_count + 1 WHERE id = ?", (schedule_id,))


# Harvest schedules — same shape ---------------------------------------------

def create_harvest_schedule(connector_id, mode, trigger_type, trigger_config, timezone_name, selected_items=None):
    schedule_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO harvest_schedules
                (id, connector_id, mode, selected_items, trigger_type, trigger_config, timezone, active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        """, (schedule_id, connector_id, mode,
              json.dumps(selected_items) if selected_items is not None else None,
              trigger_type, json.dumps(trigger_config), timezone_name, now))
    return schedule_id


def list_harvest_schedules(connector_id=None):
    query = """
        SELECT h.*, c.name AS connector_name
        FROM harvest_schedules h
        LEFT JOIN connector_configs c ON c.id = h.connector_id
    """
    params = []
    if connector_id:
        query += " WHERE h.connector_id = ?"
        params.append(connector_id)
    query += " ORDER BY h.created_at DESC"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return [_schedule_row_to_dict(r) for r in rows]


def get_harvest_schedule(schedule_id):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM harvest_schedules WHERE id = ?", (schedule_id,)
        ).fetchone()
        return _schedule_row_to_dict(row) if row else None


def update_harvest_schedule(schedule_id, mode=None, trigger_type=None, trigger_config=None, timezone_name=None, active=None, selected_items=None):
    with get_conn() as conn:
        current = conn.execute(
            "SELECT * FROM harvest_schedules WHERE id = ?", (schedule_id,)
        ).fetchone()
        if not current:
            return False
        new_mode = mode if mode is not None else current["mode"]
        new_trigger_type = trigger_type if trigger_type is not None else current["trigger_type"]
        new_trigger_config = json.dumps(trigger_config) if trigger_config is not None else current["trigger_config"]
        new_tz = timezone_name if timezone_name is not None else current["timezone"]
        new_active = (1 if active else 0) if active is not None else current["active"]
        new_selected = json.dumps(selected_items) if selected_items is not None else current["selected_items"]
        conn.execute("""
            UPDATE harvest_schedules
            SET mode = ?, selected_items = ?, trigger_type = ?, trigger_config = ?, timezone = ?, active = ?
            WHERE id = ?
        """, (new_mode, new_selected, new_trigger_type, new_trigger_config, new_tz, new_active, schedule_id))
    return True


def delete_harvest_schedule(schedule_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM harvest_schedules WHERE id = ?", (schedule_id,))


def touch_harvest_schedule(schedule_id, last_status):
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            UPDATE harvest_schedules
            SET last_fired_at = ?, last_status = ?
            WHERE id = ?
        """, (now, last_status, schedule_id))


# Pipeline schedules - same shape as suite schedules, which also carry a
# last_run_id (a Fabric job-instance id here, an S2D run id there) ------------

def create_pipeline_schedule(connector_id, pipeline_item_id, pipeline_name,
                              trigger_type, trigger_config, timezone_name):
    schedule_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO pipeline_schedules
                (id, connector_id, pipeline_item_id, pipeline_name,
                 trigger_type, trigger_config, timezone, active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        """, (schedule_id, connector_id, pipeline_item_id, pipeline_name,
              trigger_type, json.dumps(trigger_config), timezone_name, now))
    return schedule_id


def list_pipeline_schedules(connector_id=None, pipeline_item_id=None):
    # LEFT JOIN so a schedule whose connector was deleted still lists (with a
    # NULL name the UI renders as "(deleted connector)") rather than vanishing
    # while its job is still registered.
    query = """
        SELECT p.*, c.name AS connector_name
        FROM pipeline_schedules p
        LEFT JOIN connector_configs c ON c.id = p.connector_id
    """
    clauses, params = [], []
    if connector_id:
        clauses.append("p.connector_id = ?")
        params.append(connector_id)
    if pipeline_item_id:
        clauses.append("p.pipeline_item_id = ?")
        params.append(pipeline_item_id)
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY p.created_at DESC"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return [_schedule_row_to_dict(r) for r in rows]


def get_pipeline_schedule(schedule_id):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM pipeline_schedules WHERE id = ?", (schedule_id,)
        ).fetchone()
        return _schedule_row_to_dict(row) if row else None


def update_pipeline_schedule(schedule_id, trigger_type=None, trigger_config=None,
                              timezone_name=None, active=None):
    with get_conn() as conn:
        current = conn.execute(
            "SELECT * FROM pipeline_schedules WHERE id = ?", (schedule_id,)
        ).fetchone()
        if not current:
            return False
        new_trigger_type = trigger_type if trigger_type is not None else current["trigger_type"]
        new_trigger_config = json.dumps(trigger_config) if trigger_config is not None else current["trigger_config"]
        new_tz = timezone_name if timezone_name is not None else current["timezone"]
        new_active = (1 if active else 0) if active is not None else current["active"]
        conn.execute("""
            UPDATE pipeline_schedules
            SET trigger_type = ?, trigger_config = ?, timezone = ?, active = ?
            WHERE id = ?
        """, (new_trigger_type, new_trigger_config, new_tz, new_active, schedule_id))
    return True


def delete_pipeline_schedule(schedule_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM pipeline_schedules WHERE id = ?", (schedule_id,))


def delete_pipeline_schedules_for_connector(connector_id):
    """Ids of the rows removed, so the caller can deregister their live jobs."""
    with get_conn() as conn:
        ids = [r["id"] for r in conn.execute(
            "SELECT id FROM pipeline_schedules WHERE connector_id = ?", (connector_id,)
        ).fetchall()]
        conn.execute("DELETE FROM pipeline_schedules WHERE connector_id = ?", (connector_id,))
    return ids


def delete_harvest_schedules_for_connector(connector_id):
    """Ids of the rows removed, so the caller can deregister their live jobs."""
    with get_conn() as conn:
        ids = [r["id"] for r in conn.execute(
            "SELECT id FROM harvest_schedules WHERE connector_id = ?", (connector_id,)
        ).fetchall()]
        conn.execute("DELETE FROM harvest_schedules WHERE connector_id = ?", (connector_id,))
    return ids


def touch_pipeline_schedule(schedule_id, last_status, last_run_id=None):
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            UPDATE pipeline_schedules
            SET last_fired_at = ?, last_status = ?, last_run_id = COALESCE(?, last_run_id)
            WHERE id = ?
        """, (now, last_status, last_run_id, schedule_id))


# Schedule events ------------------------------------------------------------

def record_schedule_event(schedule_kind, schedule_id, event_type, run_id=None, message=None):
    event_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO schedule_events (id, schedule_kind, schedule_id, event_type, run_id, fired_at, message)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (event_id, schedule_kind, schedule_id, event_type, run_id, now, message))


def list_schedule_events(schedule_kind, schedule_id, limit=50):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT * FROM schedule_events
            WHERE schedule_kind = ? AND schedule_id = ?
            ORDER BY fired_at DESC
            LIMIT ?
        """, (schedule_kind, schedule_id, limit)).fetchall()
        return [dict(r) for r in rows]