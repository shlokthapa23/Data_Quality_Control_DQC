import sqlite3
import json
from datetime import datetime, timezone
from contextlib import contextmanager

DB_PATH = "catalog.db"


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS harvested_assets (
                id TEXT PRIMARY KEY,          -- f"{connector_type}:{source_item_id}"
                connector_type TEXT NOT NULL,
                connector_name TEXT NOT NULL,
                source_item_id TEXT NOT NULL,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                owner TEXT,
                glossary_status TEXT DEFAULT 'Unmapped',
                schema_json TEXT,              -- JSON-encoded [{table, kind, columns}]
                harvested_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS harvest_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                connector_type TEXT NOT NULL,
                connector_name TEXT NOT NULL,
                mode TEXT NOT NULL,            -- 'incremental' | 'full_refresh'
                asset_count INTEGER NOT NULL,
                status TEXT NOT NULL,          -- 'success' | 'failed'
                error_message TEXT,
                started_at TEXT NOT NULL,
                finished_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS connector_configs (
                id TEXT PRIMARY KEY,           -- uuid
                name TEXT NOT NULL,
                type TEXT NOT NULL,            -- 'fabric' | 'local'
                tenant_id TEXT,
                client_id TEXT,
                client_secret TEXT,
                workspace_id TEXT,
                allowed_containers_json TEXT,  -- fabric only: pinned pair of Lakehouses
                created_at TEXT NOT NULL
            )
        """)
        # Defensive migration for databases created before this column existed.
        try:
            conn.execute("ALTER TABLE connector_configs ADD COLUMN allowed_containers_json TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists

        # Additive migration: personal "test data" connectors. owner_user_id
        # is NULL for every ordinary org-shared connector (unchanged
        # behavior); purpose='test_data' marks the one lazily-created,
        # per-tester Local connector that holds synthetic test tables (see
        # get_or_create_test_data_connector below). The partial unique index
        # guarantees one tester can never end up with two of these even if
        # two "create test data" requests race.
        try:
            conn.execute("ALTER TABLE connector_configs ADD COLUMN owner_user_id TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists
        try:
            conn.execute("ALTER TABLE connector_configs ADD COLUMN purpose TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists
        conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS ux_connector_owner_test_data
            ON connector_configs(owner_user_id) WHERE purpose = 'test_data'
        """)

        # Additive migration: harvested_assets gained connector_id so Catalog
        # can scope to one specific connector instance, not just a type -
        # needed once a second connector of the same type (e.g. a second
        # Fabric workspace) exists, since connector_type alone can't tell
        # them apart. The primary key scheme deliberately stays
        # f"{connector_type}:{source_item_id}" (unchanged) - switching it to
        # include connector_id would rewrite every existing asset's id (used
        # in URLs and AssetDetailModal's fetch-by-id) for a collision risk
        # that's negligible in practice (Fabric item ids are workspace-scoped
        # GUIDs).
        try:
            conn.execute("ALTER TABLE harvested_assets ADD COLUMN connector_id TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists
        else:
            # One-time backfill for pre-existing rows: only safe when exactly
            # one connector of that type exists (true for this app today -
            # one Fabric + one Local connector). Ambiguous cases are left
            # NULL rather than guessing which connector harvested them.
            for row in conn.execute(
                "SELECT DISTINCT connector_type FROM harvested_assets WHERE connector_id IS NULL"
            ).fetchall():
                ctype = row["connector_type"]
                matches = conn.execute(
                    "SELECT id FROM connector_configs WHERE type = ?", (ctype,)
                ).fetchall()
                if len(matches) == 1:
                    conn.execute(
                        "UPDATE harvested_assets SET connector_id = ? WHERE connector_type = ? AND connector_id IS NULL",
                        (matches[0]["id"], ctype),
                    )


# --- Harvested assets -------------------------------------------------------

def upsert_asset(connector_id, connector_type, connector_name, item, schema=None, owner=None):
    asset_id = f"{connector_type}:{item['id']}"
    now = datetime.now(timezone.utc).isoformat()

    with get_conn() as conn:
        conn.execute("""
            INSERT INTO harvested_assets
                (id, connector_id, connector_type, connector_name, source_item_id, name, type, owner, schema_json, harvested_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                connector_id=excluded.connector_id,
                name=excluded.name,
                type=excluded.type,
                schema_json=excluded.schema_json,
                harvested_at=excluded.harvested_at
        """, (
            asset_id, connector_id, connector_type, connector_name, item['id'],
            item['name'], item['type'], owner,
            json.dumps(schema) if schema is not None else None,
            now,
        ))
    return asset_id


def clear_assets_by_item_ids(connector_type, connector_id, source_item_ids):
    """
    Drop the catalog rows for exactly these items, and nothing else.

    This is what "full refresh" now means: re-pull the things you selected from
    scratch. It used to clear every asset of the selected TYPES, which meant
    harvesting a second Lakehouse silently deleted the first one - the tester
    had asked for one more, and got one instead.
    """
    if not source_item_ids:
        return
    with get_conn() as conn:
        placeholders = ",".join("?" for _ in source_item_ids)
        params = [connector_type, connector_id, *source_item_ids]
        conn.execute(
            f"""DELETE FROM harvested_assets
                WHERE connector_type = ? AND connector_id = ?
                  AND source_item_id IN ({placeholders})""",
            params,
        )


def full_refresh_clear(connector_type, connector_id=None, asset_types=None):
    """
    Wipe existing catalog entries before a full refresh.
    connector_id scopes the wipe to one specific connector instance so a full
    refresh on one Fabric connector never touches another Fabric connector's
    assets (connector_type alone can't distinguish two connectors of the
    same type). If asset_types is given, only wipe entries of those types -
    e.g. refreshing Notebooks won't touch previously-harvested Lakehouses.
    Omitting asset_types falls back to wiping everything for the scope
    (kept for backward compatibility, but the harvest engine always passes
    asset_types now).
    """
    with get_conn() as conn:
        clauses = ["connector_type = ?"]
        params = [connector_type]
        if connector_id:
            clauses.append("connector_id = ?")
            params.append(connector_id)
        if asset_types:
            placeholders = ",".join("?" for _ in asset_types)
            clauses.append(f"type IN ({placeholders})")
            params.extend(asset_types)
        conn.execute(f"DELETE FROM harvested_assets WHERE {' AND '.join(clauses)}", params)


def delete_asset(asset_id):
    """
    Removes one harvested-metadata record from the catalog by its id.

    This only forgets what a past harvest recorded about the item - it never
    touches the real Lakehouse/table/file the metadata describes, and it
    doesn't cascade to anything: S2D mappings and test cases reference a
    connector+container by id, not this row, so they're untouched. The one
    real consequence is that harvested_table_names() (catalog/db.py) will
    then report this container as never harvested, so Test Data Preparation's
    table picker goes back to showing "not harvested yet" for it until it's
    re-harvested. Returns True if a row was actually deleted.
    """
    with get_conn() as conn:
        cursor = conn.execute("DELETE FROM harvested_assets WHERE id = ?", (asset_id,))
        return cursor.rowcount > 0


def delete_assets(asset_ids):
    """
    Bulk version of delete_asset - same "metadata only, nothing cascades"
    guarantee, for the Catalog Viewer's multi-select delete. Returns the
    number of rows actually deleted, which can be less than len(asset_ids) if
    some were already gone (another tab, a concurrent delete).
    """
    if not asset_ids:
        return 0
    with get_conn() as conn:
        placeholders = ",".join("?" for _ in asset_ids)
        cursor = conn.execute(
            f"DELETE FROM harvested_assets WHERE id IN ({placeholders})", list(asset_ids)
        )
        return cursor.rowcount


def list_assets(connector_id=None, connector_type=None, asset_type=None, search=None):
    query = "SELECT * FROM harvested_assets WHERE 1=1"
    params = []
    if connector_id:
        query += " AND connector_id = ?"
        params.append(connector_id)
    elif connector_type:
        query += " AND connector_type = ?"
        params.append(connector_type)
    if asset_type:
        query += " AND type = ?"
        params.append(asset_type)
    if search:
        query += " AND name LIKE ?"
        params.append(f"%{search}%")
    query += " ORDER BY harvested_at DESC"

    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        results = []
        for r in rows:
            row = dict(r)
            row.pop('schema_json', None)
            results.append(row)
        return results


def get_asset(asset_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM harvested_assets WHERE id = ?", (asset_id,)).fetchone()
        if not row:
            return None
        asset = dict(row)
        asset["schema"] = json.loads(asset["schema_json"]) if asset["schema_json"] else []
        del asset["schema_json"]
        return asset


def record_job(connector_type, connector_name, mode, asset_count, status,
                error_message=None, started_at=None, finished_at=None):
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO harvest_jobs
                (connector_type, connector_name, mode, asset_count, status, error_message, started_at, finished_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (connector_type, connector_name, mode, asset_count, status,
              error_message, started_at, finished_at))


# --- Connector configs -------------------------------------------------------
# NOTE: client_secret is stored in plaintext in this SQLite file, same trust
# model as the current .env file. Fine for an internal tool on a trusted
# machine; if this ever needs to run somewhere less trusted, swap this for
# a secrets manager (Azure Key Vault, etc) before storing real credentials.

def create_connector_config(name, type, tenant_id=None, client_id=None,
                             client_secret=None, workspace_id=None):
    import uuid
    config_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    with get_conn() as conn:
        conn.execute("""
            INSERT INTO connector_configs
                (id, name, type, tenant_id, client_id, client_secret, workspace_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (config_id, name, type, tenant_id, client_id, client_secret, workspace_id, now))
    return config_id


def harvested_container_ids(connector_id, item_type="Lakehouse"):
    """
    The Fabric item ids of everything of `item_type` this connector has
    harvested. Harvesting a Lakehouse is a deliberate act - it says "this is one
    I care about" - so it is a far better answer to "which containers should I
    be offered" than "every Lakehouse that exists in the workspace".
    """
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT source_item_id FROM harvested_assets WHERE connector_id = ? AND type = ?",
            (connector_id, item_type),
        ).fetchall()
    return {r["source_item_id"] for r in rows if r["source_item_id"]}


def harvested_table_names(connector_id, container_id):
    """
    The table names recorded the last time this connector+container was
    harvested, or None if it has never been harvested at all - deliberately
    distinct from "harvested, but the harvest found zero tables", which is a
    real (if unlikely) state a caller needs to tell apart from "go harvest
    this first". `schema_json` already holds the whole table list from that
    harvest (`[{table, kind, columns}, ...]`), same shape `get_asset()` above
    decodes - this just narrows it to names for a membership check.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT schema_json FROM harvested_assets WHERE connector_id = ? AND source_item_id = ?",
            (connector_id, container_id),
        ).fetchone()
    if not row or not row["schema_json"]:
        return None
    tables = json.loads(row["schema_json"])
    return {t["table"] for t in tables}


def list_connector_configs(user_id=None):
    """
    user_id, when given, scopes the result to every org-shared connector
    (owner_user_id IS NULL, unchanged for everyone) PLUS that one user's own
    personal test-data connector - never anyone else's. Omitting user_id
    keeps the old unscoped behavior for any internal caller that genuinely
    wants every connector regardless of ownership (e.g. an admin/background
    job), but every request-scoped route should pass it.
    """
    query = """
        SELECT id, name, type, workspace_id, allowed_containers_json, created_at,
               owner_user_id, purpose
        FROM connector_configs
    """
    params = []
    if user_id is not None:
        query += " WHERE owner_user_id IS NULL OR owner_user_id = ?"
        params.append(user_id)
    query += " ORDER BY created_at DESC"

    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        results = []
        for r in rows:
            row = dict(r)
            row["allowed_containers"] = json.loads(row["allowed_containers_json"]) if row["allowed_containers_json"] else None
            del row["allowed_containers_json"]
            results.append(row)
        return results


def get_or_create_test_data_connector(user_id, display_name):
    """
    Every tester gets exactly one personal Local connector for their
    hand-built synthetic test tables, created lazily on their first "Generate
    Test Data" action - never eagerly, never shared. type='local' so it needs
    zero changes anywhere else in the app (connector_factory, LocalConnector,
    every table picker) to behave like any other Local connector; only
    owner_user_id/purpose distinguish it for ownership checks and UI labeling.

    The unique index on (owner_user_id) WHERE purpose='test_data' is the real
    guarantee here: if two requests from the same tester race past the SELECT
    at once, the loser's INSERT hits that index and raises
    sqlite3.IntegrityError - caught below, re-SELECT picks up the winner's
    row instead of erroring the request.
    """
    import uuid

    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM connector_configs WHERE purpose = 'test_data' AND owner_user_id = ?",
            (user_id,),
        ).fetchone()
        if row:
            return row["id"]

        config_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        try:
            conn.execute("""
                INSERT INTO connector_configs (id, name, type, owner_user_id, purpose, created_at)
                VALUES (?, ?, 'local', ?, 'test_data', ?)
            """, (config_id, display_name, user_id, now))
        except sqlite3.IntegrityError:
            row = conn.execute(
                "SELECT id FROM connector_configs WHERE purpose = 'test_data' AND owner_user_id = ?",
                (user_id,),
            ).fetchone()
            return row["id"]
        return config_id


def is_test_data_connector_owned_by(connector_id, user_id):
    """
    True only if connector_id exists, is a personal test-data connector, AND
    belongs to this user - the check every new test-data route runs before
    touching anything, so one tester's synthetic tables are never reachable
    through another tester's session even if they learn the connector_id.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM connector_configs WHERE id = ? AND purpose = 'test_data' AND owner_user_id = ?",
            (connector_id, user_id),
        ).fetchone()
        return row is not None


def get_connector_config(config_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM connector_configs WHERE id = ?", (config_id,)).fetchone()
        return dict(row) if row else None


def update_connector_containers(config_id, containers):
    """containers: list of {"id": ..., "name": ...} - the pinned pair for a Fabric connector."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE connector_configs SET allowed_containers_json = ? WHERE id = ?",
            (json.dumps(containers), config_id),
        )


def delete_connector_config(config_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM connector_configs WHERE id = ?", (config_id,))


def count_connector_configs():
    with get_conn() as conn:
        row = conn.execute("SELECT COUNT(*) as c FROM connector_configs").fetchone()
        return row["c"]