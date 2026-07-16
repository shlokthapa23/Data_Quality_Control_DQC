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
                check_type TEXT NOT NULL,           -- 'sql' | 'row_count_match'

                -- 'sql' checks only:
                target TEXT,                        -- 'source' | 'destination'
                target_table TEXT,                  -- one specific table, for display only
                script_type TEXT,                   -- 'sql' | 'pyspark'
                script_text TEXT,

                -- 'row_count_match' checks only:
                row_count_source_tables TEXT,       -- JSON array (subset of mapping.source_tables)
                row_count_destination_tables TEXT,  -- JSON array (subset of mapping.destination_tables)

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
                FOREIGN KEY (run_id) REFERENCES s2d_test_runs(id)
            )
        """)


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
    return tc


def create_test_case(mapping_id, name, validation_type, check_type,
                      target=None, target_table=None, script_type=None, script_text=None,
                      row_count_source_tables=None, row_count_destination_tables=None):
    test_case_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO s2d_test_cases
                (id, mapping_id, name, validation_type, check_type, target, target_table,
                 script_type, script_text, row_count_source_tables, row_count_destination_tables, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            test_case_id, mapping_id, name, validation_type, check_type, target, target_table,
            script_type, script_text,
            json.dumps(row_count_source_tables) if row_count_source_tables is not None else None,
            json.dumps(row_count_destination_tables) if row_count_destination_tables is not None else None,
            now,
        ))
    return test_case_id


def update_test_case(test_case_id, name, validation_type, check_type,
                      target=None, target_table=None, script_type=None, script_text=None,
                      row_count_source_tables=None, row_count_destination_tables=None):
    with get_conn() as conn:
        conn.execute("""
            UPDATE s2d_test_cases SET
                name = ?, validation_type = ?, check_type = ?, target = ?, target_table = ?,
                script_type = ?, script_text = ?, row_count_source_tables = ?, row_count_destination_tables = ?
            WHERE id = ?
        """, (
            name, validation_type, check_type, target, target_table, script_type, script_text,
            json.dumps(row_count_source_tables) if row_count_source_tables is not None else None,
            json.dumps(row_count_destination_tables) if row_count_destination_tables is not None else None,
            test_case_id,
        ))


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
               validation_type, status, evaluated_query=None, details=None, error_message=None):
    result_id = str(uuid.uuid4())
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO s2d_test_results
                (id, run_id, test_case_id, test_label, test_name, rule_target,
                 validation_type, status, evaluated_query, details, error_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (result_id, run_id, test_case_id, test_label, test_name, rule_target,
              validation_type, status, evaluated_query, details, error_message))
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