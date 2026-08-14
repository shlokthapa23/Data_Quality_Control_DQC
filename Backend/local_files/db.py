import os
import re
import uuid
from datetime import datetime, timezone

import duckdb

from catalog.db import get_conn  # same sqlite catalog.db used everywhere else

UPLOAD_DIR = "local_uploads"
_TABLE_NAME_RE = re.compile(r'[^A-Za-z0-9_]')


def init_local_tables_table():
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS local_tables (
                id TEXT PRIMARY KEY,
                connector_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                duckdb_table_name TEXT NOT NULL,
                file_type TEXT NOT NULL,       -- 'csv' | 'parquet'
                uploaded_at TEXT NOT NULL
            )
        """)


def _duckdb_path(connector_id):
    # One DuckDB file per Local connector instance, so multiple Local
    # connectors (if a user creates more than one) don't share tables.
    return f"local_data_{connector_id}.duckdb"


def _sanitize_base_name(raw_name):
    """Clean, human-typeable base - no random suffix. E.g. 'Details' -> 'details'."""
    base = os.path.splitext(raw_name)[0]
    cleaned = _TABLE_NAME_RE.sub('_', base).strip('_').lower()
    if not cleaned or not re.match(r'^[a-z_]', cleaned):
        cleaned = f"t_{cleaned}"
    return cleaned


def _table_exists(con, table_name):
    row = con.execute(
        "SELECT 1 FROM information_schema.tables WHERE table_name = ?", [table_name]
    ).fetchone()
    return row is not None


def _next_available_table_name(con, base_name):
    """
    'details' if free, otherwise 'details_2', 'details_3', ... - a small
    incrementing counter only when there's an actual naming collision,
    instead of always tacking on an unreadable random suffix. Keeps the
    common case (one upload per name) as clean as the file's own name.
    """
    if not _table_exists(con, base_name):
        return base_name
    i = 2
    while _table_exists(con, f"{base_name}_{i}"):
        i += 1
    return f"{base_name}_{i}"


def ingest_file(connector_id, file_storage, display_name=None):
    """
    file_storage: a Flask FileStorage object (request.files['file']).
    Saves the raw upload, loads it into DuckDB as a real materialized
    table, and registers it in the sqlite catalog so it's listable.
    Returns the created row (dict).
    """
    original_filename = file_storage.filename or "upload"
    ext = os.path.splitext(original_filename)[1].lower().lstrip('.')
    if ext not in ("csv", "parquet"):
        raise ValueError("Only .csv and .parquet files are supported")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    file_id = str(uuid.uuid4())
    saved_path = os.path.join(UPLOAD_DIR, f"{file_id}.{ext}")
    file_storage.save(saved_path)

    base_name = _sanitize_base_name(display_name or original_filename)

    db_path = _duckdb_path(connector_id)
    con = None
    try:
        con = duckdb.connect(db_path)
        table_name = _next_available_table_name(con, base_name)
        # saved_path is server-generated (uuid-based), not user-controlled
        # text, so direct interpolation here doesn't carry injection risk.
        if ext == "csv":
            con.execute(f"CREATE TABLE {table_name} AS SELECT * FROM read_csv_auto('{saved_path}')")
        else:
            con.execute(f"CREATE TABLE {table_name} AS SELECT * FROM read_parquet('{saved_path}')")
    finally:
        if con is not None:
            con.close()

    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO local_tables (id, connector_id, display_name, duckdb_table_name, file_type, uploaded_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (file_id, connector_id, display_name or original_filename, table_name, ext, now))

    return {
        "id": file_id, "connector_id": connector_id,
        "display_name": display_name or original_filename,
        "duckdb_table_name": table_name, "file_type": ext, "uploaded_at": now,
    }


def list_local_tables(connector_id):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM local_tables WHERE connector_id = ? ORDER BY uploaded_at DESC",
            (connector_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def delete_local_table(connector_id, table_id):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM local_tables WHERE id = ? AND connector_id = ?", (table_id, connector_id)
        ).fetchone()
        if not row:
            return
        duckdb_table_name = row["duckdb_table_name"]
        conn.execute("DELETE FROM local_tables WHERE id = ?", (table_id,))

    db_path = _duckdb_path(connector_id)
    con = None
    try:
        con = duckdb.connect(db_path)
        con.execute(f"DROP TABLE IF EXISTS {duckdb_table_name}")
    finally:
        if con is not None:
            con.close()


def get_table_schema(connector_id, duckdb_table_name):
    """Column list for one table, via DuckDB's DESCRIBE."""
    db_path = _duckdb_path(connector_id)
    con = None
    try:
        con = duckdb.connect(db_path, read_only=True)
        rows = con.execute(f"DESCRIBE {duckdb_table_name}").fetchall()
        return [
            {"name": r[0], "data_type": str(r[1]), "nullable": True, "default": None}
            for r in rows
        ]
    finally:
        if con is not None:
            con.close()


def sample_rows(connector_id, table_name, limit=20):
    """Random sample of rows for the AI rule-suggestion flow. table_name comes
    from our own catalog (list_local_tables), not user-typed text."""
    db_path = _duckdb_path(connector_id)
    con = None
    try:
        con = duckdb.connect(db_path, read_only=True)
        result = con.execute(f"SELECT * FROM {table_name} ORDER BY RANDOM() LIMIT {limit}").fetchall()
        columns = [d[0] for d in con.description]
        return [dict(zip(columns, row)) for row in result]
    finally:
        if con is not None:
            con.close()


def run_query(connector_id, sql):
    from connectors.sql_guard import validate_select_only
    normalized = validate_select_only(sql)

    db_path = _duckdb_path(connector_id)
    con = None
    try:
        con = duckdb.connect(db_path, read_only=True)
        result = con.execute(normalized).fetchone()
        if result is None:
            return None
        columns = [d[0] for d in con.description]
        return dict(zip(columns, result))
    finally:
        if con is not None:
            con.close()


def validate_query(connector_id, sql):
    """
    EXPLAIN the statement to parse + bind it without executing. Returns
    (ok, error_message). The SELECT-only guard runs first, so a destructive
    statement never reaches the database at all.
    """
    from connectors.sql_guard import clean_explain_error, validate_select_only
    try:
        normalized = validate_select_only(sql)
    except ValueError as e:
        return False, str(e)

    db_path = _duckdb_path(connector_id)
    con = None
    try:
        con = duckdb.connect(db_path, read_only=True)
        con.execute(f"EXPLAIN {normalized}")  # plan discarded - we only want the errors
        return True, None
    except Exception as e:
        return False, clean_explain_error(e)
    finally:
        if con is not None:
            con.close()


def run_query_all(connector_id, sql):
    """Like run_query, but returns every matching row (list of dicts) instead
    of just the first - used by cross_table_parity's key-column existence
    diff, which needs the full set of key values, not one row or a sample."""
    from connectors.sql_guard import validate_select_only
    normalized = validate_select_only(sql)

    db_path = _duckdb_path(connector_id)
    con = None
    try:
        con = duckdb.connect(db_path, read_only=True)
        result = con.execute(normalized).fetchall()
        columns = [d[0] for d in con.description]
        return [dict(zip(columns, row)) for row in result]
    finally:
        if con is not None:
            con.close()