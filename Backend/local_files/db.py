import csv
import json
import os
import re
import tempfile
import uuid
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone

import duckdb

from catalog.db import get_conn  # same sqlite catalog.db used everywhere else

UPLOAD_DIR = "local_uploads"
_TABLE_NAME_RE = re.compile(r'[^A-Za-z0-9_]')

# Every format a tester can upload. The point of accepting this many is that
# once a file is in here it stops being "a JSON file" or "an XML file" and
# becomes a DuckDB table like any other - so ONE dialect of SQL tests them all,
# and a tester can prove a file's quality BEFORE it is loaded into a Lakehouse.
#
# Not supported: .xlsx. It needs DuckDB's `excel` extension, which isn't
# installed and would have to be fetched over the network.
SUPPORTED_EXTENSIONS = ("csv", "tsv", "txt", "json", "ndjson", "jsonl", "parquet", "xml")


def init_local_tables_table():
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS local_tables (
                id TEXT PRIMARY KEY,
                connector_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                duckdb_table_name TEXT NOT NULL,
                file_type TEXT NOT NULL,       -- any of SUPPORTED_EXTENSIONS
                uploaded_at TEXT NOT NULL
            )
        """)
        # Additive: how the file was interpreted (currently the XML record
        # element). JSON so a future per-format option needs no migration.
        existing = {r[1] for r in conn.execute("PRAGMA table_info(local_tables)").fetchall()}
        if "source_options" not in existing:
            conn.execute("ALTER TABLE local_tables ADD COLUMN source_options TEXT")
        # Additive: tester-authored synthetic test tables (see
        # create_synthetic_table). source_kind is NULL for every ordinary
        # upload (unchanged); provenance_json remembers which real
        # connector/container/table a synthetic table's schema was cloned
        # from, so "Resync schema" knows what to re-check against.
        if "source_kind" not in existing:
            conn.execute("ALTER TABLE local_tables ADD COLUMN source_kind TEXT")
        if "provenance_json" not in existing:
            conn.execute("ALTER TABLE local_tables ADD COLUMN provenance_json TEXT")


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


def _quote_ident(name):
    """Double-quote a DuckDB identifier, escaping any embedded quote. Used
    everywhere a column/table name (rather than a value) is interpolated into
    SQL for the synthetic-table feature below - unlike ingest_file's table
    names (always machine-sanitized by _sanitize_base_name), a synthetic
    table's COLUMN names come from a real table's live schema and could
    contain a reserved word, spaces, or other characters that would otherwise
    break unquoted DDL."""
    return '"' + str(name).replace('"', '""') + '"'


# Only a known-safe DuckDB type spelling is ever interpolated into DDL
# verbatim. Anything else - an exotic Fabric/Delta type (STRUCT, MAP, a wide
# DECIMAL DuckDB balks at, etc.) or just something unexpected - falls back to
# VARCHAR (see _safe_duckdb_type) rather than either aborting the whole clone
# or risking an unchecked string in a CREATE TABLE/ALTER TABLE statement.
_SAFE_DUCKDB_TYPE_RE = re.compile(
    r'^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|'
    r'FLOAT|DOUBLE|REAL|DECIMAL(\(\s*\d+\s*,\s*\d+\s*\))?|BOOLEAN|BOOL|'
    r'VARCHAR(\(\s*\d+\s*\))?|TEXT|BLOB|DATE|TIME|TIMESTAMP(_(TZ|S|MS|NS))?|INTERVAL|UUID)$',
    re.IGNORECASE,
)


def _safe_duckdb_type(raw):
    """(safe_type_to_use, was_downgraded_to_varchar)."""
    raw = (raw or '').strip()
    if _SAFE_DUCKDB_TYPE_RE.match(raw):
        return raw.upper(), False
    return 'VARCHAR', True


def _insert_rows(con, table_name, col_names, rows):
    """
    Bulk-insert already-typed dict rows into an existing table. Column
    VALUES always go through parameterized placeholders - never string-
    interpolated - since these are tester-typed free text; only the table/
    column NAMES (already quoted+allow-listed by the caller) are ever built
    into the SQL text itself.
    """
    if not rows:
        return
    quoted_table = _quote_ident(table_name)
    quoted_cols = ", ".join(_quote_ident(c) for c in col_names)
    placeholders = ", ".join(["?"] * len(col_names))
    values = [[row.get(c) for c in col_names] for row in rows]
    con.executemany(
        f'INSERT INTO {quoted_table} ({quoted_cols}) VALUES ({placeholders})',
        values,
    )


def _reader_sql(ext, path):
    """
    The DuckDB expression that reads one uploaded file.

    csv/tsv/txt all go through read_csv_auto because its sniffer works out the
    delimiter itself - a tab-, pipe- or semicolon-separated .txt loads without
    anyone having to say what's inside it.
    """
    quoted = path.replace("'", "''")
    if ext == "parquet":
        return f"read_parquet('{quoted}')"
    if ext == "json":
        return f"read_json_auto('{quoted}')"
    if ext in ("ndjson", "jsonl"):
        return f"read_ndjson_auto('{quoted}')"
    return f"read_csv_auto('{quoted}')"


def _flatten_parts(expr, alias, dtype):
    """
    (expression, alias) pairs that turn one possibly-nested column into flat
    ones. Walks the type programmatically - .id then .children - rather than
    parsing DuckDB's type string, which would break on any nesting it didn't
    anticipate.
    """
    kind = dtype.id
    if kind == "struct":
        children = dtype.children
        if not children:
            # A struct with no fields would otherwise vanish entirely.
            yield f"CAST({expr} AS VARCHAR)", alias
            return
        for child_name, child_type in children:
            yield from _flatten_parts(f'{expr}."{child_name}"', f"{alias}.{child_name}", child_type)
    elif kind in ("list", "array", "map", "union"):
        # Arrays keep their shape as JSON text. Exploding them into rows would
        # silently change the row count, which is the one number a tester is
        # most likely to be checking.
        yield f"CAST({expr} AS VARCHAR)", alias
    else:
        yield expr, alias


def _flattened_select(con, source_sql):
    """
    A SELECT over source_sql with nested structures flattened into dotted
    columns ("customer.address.city"), so plain SQL reaches every field:
    SELECT COUNT(*) ... WHERE "customer.address.city" = 'X' just works.

    Flat input (every CSV and most Parquet) has nothing to flatten, so this
    returns the same columns it was given - the existing formats are unaffected.
    """
    rel = con.sql(f"SELECT * FROM {source_sql} LIMIT 0")
    parts = []
    for name, dtype in zip(rel.columns, rel.types):
        parts.extend(_flatten_parts(f'"{name}"', name, dtype))
    if not parts:
        return f"SELECT * FROM {source_sql}"
    select_list = ", ".join(f'{expr} AS "{alias}"' for expr, alias in parts)
    return f"SELECT {select_list} FROM {source_sql}"


def _localname(tag):
    """Drop any XML namespace: '{urn:x}order' -> 'order'."""
    return tag.split('}', 1)[1] if '}' in tag else tag


def _element_to_row(element, prefix, row):
    """
    Flatten one XML record into {column: text}, using the same dotted
    convention as the JSON path so the two formats produce comparable tables.
    Attributes are prefixed with @; repeated children become JSON text, matching
    how arrays are handled everywhere else.
    """
    for key, value in element.attrib.items():
        row[f"{prefix}@{_localname(key)}" if prefix else f"@{_localname(key)}"] = value

    children = list(element)
    if not children:
        if prefix:
            row[prefix.rstrip('.')] = (element.text or '').strip()
        return

    by_name = {}
    for child in children:
        by_name.setdefault(_localname(child.tag), []).append(child)

    for name, group in by_name.items():
        child_prefix = f"{prefix}{name}" if prefix else name
        if len(group) == 1:
            _element_to_row(group[0], f"{child_prefix}.", row)
        else:
            row[child_prefix] = json.dumps([_element_text_or_dict(c) for c in group])


def _element_text_or_dict(element):
    """One member of a repeated element group, as a JSON-encodable value."""
    if not list(element) and not element.attrib:
        return (element.text or '').strip()
    nested = {}
    _element_to_row(element, "", nested)
    return nested


def xml_to_rows(path, record_element=None):
    """
    Turn an XML document into rows.

    XML has no notion of a row, so one has to be chosen: the most frequent
    REPEATING element directly under the root, which is what essentially every
    record-per-element document looks like. Returns
    (rows, chosen_element, candidates) so the caller can report the guess and
    let the tester pick a different one.

    Two shapes are deliberately not treated as collections:
      - a root with no element children is an EMPTY document -> zero rows, not
        one empty row. A file with no records has to read as 0, because that's
        the case a tester most needs to notice.
      - a root with SEVERAL differently-named children, none repeated, is a
        SINGLE record and those children are its fields. Taking "the most
        frequent child" there would turn each field into its own row.

    A root with exactly one child is deliberately read as a collection of one,
    NOT as a single record: otherwise a file with one <item> would produce
    different column names than the same file with two, and a test written
    against one of them would break against the other.
    """
    root = ET.parse(path).getroot()
    counts = Counter(_localname(child.tag) for child in root)
    candidates = [name for name, _ in counts.most_common()]

    if not counts:
        return [], None, []
    if record_element is None and sum(counts.values()) > 1 and max(counts.values()) == 1:
        return [_single_row(root)], None, candidates

    chosen = record_element or candidates[0]
    if chosen not in counts:
        raise ValueError(
            f"No <{chosen}> elements under the root. Found: {', '.join(candidates)}"
        )

    rows = []
    for child in root:
        if _localname(child.tag) == chosen:
            rows.append(_single_row(child))
    return rows, chosen, candidates


def _single_row(element):
    row = {}
    _element_to_row(element, "", row)
    if not row:
        # A record that is just text, e.g. <note>hello</note>. Without this the
        # row would be empty and the value silently thrown away; name the column
        # after the element it came from.
        row[_localname(element.tag)] = (element.text or '').strip()
    return row


def _rows_to_csv(rows):
    """
    Park XML rows in a temporary CSV and let read_csv_auto load them, so an XML
    file gets exactly the same type sniffing as the equivalent CSV upload. That
    is the point of the whole exercise: the format the data arrived in must stop
    being visible once it's a table.
    """
    columns = []
    seen = set()
    for row in rows:
        for key in row:
            if key not in seen:
                seen.add(key)
                columns.append(key)

    handle = tempfile.NamedTemporaryFile(
        mode='w', suffix='.csv', delete=False, newline='', encoding='utf-8')
    try:
        writer = csv.DictWriter(handle, fieldnames=columns or ['value'])
        writer.writeheader()
        for row in rows:
            writer.writerow({c: row.get(c, '') for c in columns})
    finally:
        handle.close()
    return handle.name


def _create_table_from_file(con, table_name, ext, saved_path, xml_record_element=None):
    """
    Load one file into `table_name`, returning the XML details when relevant.
    Every format funnels through the same flatten-then-CREATE step so none of
    them can end up behaving differently from the others.
    """
    chosen, candidates, temp_csv = None, None, None
    try:
        if ext == "xml":
            rows, chosen, candidates = xml_to_rows(saved_path, xml_record_element)
            temp_csv = _rows_to_csv(rows)
            source_sql = _reader_sql("csv", temp_csv)
        else:
            source_sql = _reader_sql(ext, saved_path)

        con.execute(f"CREATE TABLE {table_name} AS {_flattened_select(con, source_sql)}")
    finally:
        if temp_csv:
            os.remove(temp_csv)
    return chosen, candidates


def _readable_ingest_error(error, saved_path, original_filename):
    """
    Reword a reader's failure so it talks about the tester's file.

    Uploads are stored under a generated uuid name, so DuckDB's message points
    at something like local_uploads\\6ce01da2-....json - a path the tester has
    never seen and can't act on. Swap it for the name they actually chose, and
    drop the parser's noise about byte offsets in favour of what to do next.
    """
    message = str(error)
    for path in (saved_path, os.path.abspath(saved_path), os.path.basename(saved_path)):
        message = message.replace(path, original_filename)
    # DuckDB prefixes its own category; it adds nothing once the rest is plain.
    for prefix in ("Invalid Input Error: ", "IO Error: ", "Conversion Error: "):
        message = message.replace(prefix, "")
    return message.strip()


_FORMAT_ADVICE = {
    "json": 'Check it is valid JSON - an array of objects, or one object per line for .ndjson.',
    "ndjson": 'Each line must be one complete JSON object, with no commas between lines.',
    "jsonl": 'Each line must be one complete JSON object, with no commas between lines.',
    "xml": 'Check the document is well formed - every opening tag needs its closing tag.',
    "csv": 'Check the delimiter and that every row has the same number of columns.',
    "tsv": 'Check the delimiter and that every row has the same number of columns.',
    "txt": 'Check the delimiter and that every row has the same number of columns.',
    "parquet": 'The file may be truncated or not actually Parquet.',
}


def ingest_file(connector_id, file_storage, display_name=None, xml_record_element=None):
    """
    file_storage: a Flask FileStorage object (request.files['file']).
    Saves the raw upload, loads it into DuckDB as a real materialized
    table, and registers it in the sqlite catalog so it's listable.
    Returns the created row (dict).
    """
    original_filename = file_storage.filename or "upload"
    ext = os.path.splitext(original_filename)[1].lower().lstrip('.')
    if ext not in SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"Can't read a .{ext or '?'} file. Supported: "
            + ", ".join(f".{e}" for e in SUPPORTED_EXTENSIONS)
        )

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
        chosen, candidates = _create_table_from_file(
            con, table_name, ext, saved_path, xml_record_element)
        row_count = con.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
        column_count = len(con.execute(f"DESCRIBE {table_name}").fetchall())
    except Exception as e:
        # Don't leave the raw upload behind when nothing was registered for it.
        if os.path.exists(saved_path):
            os.remove(saved_path)
        detail = _readable_ingest_error(e, saved_path, original_filename)
        advice = _FORMAT_ADVICE.get(ext)
        raise ValueError(
            f"Couldn't read {original_filename}: {detail}"
            + (f" {advice}" if advice else "")
        ) from e
    finally:
        if con is not None:
            con.close()

    options = {"xml_record_element": chosen} if chosen else None
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO local_tables (id, connector_id, display_name, duckdb_table_name,
                                      file_type, uploaded_at, source_options)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (file_id, connector_id, display_name or original_filename, table_name, ext, now,
              json.dumps(options) if options else None))

    return {
        "id": file_id, "connector_id": connector_id,
        "display_name": display_name or original_filename,
        "duckdb_table_name": table_name, "file_type": ext, "uploaded_at": now,
        "row_count": row_count, "column_count": column_count,
        "xml_record_element": chosen, "xml_candidates": candidates,
    }


def reingest_xml(connector_id, table_id, record_element):
    """
    Rebuild an XML-sourced table from a different record element.

    The raw upload is still on disk, so a wrong auto-detection is recoverable
    without asking the tester to upload the file again.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM local_tables WHERE id = ? AND connector_id = ?", (table_id, connector_id)
        ).fetchone()
    if not row:
        raise KeyError("Unknown table")
    row = dict(row)
    if row["file_type"] != "xml":
        raise ValueError("Only XML tables can be re-read with a different record element")

    saved_path = os.path.join(UPLOAD_DIR, f"{table_id}.xml")
    if not os.path.exists(saved_path):
        raise ValueError("The original upload is no longer on disk - please upload the file again")

    table_name = row["duckdb_table_name"]
    con = None
    try:
        con = duckdb.connect(_duckdb_path(connector_id))
        # Build the replacement first: if the chosen element is wrong, the
        # existing table must survive untouched rather than being dropped for a
        # rebuild that then fails.
        staging = _next_available_table_name(con, f"{table_name}_restaging")
        chosen, candidates = _create_table_from_file(con, staging, "xml", saved_path, record_element)
        con.execute(f"DROP TABLE IF EXISTS {table_name}")
        con.execute(f"ALTER TABLE {staging} RENAME TO {table_name}")
        row_count = con.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
        column_count = len(con.execute(f"DESCRIBE {table_name}").fetchall())
    finally:
        if con is not None:
            con.close()

    with get_conn() as conn:
        conn.execute("UPDATE local_tables SET source_options = ? WHERE id = ?",
                     (json.dumps({"xml_record_element": chosen}), table_id))

    return {
        **row, "row_count": row_count, "column_count": column_count,
        "xml_record_element": chosen, "xml_candidates": candidates,
    }


def list_local_tables(connector_id):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM local_tables WHERE connector_id = ? ORDER BY uploaded_at DESC",
            (connector_id,),
        ).fetchall()

    result = []
    for r in rows:
        row = dict(r)
        # Parsed here rather than in the caller, so nothing downstream has to
        # know the column happens to hold JSON. Absent or unreadable -> {}.
        try:
            row["source_options"] = json.loads(row.get("source_options") or "{}")
        except (TypeError, ValueError):
            row["source_options"] = {}
        result.append(row)
    return result


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


def create_synthetic_table(connector_id, display_name, columns, rows, provenance=None):
    """
    The one write "Finalize" makes: create a new table from an explicit
    column list and bulk-insert the tester's finalized draft rows, in one
    transaction. Mirrors ingest_file's writable-connection pattern.

    columns: [{"name": str, "data_type": str}, ...] - must already be a live
    schema fetch resolved by the CALLER (app.py re-fetches from the real
    source connector), never trusted verbatim from client-submitted DDL.
    rows: [{column_name: value, ...}, ...].
    provenance: {"connector_id","connector_name","container_id","table_name"}
    or None - stored so a later "Resync schema" knows what real table to
    re-check against.
    """
    if not columns:
        raise ValueError("Can't create a test table with no columns")

    seen_lower = set()
    col_defs, col_names, warnings = [], [], []
    for c in columns:
        name = (c.get("name") or "").strip()
        if not name:
            raise ValueError("Every column needs a name")
        key = name.lower()
        if key in seen_lower:
            raise ValueError(
                f'Column "{name}" collides with another column that only differs by case - '
                "DuckDB identifiers are case-insensitive, so these can't coexist"
            )
        seen_lower.add(key)
        safe_type, downgraded = _safe_duckdb_type(c.get("data_type"))
        if downgraded:
            warnings.append(f'"{name}" ({c.get("data_type")}) is stored as VARCHAR - no safe local equivalent')
        col_defs.append(f'{_quote_ident(name)} {safe_type}')
        col_names.append(name)

    base_name = _sanitize_base_name(display_name)
    table_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    db_path = _duckdb_path(connector_id)
    con = None
    try:
        con = duckdb.connect(db_path)
        table_name = _next_available_table_name(con, base_name)
        con.execute("BEGIN")
        con.execute(f'CREATE TABLE {_quote_ident(table_name)} ({", ".join(col_defs)})')
        _insert_rows(con, table_name, col_names, rows)
        con.execute("COMMIT")
        row_count = con.execute(f"SELECT COUNT(*) FROM {_quote_ident(table_name)}").fetchone()[0]
    except Exception:
        if con is not None:
            try:
                con.execute("ROLLBACK")
            except Exception:
                pass
        raise
    finally:
        if con is not None:
            con.close()

    with get_conn() as conn:
        conn.execute("""
            INSERT INTO local_tables (id, connector_id, display_name, duckdb_table_name,
                                      file_type, uploaded_at, source_options, source_kind, provenance_json)
            VALUES (?, ?, ?, ?, 'test_data', ?, NULL, 'synthetic', ?)
        """, (table_id, connector_id, display_name, table_name, now,
              json.dumps(provenance) if provenance else None))

    return {
        "id": table_id, "connector_id": connector_id, "display_name": display_name,
        "duckdb_table_name": table_name, "row_count": row_count,
        "column_count": len(col_names), "warnings": warnings,
    }


def replace_table_rows(connector_id, table_id, rows):
    """
    Full-replace save for an existing synthetic table's rows - the same
    delete-then-reinsert-everything idiom this codebase already uses for
    column maps and suite membership, applied here to grid rows. One
    transaction: a bad value partway through an insert must leave the table
    exactly as it was, never half-deleted.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM local_tables WHERE id = ? AND connector_id = ?", (table_id, connector_id)
        ).fetchone()
    if not row:
        raise KeyError("Unknown table")
    table_name = dict(row)["duckdb_table_name"]

    db_path = _duckdb_path(connector_id)
    con = None
    try:
        con = duckdb.connect(db_path)
        col_names = [r[0] for r in con.execute(f"DESCRIBE {_quote_ident(table_name)}").fetchall()]
        con.execute("BEGIN")
        con.execute(f"DELETE FROM {_quote_ident(table_name)}")
        _insert_rows(con, table_name, col_names, rows)
        con.execute("COMMIT")
        row_count = con.execute(f"SELECT COUNT(*) FROM {_quote_ident(table_name)}").fetchone()[0]
    except Exception:
        if con is not None:
            try:
                con.execute("ROLLBACK")
            except Exception:
                pass
        raise
    finally:
        if con is not None:
            con.close()
    return {"row_count": row_count}


def get_synthetic_table_rows(connector_id, table_id, limit=500):
    """Hydrate the row-grid editor when a tester reopens an existing
    synthetic table. Capped so a tester who added far more than the
    intended ~25+ rows can't stall the editor - not a hard ceiling on the
    table itself, only on what one GET returns."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM local_tables WHERE id = ? AND connector_id = ?", (table_id, connector_id)
        ).fetchone()
    if not row:
        raise KeyError("Unknown table")
    table_name = dict(row)["duckdb_table_name"]

    db_path = _duckdb_path(connector_id)
    con = None
    try:
        con = duckdb.connect(db_path, read_only=True)
        result = con.execute(f"SELECT * FROM {_quote_ident(table_name)} LIMIT {int(limit)}").fetchall()
        columns = [d[0] for d in con.description]
        return [dict(zip(columns, r)) for r in result]
    finally:
        if con is not None:
            con.close()


def resync_schema(connector_id, table_id, live_source_columns, dry_run=True):
    """
    Additive-only schema resync. Adds columns the real source has gained
    since this table was cloned/last resynced (nullable, so existing rows
    are unaffected). Never drops, renames, or retypes a column the tester
    might already have rows depending on - a column missing at the source,
    or one whose type changed, is only ever reported back for the tester to
    handle by hand.

    live_source_columns: [{"name","data_type"}, ...] already fetched fresh by
    the CALLER (app.py) from the real connector - this function only diffs
    and (when dry_run=False) applies; it never reaches out to Fabric itself,
    so it has no opinion on whether the source is still reachable.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM local_tables WHERE id = ? AND connector_id = ?", (table_id, connector_id)
        ).fetchone()
    if not row:
        raise KeyError("Unknown table")
    table_name = dict(row)["duckdb_table_name"]

    db_path = _duckdb_path(connector_id)
    con = None
    try:
        con = duckdb.connect(db_path, read_only=dry_run)
        existing_rows = con.execute(f"DESCRIBE {_quote_ident(table_name)}").fetchall()
        existing = {r[0].lower(): {"name": r[0], "data_type": str(r[1])} for r in existing_rows}
        live_by_lower = {c["name"].lower(): c for c in live_source_columns}

        to_add = [c for key, c in live_by_lower.items() if key not in existing]
        missing_at_source = [e["name"] for key, e in existing.items() if key not in live_by_lower]
        type_changed = []
        for key, e in existing.items():
            if key in live_by_lower:
                safe_type, _ = _safe_duckdb_type(live_by_lower[key].get("data_type"))
                if safe_type.split("(")[0].upper() != e["data_type"].split("(")[0].upper():
                    type_changed.append({
                        "name": e["name"], "local_type": e["data_type"],
                        "source_type": live_by_lower[key].get("data_type"),
                    })

        added, warnings = [], []
        if not dry_run:
            for c in to_add:
                safe_type, downgraded = _safe_duckdb_type(c.get("data_type"))
                if downgraded:
                    warnings.append(f'"{c["name"]}" ({c.get("data_type")}) added as VARCHAR - no safe local equivalent')
                con.execute(
                    f'ALTER TABLE {_quote_ident(table_name)} ADD COLUMN {_quote_ident(c["name"])} {safe_type}'
                )
                added.append(c["name"])
    finally:
        if con is not None:
            con.close()

    return {
        "added": added if not dry_run else [c["name"] for c in to_add],
        "flagged_missing_at_source": missing_at_source,
        "flagged_type_changed": type_changed,
        "warnings": warnings,
    }


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