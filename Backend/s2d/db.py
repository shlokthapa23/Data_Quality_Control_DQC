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
                script_text TEXT,

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
                status TEXT NOT NULL,               -- 'passed' | 'failed'
                total_checkpoints INTEGER NOT NULL,
                pass_count INTEGER NOT NULL,
                fail_count INTEGER NOT NULL,
                compute_time_seconds REAL NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT NOT NULL,
                FOREIGN KEY (mapping_id) REFERENCES s2d_mappings(id)
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

    _add_missing_test_case_columns()
    _add_missing_test_result_columns()


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
    return m


def create_mapping(name,
                    source_connector_id, source_connector_name, source_container_id,
                    source_container_name, source_tables,
                    destination_connector_id, destination_connector_name,
                    destination_container_id, destination_container_name, destination_tables):
    mapping_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO s2d_mappings (
                id, name,
                source_connector_id, source_connector_name, source_container_id, source_container_name, source_tables,
                destination_connector_id, destination_connector_name, destination_container_id, destination_container_name, destination_tables,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            mapping_id, name,
            source_connector_id, source_connector_name, source_container_id, source_container_name, json.dumps(source_tables),
            destination_connector_id, destination_connector_name, destination_container_id, destination_container_name, json.dumps(destination_tables),
            now,
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


def delete_mapping(mapping_id):
    with get_conn() as conn:
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
    tc["active"] = bool(tc["active"])
    return tc


def create_test_case(mapping_id, name, validation_type, check_type,
                      target=None, target_table=None, script_type=None, script_text=None,
                      row_count_source_tables=None, row_count_destination_tables=None,
                      source_tables=None, source_column=None, destination_tables=None, destination_column=None,
                      target_tables=None, check_scope=None, key_column=None,
                      source_target_tables=None, destination_target_tables=None,
                      origin='manual', severity='error', active=True, description=None):
    test_case_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO s2d_test_cases
                (id, mapping_id, name, validation_type, check_type, target, target_table,
                 script_type, script_text, row_count_source_tables, row_count_destination_tables,
                 source_tables, source_column, destination_tables, destination_column,
                 target_tables, check_scope, key_column, source_target_tables, destination_target_tables,
                 origin, severity, active, description, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            test_case_id, mapping_id, name, validation_type, check_type, target, target_table,
            script_type, script_text,
            json.dumps(row_count_source_tables) if row_count_source_tables is not None else None,
            json.dumps(row_count_destination_tables) if row_count_destination_tables is not None else None,
            json.dumps(source_tables) if source_tables is not None else None, source_column,
            json.dumps(destination_tables) if destination_tables is not None else None, destination_column,
            json.dumps(target_tables) if target_tables is not None else None, check_scope, key_column,
            json.dumps(source_target_tables) if source_target_tables is not None else None,
            json.dumps(destination_target_tables) if destination_target_tables is not None else None,
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
                      severity=None, description=None):
    with get_conn() as conn:
        if severity is None:
            existing = conn.execute("SELECT severity FROM s2d_test_cases WHERE id = ?", (test_case_id,)).fetchone()
            severity = existing["severity"] if existing else 'error'
        conn.execute("""
            UPDATE s2d_test_cases SET
                name = ?, validation_type = ?, check_type = ?, target = ?, target_table = ?,
                script_type = ?, script_text = ?, row_count_source_tables = ?, row_count_destination_tables = ?,
                source_tables = ?, source_column = ?, destination_tables = ?, destination_column = ?,
                target_tables = ?, check_scope = ?, key_column = ?, source_target_tables = ?, destination_target_tables = ?,
                severity = ?, description = ?
            WHERE id = ?
        """, (
            name, validation_type, check_type, target, target_table, script_type, script_text,
            json.dumps(row_count_source_tables) if row_count_source_tables is not None else None,
            json.dumps(row_count_destination_tables) if row_count_destination_tables is not None else None,
            json.dumps(source_tables) if source_tables is not None else None, source_column,
            json.dumps(destination_tables) if destination_tables is not None else None, destination_column,
            json.dumps(target_tables) if target_tables is not None else None, check_scope, key_column,
            json.dumps(source_target_tables) if source_target_tables is not None else None,
            json.dumps(destination_target_tables) if destination_target_tables is not None else None,
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
        conn.execute("DELETE FROM s2d_test_cases WHERE id = ?", (test_case_id,))


# --- Runs + results ---------------------------------------------------------

def create_run(mapping_id, status, total_checkpoints, pass_count, fail_count,
               compute_time_seconds, started_at, finished_at):
    run_id = str(uuid.uuid4())
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO s2d_test_runs
                (id, mapping_id, status, total_checkpoints, pass_count, fail_count,
                 compute_time_seconds, started_at, finished_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (run_id, mapping_id, status, total_checkpoints, pass_count, fail_count,
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


def list_runs(mapping_id=None):
    """
    Powers the History tab - joins in the mapping name so the list is
    readable without a second round-trip per row.
    """
    query = """
        SELECT r.*, m.name AS mapping_name
        FROM s2d_test_runs r
        LEFT JOIN s2d_mappings m ON m.id = r.mapping_id
    """
    params = []
    if mapping_id:
        query += " WHERE r.mapping_id = ?"
        params.append(mapping_id)
    query += " ORDER BY r.started_at DESC"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]