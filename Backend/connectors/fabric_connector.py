import base64
import csv
import io
import re
import time
import uuid

import requests
import duckdb
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

from azure.identity import ClientSecretCredential

from .base import BaseConnector, AssetItem, ColumnInfo, build_row_count_query
from .sql_guard import clean_explain_error, validate_select_only
from .fabric_notebook_template import NOTEBOOK_SOURCE
from .fabric_pyspark_test_notebook_template import NOTEBOOK_SOURCE as PYSPARK_TEST_NOTEBOOK_SOURCE

FABRIC_API_BASE = "https://api.fabric.microsoft.com/v1"
FABRIC_TOKEN_SCOPE = "https://api.fabric.microsoft.com/.default"
SQL_TOKEN_SCOPE = "https://database.windows.net/.default"
# OneLake's DFS surface is ADLS Gen2-compatible and documented as accepting a
# storage-scoped AAD token. NOT yet verified against a live tenant - if the
# service principal's token for this scope is rejected, this is the one line
# to change (e.g. to "https://onelake.dfs.fabric.microsoft.com/.default").
ONELAKE_TOKEN_SCOPE = "https://storage.azure.com/.default"
ONELAKE_DFS_BASE = "https://onelake.dfs.fabric.microsoft.com"

# Fixed names so ensure_test_data_notebook()/ensure_test_case_notebook() can
# find and reuse the same notebook item across calls/restarts instead of
# creating a new one every time.
TEST_DATA_NOTEBOOK_NAME = "DQC Test Data Inserter"
TEST_CASE_NOTEBOOK_NAME = "DQC PySpark Test Case Runner"
# Fabric job type for a notebook run, analogous to jobType=Pipeline above.
NOTEBOOK_JOB_TYPE = "RunNotebook"

# Fixed alias used for every ATTACH - each run_query()/get_schema() call
# opens its own short-lived DuckDB connection (mirroring how the old
# pyodbc connections were opened per-call), so there's never more than
# one attached catalog alive at a time and no name collision risk.
ATTACHED_DB_ALIAS = "fabric_db"

# A Fabric job instance is finished in every state except these two.
PIPELINE_ACTIVE_STATUSES = ("NotStarted", "InProgress")

# Lakehouses Fabric creates for ITSELF, which are type "Lakehouse" like any
# other and so survive a plain type filter. Every Dataflow Gen2 configuration
# spawns a StagingLakehouseForDataflows_<timestamp>, so a workspace that uses
# dataflows accumulates them indefinitely - one workspace here already has four,
# outnumbering the Lakehouses anyone would actually validate. They hold Fabric's
# intermediate spill, never user data, so offering them as a validation target
# is offering somewhere a test can only ever be meaningless.
FABRIC_INTERNAL_LAKEHOUSE_PREFIXES = (
    "staginglakehousefordataflows",
    "dataflowsstaginglakehouse",
    "dataflowsstagingwarehouse",
)


def is_fabric_internal_container(name):
    """True for a Lakehouse Fabric created for its own plumbing."""
    lowered = (name or "").strip().lower()
    return any(lowered.startswith(p) for p in FABRIC_INTERNAL_LAKEHOUSE_PREFIXES)

# Microsoft Fabric currently refuses to let a service principal refresh a
# Dataflow Gen2 at all: the trigger POST succeeds (a job instance is created)
# but the run itself always fails with this exact message, regardless of the
# SP's role - there is no permission that fixes it. Confirmed against a live
# workspace (SPN-triggered runs on the same dataflow failed with this message
# every time, interleaved with portal/delegated-login runs that completed
# fine minutes apart) and against Microsoft's own docs, which list under
# Dataflow Gen2 API limitations: "Service principal authentication isn't
# supported... you can invoke Run APIs, but the actual run never succeeds."
# https://learn.microsoft.com/en-us/fabric/data-factory/dataflow-gen2-public-apis#current-limitations
_SPN_DATAFLOW_REFRESH_BLOCKED = "spn based refresh is not allowed"


def _translate_failure_reason(message):
    """
    Rewrites Fabric's own failure text into something actionable when it's a
    known, unfixable-by-config platform limitation - otherwise passed through
    unchanged. The original Fabric message is kept in parentheses rather than
    replaced outright, so nothing is hidden from someone who wants the raw text.
    """
    if message and _SPN_DATAFLOW_REFRESH_BLOCKED in message.lower():
        return (
            "Fabric doesn't allow a service principal to refresh a Dataflow Gen2 - this is a "
            "current Fabric platform limitation, not a problem with this connector's permissions, "
            "and it will fail every time it's triggered from here. Refresh this dataflow manually "
            "in the Fabric portal (your own sign-in) or via Fabric's own native scheduled refresh "
            f"instead. (Fabric said: {message})"
        )
    return message


def table_name_to_onelake_path(table_name):
    """
    '"dbo"."orders"' (this app's fully-qualified table naming, see
    _build_table_entry) -> 'dbo/orders' (OneLake's Tables/<schema>/<table>
    folder convention). Strips one layer of doubled-quote escaping per part,
    matching how _build_table_entry originally quoted the identifiers.
    """
    parts = re.findall(r'"((?:[^"]|"")*)"', table_name)
    if len(parts) != 2:
        raise ValueError(f"Expected a quoted \"schema\".\"table\" name, got: {table_name!r}")
    schema, table = (p.replace('""', '"') for p in parts)
    return f"{schema}/{table}"


def _pipeline_run_to_dict(payload):
    """
    One Fabric job instance, flattened to what the Pipelines tab needs.
    status is Fabric's own: NotStarted | InProgress | Completed | Failed |
    Cancelled | Deduped. failureReason arrives as a nested object, so the
    human-readable message is lifted out of it.
    """
    payload = payload or {}
    failure = payload.get("failureReason") or {}
    if isinstance(failure, dict):
        failure_message = failure.get("message") or failure.get("errorCode")
    else:
        failure_message = str(failure)

    status = payload.get("status")
    return {
        "id": payload.get("id"),
        "status": status,
        "is_running": status in PIPELINE_ACTIVE_STATUSES,
        "started_at": payload.get("startTimeUtc"),
        "finished_at": payload.get("endTimeUtc"),
        "invoke_type": payload.get("invokeType"),
        "failure_reason": _translate_failure_reason(failure_message),
    }


class FabricConnector(BaseConnector):
    """
    Talks to Fabric Lakehouses entirely through DuckDB's 'mssql' community
    extension, attached to the same SQL Analytics Endpoint the old pyodbc
    implementation used - just authenticated with a plain OAuth access
    token instead of ODBC Driver 18.

    This was validated end-to-end against a real Fabric workspace:
    DuckDB-dialect SQL (||, LENGTH(), regexp_matches(), GROUP BY/HAVING)
    all translate correctly through the attachment, and DuckDB's own
    duckdb_tables()/duckdb_columns() introspection functions correctly
    list the attached Lakehouse's real tables/columns. That means Local
    and Fabric connectors now share exactly one SQL dialect - test-case
    scripts no longer need a T-SQL variant at all.
    """

    connector_type = "fabric"

    def __init__(self, tenant_id, client_id, client_secret, workspace_id, allowed_containers=None):
        self.tenant_id = tenant_id
        self.client_id = client_id
        self.client_secret = client_secret
        self.workspace_id = workspace_id
        # The pinned set of Lakehouses for S2D/Harvest, e.g. [{"id":..,"name":..}, ...].
        # None means "not pinned yet" - list_containers()/list_items() fall
        # back to showing every Lakehouse in the workspace in that case.
        self.allowed_containers = allowed_containers
        self._lakehouse_conn_cache = {}
        # Resolved once per process, then reused - see ensure_test_data_notebook / ensure_test_case_notebook.
        self._test_data_notebook_id = None
        self._test_case_notebook_id = None

    # --- auth -----------------------------------------------------------

    def _get_credential(self):
        return ClientSecretCredential(
            tenant_id=self.tenant_id, client_id=self.client_id, client_secret=self.client_secret,
        )

    def _get_fabric_token(self):
        return self._get_credential().get_token(FABRIC_TOKEN_SCOPE).token

    def _get_sql_token(self):
        """Separate scope from the Fabric REST API token - this one authenticates to the SQL endpoint itself."""
        return self._get_credential().get_token(SQL_TOKEN_SCOPE).token

    def _get_onelake_token(self):
        """Third scope, for OneLake's ADLS Gen2-compatible DFS API - see ONELAKE_TOKEN_SCOPE's comment."""
        return self._get_credential().get_token(ONELAKE_TOKEN_SCOPE).token

    def _api_get(self, path):
        token = self._get_fabric_token()
        headers = {"Authorization": f"Bearer {token}"}
        url = f"{FABRIC_API_BASE}{path}"

        all_items = []
        next_url = url
        next_params = None

        while next_url:
            # Added verify=False to bypass the corporate proxy SSL issue
            resp = requests.get(next_url, headers=headers, params=next_params, timeout=30, verify=False)
            resp.raise_for_status()
            payload = resp.json()

            if "value" in payload:
                all_items.extend(payload["value"])
                continuation_token = payload.get("continuationToken")
                continuation_uri = payload.get("continuationUri")
                if continuation_uri:
                    next_url = continuation_uri
                    next_params = None
                elif continuation_token:
                    next_url = url
                    next_params = {"continuationToken": continuation_token}
                else:
                    next_url = None
            else:
                return payload

        return all_items

    def _api_post(self, path, json=None):
        """
        Same auth/timeout/proxy handling as _api_get, but returns the raw
        response rather than a parsed payload: the job-trigger endpoint answers
        202 Accepted with an EMPTY body and puts the new job-instance id in the
        Location header, so callers need the status and headers too.

        json: optional request body (e.g. a notebook run's executionData
        parameters, or an item-create payload) - None (the original
        behavior, used by run_pipeline) sends no body at all.
        """
        token = self._get_fabric_token()
        headers = {"Authorization": f"Bearer {token}"}
        # verify=False for the same corporate-proxy SSL reason as _api_get.
        return requests.post(
            f"{FABRIC_API_BASE}{path}", headers=headers, json=json, timeout=60, verify=False,
        )

    
    def _resolve_lakehouse_connection(self, lakehouse_id):
        if lakehouse_id in self._lakehouse_conn_cache:
            return self._lakehouse_conn_cache[lakehouse_id]

        item = self._api_get(f"/workspaces/{self.workspace_id}/lakehouses/{lakehouse_id}")
        props = item.get("properties", {}) or {}
        sql_endpoint = props.get("sqlEndpointProperties", {}) or {}
        server = sql_endpoint.get("connectionString")
        database = item.get("displayName")

        if not server or not database:
            raise RuntimeError("Lakehouse SQL analytics endpoint isn't provisioned yet")

        # sqlEndpointProperties carries the SQL endpoint's OWN item id
        # (distinct from the Lakehouse's id) - needed to target the
        # refresh-metadata call below. May be absent on older API responses;
        # refresh_sql_endpoint_metadata() just no-ops if so.
        conn_info = {"server": server, "database": database, "sql_endpoint_id": sql_endpoint.get("id")}
        self._lakehouse_conn_cache[lakehouse_id] = conn_info
        return conn_info

    def refresh_sql_endpoint_metadata(self, lakehouse_id):
        """
        Forces Fabric to sync the Lakehouse's SQL analytics endpoint against
        its real Delta tables right now, instead of waiting for Fabric's own
        (sometimes multi-minute) background sync. That endpoint is what
        run_query/list_tables_in_container/row counts all read through - it
        is NOT a live view of the Lakehouse, it's a separately-synced replica,
        which is why a table can look unchanged for a while right after a
        real write (e.g. this app's own PySpark insert) until Fabric catches
        up on its own.

        Best-effort and NOT yet verified against a live tenant (this exact
        endpoint path/shape is my best documented answer, not confirmed
        live) - swallows any failure rather than blocking whatever called
        it, since the caller's own query will still work, just possibly
        against slightly stale metadata.
        """
        try:
            conn_info = self._resolve_lakehouse_connection(lakehouse_id)
            sql_endpoint_id = conn_info.get("sql_endpoint_id")
            if not sql_endpoint_id:
                return False
            resp = self._api_post(f"/workspaces/{self.workspace_id}/sqlEndpoints/{sql_endpoint_id}/refreshMetadata")
            return resp.status_code in (200, 202)
        except Exception as e:
            print(f"Could not refresh SQL endpoint metadata for lakehouse {lakehouse_id}: {e}")
            return False

    def _duckdb_attach(self, lakehouse_id):
        """
        Fresh DuckDB connection with the Lakehouse's SQL endpoint attached
        as 'fabric_db'. A new access token is fetched every call since
        these connections are short-lived and tokens expire in ~1hr -
        simpler than trying to cache/refresh one across calls.
        """
        conn_info = self._resolve_lakehouse_connection(lakehouse_id)
        sql_token = self._get_sql_token()

        con = duckdb.connect()
        con.execute("INSTALL mssql FROM community;")
        con.execute("LOAD mssql;")
        con.execute(f"""
            ATTACH 'Server={conn_info["server"]};Database={conn_info["database"]}' AS {ATTACHED_DB_ALIAS}
            (TYPE mssql, ACCESS_TOKEN '{sql_token}');
        """)
        # Without this, unqualified two-part "schema"."table" references (what
        # every test-case script and the table dropdown both use) fail to
        # resolve - the newly attached catalog isn't the connection's default
        # until explicitly selected, so DuckDB looks for "dbo" in the empty
        # in-memory catalog instead and errors with "schema does not exist".
        # A bare `USE fabric_db` doesn't work either - DuckDB reads a single
        # identifier there as a schema-set, not a catalog switch - so the
        # catalog.schema form is required to land on fabric_db.dbo.
        con.execute(f"USE {ATTACHED_DB_ALIAS}.dbo;")
        return con

    # --- BaseConnector interface -----------------------------------------

    def test_connection(self):
        try:
            self._get_fabric_token()
            self._api_get(f"/workspaces/{self.workspace_id}")
            return True, "Connected successfully"
        except Exception as e:
            return False, str(e)

    def list_items(self):
        """
        Full workspace inventory used by Harvest. Once a set of Lakehouses
        is pinned (for S2D), this is scoped down to just those Lakehouses
        too - but Notebooks/Reports/Warehouses/SemanticModels are never
        part of the pinning concept, so they're always shown in full.
        """
        items = self._api_get(f"/workspaces/{self.workspace_id}/items")
        all_items = [
            AssetItem(
                id=i.get("id"), name=i.get("displayName"), type=i.get("type", "Other"),
                extra={"description": i.get("description", "")},
            )
            for i in items
        ]

        if self.allowed_containers:
            allowed_ids = {c["id"] for c in self.allowed_containers}
            return [i for i in all_items if i.type != "Lakehouse" or i.id in allowed_ids]

        return all_items

    def list_all_lakehouses(self):
        """
        Deliberately unfiltered - ignores any current pinning. This is
        what the Connect page's pinning UI itself needs to see, since
        list_items() narrows Lakehouses down to whatever's already
        pinned; using that here would make it impossible to ever pin
        something new once anything was pinned.
        """
        items = self._api_get(f"/workspaces/{self.workspace_id}/items")
        return [
            AssetItem(id=i.get("id"), name=i.get("displayName"), type=i.get("type", "Other"))
            for i in items
            if i.get("type") == "Lakehouse" and not is_fabric_internal_container(i.get("displayName"))
        ]

    def list_containers(self):
        """
        S2D-facing container list - only the pinned Lakehouses, once pinning has
        been configured via the Connect page. Falls back to every Lakehouse in
        the workspace if nothing's pinned yet.

        Fabric's own staging Lakehouses are excluded from the fallback: they are
        real Lakehouses by type, but they hold dataflow spill rather than data
        anyone would validate, and a workspace that uses Dataflow Gen2 breeds
        them. An explicitly pinned one is still honoured - if somebody
        deliberately pinned it, that is their call to make, not this list's.
        """
        if self.allowed_containers:
            return [
                {"id": c["id"], "name": c["name"], "type": "Lakehouse"}
                for c in self.allowed_containers
            ]
        return [
            {"id": i.id, "name": i.name, "type": "Lakehouse"}
            for i in self.list_items()
            if i.type == "Lakehouse" and not is_fabric_internal_container(i.name)
        ]

    def _build_table_entry(self, con, schema, name, kind):
        cols = con.execute(
            "SELECT column_name, data_type, is_nullable, column_default FROM duckdb_columns() "
            f"WHERE database_name = '{ATTACHED_DB_ALIAS}' AND schema_name = ? AND table_name = ? "
            "ORDER BY column_index",
            [schema, name],
        ).fetchall()
        columns = [
            ColumnInfo(name=c[0], data_type=c[1], nullable=bool(c[2]), default=c[3]).to_dict()
            for c in cols
        ]
        # Double-quote each part individually - some tables get a literal
        # ".csv"/".parquet" baked into their name when auto-loaded from a
        # file, and an unquoted "schema.name.csv" would parse ambiguously.
        # DuckDB uses double quotes for quoted identifiers (T-SQL's square
        # brackets have no special meaning to DuckDB's own SQL parser,
        # which is what actually parses every query now, before anything
        # gets pushed down to the attached SQL Server endpoint).
        return {
            "table": f'"{schema}"."{name}"',
            "kind": kind,
            "columns": columns,
        }

    def get_schema(self, item_id, item_type, include_row_counts=False):
        if item_type != "Lakehouse":
            # Notebooks/Reports/etc have no tabular schema through this connector
            return []

        con = self._duckdb_attach(item_id)
        try:
            tables = con.execute(
                f"SELECT schema_name, table_name FROM duckdb_tables() "
                f"WHERE database_name = '{ATTACHED_DB_ALIAS}' ORDER BY schema_name, table_name"
            ).fetchall()
            views = con.execute(
                f"SELECT schema_name, view_name FROM duckdb_views() "
                f"WHERE database_name = '{ATTACHED_DB_ALIAS}' ORDER BY schema_name, view_name"
            ).fetchall()

            result = [self._build_table_entry(con, schema, name, "BASE TABLE") for schema, name in tables]
            result += [self._build_table_entry(con, schema, name, "VIEW") for schema, name in views]

            if include_row_counts and result:
                self._attach_row_counts(con, result)
            return result
        finally:
            con.close()

    def _attach_row_counts(self, con, entries):
        """
        Adds "row_count" to each entry using the connection that's ALREADY open.

        Reusing this attachment is the whole point: opening it costs ~9s against
        a live Lakehouse while each count costs well under a second, so counting
        here is nearly free whereas a separate call would roughly double the wait
        before the tester sees anything.

        One query PER TABLE, deliberately - see build_row_count_query for the
        measurements showing that combining them into one statement returns wrong
        numbers through the mssql extension.

        Each count is guarded individually so one unreadable table degrades to
        row_count=None instead of costing every other table its count, and the
        table list itself - which every picker depends on - can never be lost to
        a failure fetching a nice-to-have.
        """
        for entry in entries:
            entry["row_count"] = None
            try:
                row = con.execute(build_row_count_query(entry["table"])).fetchone()
                entry["row_count"] = row[0] if row else None
            except Exception as e:
                print(f"Row count failed for {entry['table']}, showing it without one: {e}")

    def list_tables_in_container(self, container_id, include_row_counts=False):
        """container_id here is a Lakehouse id."""
        return self.get_schema(container_id, "Lakehouse", include_row_counts=include_row_counts)

    def run_query(self, container_id, sql):
        """
        Run one read-only SELECT against this Lakehouse's SQL analytics
        endpoint (via the DuckDB attachment) and return the first row as
        a dict, or None if empty. container_id is a Lakehouse id.
        """
        normalized = validate_select_only(sql)

        con = self._duckdb_attach(container_id)
        try:
            row = con.execute(normalized).fetchone()
            if row is None:
                return None
            columns = [d[0] for d in con.description]
            return dict(zip(columns, row))
        finally:
            con.close()

    def run_query_all(self, container_id, sql):
        """Like run_query(), but returns every matching row. container_id is a Lakehouse id."""
        normalized = validate_select_only(sql)

        con = self._duckdb_attach(container_id)
        try:
            result = con.execute(normalized).fetchall()
            columns = [d[0] for d in con.description]
            return [dict(zip(columns, row)) for row in result]
        finally:
            con.close()

    # --- Real writes: staged file + Spark notebook job --------------------
    #
    # Fabric's SQL analytics endpoint - what run_query/run_query_all/
    # sample_rows all use - is READ-ONLY for every Lakehouse table by
    # Microsoft's own design (error 24559 on any INSERT/UPDATE/DELETE,
    # regardless of permissions). That is not a bug this connector can code
    # around: a prior version of this method tried a plain SQL-endpoint
    # INSERT and it failed against every real Lakehouse table it was tried
    # against. The only ways Fabric allows writing into a Lakehouse Delta
    # table are a Spark notebook, a Data Pipeline/Dataflow, or a direct
    # OneLake file write - this uses the first: stage the rows as a CSV in
    # the target Lakehouse's OneLake Files area, then run a small fixed
    # notebook that reads that file and appends it to the target table via
    # Spark. Never reachable from generic test-case SQL; only an explicit,
    # tester-confirmed "Insert into Fabric table" action (app.py's
    # insert-rows route) calls this, gated by a confirm flag on top of the
    # frontend's own confirmation dialog.

    def _onelake_dfs_url(self, lakehouse_id, rel_path):
        return f"{ONELAKE_DFS_BASE}/{self.workspace_id}/{lakehouse_id}/{rel_path}"

    def write_staging_file(self, lakehouse_id, columns, rows):
        """
        Writes `rows` as a CSV into this Lakehouse's OneLake Files area
        under _test_data_staging/<uuid>.csv, via the ADLS Gen2 DFS
        protocol's three calls (create, append, flush) - the same protocol
        every OneLake-compatible client uses. Returns the relative path
        (e.g. "_test_data_staging/<uuid>.csv") for the notebook job to read
        and for cleanup_staging_file to delete afterward.
        """
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=[c["name"] for c in columns])
        writer.writeheader()
        for row in rows:
            writer.writerow({c["name"]: row.get(c["name"], "") for c in columns})
        body = buf.getvalue().encode("utf-8")

        rel_path = f"_test_data_staging/{uuid.uuid4()}.csv"
        token = self._get_onelake_token()
        headers = {"Authorization": f"Bearer {token}"}
        base = self._onelake_dfs_url(lakehouse_id, f"Files/{rel_path}")

        # OneLake's DFS API is a new endpoint for this app - every other
        # Fabric call here (REST API, SQL endpoint) already goes through
        # whatever corporate proxy this network sits behind, but this is
        # the first time THIS specific path has been exercised, and its
        # first live attempt read-timed-out at 30s with no other error -
        # the connection reached OneLake fine, it just didn't answer in
        # time. Generous timeouts here rather than a short one that assumes
        # OneLake responds as fast as the already-proven endpoints do.
        create_resp = requests.put(base, headers=headers, params={"resource": "file"}, timeout=90, verify=False)
        create_resp.raise_for_status()
        append_resp = requests.patch(
            base, headers={**headers, "Content-Type": "application/octet-stream"},
            params={"action": "append", "position": 0}, data=body, timeout=180, verify=False,
        )
        append_resp.raise_for_status()
        flush_resp = requests.patch(
            base, headers=headers, params={"action": "flush", "position": len(body)}, timeout=90, verify=False,
        )
        flush_resp.raise_for_status()
        return rel_path

    def cleanup_staging_file(self, lakehouse_id, staging_path):
        """Best-effort delete once a notebook job reaches a terminal state - never raises."""
        try:
            token = self._get_onelake_token()
            requests.delete(
                self._onelake_dfs_url(lakehouse_id, f"Files/{staging_path}"),
                headers={"Authorization": f"Bearer {token}"}, timeout=90, verify=False,
            )
        except Exception as e:
            print(f"Could not clean up staging file {staging_path}: {e}")

    def read_onelake_file(self, lakehouse_id, rel_path):
        """Reads a small file back from this Lakehouse's OneLake Files area - used to read a notebook job's result file."""
        token = self._get_onelake_token()
        resp = requests.get(
            self._onelake_dfs_url(lakehouse_id, f"Files/{rel_path}"),
            headers={"Authorization": f"Bearer {token}"}, timeout=90, verify=False,
        )
        resp.raise_for_status()
        return resp.content

    def _notebook_definition_payload(self, source):
        return {
            "definition": {
                "parts": [{
                    "path": "notebook-content.py",
                    "payload": base64.b64encode(source.encode("utf-8")).decode("ascii"),
                    "payloadType": "InlineBase64",
                }],
            },
        }

    def _ensure_notebook(self, name, source, cache_attr):
        """
        Shared by ensure_test_data_notebook and ensure_test_case_notebook:
        finds a fixed-named notebook item, creating it if this workspace
        doesn't have one yet.

        Also pushes the CURRENT template content to an already-existing
        notebook every time (via updateDefinition), rather than trusting
        whatever was there from the first time it was created - these
        templates are still being fixed (see tasks/lessons.md), and without
        this an already-provisioned workspace would keep silently running a
        stale, possibly-broken version of the notebook after every code fix
        here, with no way to notice short of manually deleting it in the
        Fabric portal. The item id itself is still cached in memory per
        connector instance/process - only the definition sync runs fresh
        each time, which is cheap next to the job it's about to run.
        """
        cached = getattr(self, cache_attr)
        if cached:
            self._sync_notebook_definition(cached, name, source)
            return cached

        for item in self.list_items():
            if item.type == "Notebook" and item.name == name:
                setattr(self, cache_attr, item.id)
                self._sync_notebook_definition(item.id, name, source)
                return item.id

        resp = self._api_post(
            f"/workspaces/{self.workspace_id}/items",
            json={"displayName": name, "type": "Notebook", **self._notebook_definition_payload(source)},
        )
        if resp.status_code not in (200, 201, 202):
            detail = (resp.text or "").strip()
            raise RuntimeError(f"Could not create the \"{name}\" notebook (HTTP {resp.status_code}): {detail[:400]}")

        body = (resp.json() if resp.content else None) or {}
        notebook_id = body.get("id")
        if not notebook_id:
            # A 202 with no id in the body means item creation is itself an
            # async Fabric operation - the item can take a few seconds to
            # actually show up in list_items() after the POST returns, so a
            # single immediate re-list can race that propagation delay and
            # find nothing (this failed live on a real workspace with
            # exactly one attempt - see tasks/lessons.md). Retrying a few
            # times with a short wait is far more robust than assuming the
            # first check is authoritative.
            for attempt in range(5):
                if attempt > 0:
                    time.sleep(3)
                for item in self.list_items():
                    if item.type == "Notebook" and item.name == name:
                        notebook_id = item.id
                        break
                if notebook_id:
                    break
        if not notebook_id:
            raise RuntimeError(f"\"{name}\" notebook was created but its item id could not be resolved")

        setattr(self, cache_attr, notebook_id)
        return notebook_id

    def _sync_notebook_definition(self, notebook_id, name, source):
        """Best-effort push of the current template onto an existing notebook item - never blocks a run over it."""
        try:
            resp = self._api_post(
                f"/workspaces/{self.workspace_id}/items/{notebook_id}/updateDefinition",
                json=self._notebook_definition_payload(source),
            )
            if resp.status_code not in (200, 202):
                print(f"Could not sync \"{name}\" notebook's definition (HTTP {resp.status_code}): {(resp.text or '').strip()[:400]}")
        except Exception as e:
            print(f"Could not sync \"{name}\" notebook's definition: {e}")

    def ensure_test_data_notebook(self):
        return self._ensure_notebook(TEST_DATA_NOTEBOOK_NAME, NOTEBOOK_SOURCE, "_test_data_notebook_id")

    def ensure_test_case_notebook(self):
        return self._ensure_notebook(TEST_CASE_NOTEBOOK_NAME, PYSPARK_TEST_NOTEBOOK_SOURCE, "_test_case_notebook_id")

    def run_notebook_insert(self, lakehouse_id, table_name, staging_path):
        """
        Submits the notebook job that appends `staging_path`'s rows into
        `table_name`. Returns the new job-instance id, same shape as
        run_pipeline (202 + Location header, list-runs fallback).
        """
        notebook_id = self.ensure_test_data_notebook()
        table_path = table_name_to_onelake_path(table_name)
        params = {
            "workspace_id": {"value": self.workspace_id, "type": "string"},
            "lakehouse_id": {"value": lakehouse_id, "type": "string"},
            "table_path": {"value": table_path, "type": "string"},
            "staging_path": {"value": staging_path, "type": "string"},
        }
        resp = self._api_post(
            f"/workspaces/{self.workspace_id}/items/{notebook_id}/jobs/instances?jobType={NOTEBOOK_JOB_TYPE}",
            json={"executionData": {"parameters": params}},
        )
        if resp.status_code not in (200, 202):
            detail = (resp.text or "").strip()
            raise RuntimeError(f"HTTP {resp.status_code}: {detail[:400]}")

        location = resp.headers.get("Location") or ""
        job_instance_id = location.rstrip("/").rsplit("/", 1)[-1] if location else None
        if not job_instance_id:
            runs = self.get_notebook_job_history(notebook_id)
            job_instance_id = runs[0]["id"] if runs else None
        return notebook_id, job_instance_id

    def run_pyspark_test_case(self, lakehouse_id, script_text):
        """
        Submits a tester-authored PySpark script as an S2D test case run,
        via the fixed test-case notebook (see fabric_pyspark_test_notebook_
        template.py for the contract the script is expected to follow - a
        'result' dict, read_table() helper already in scope).

        script_text travels as a base64 job parameter (not staged as a
        file - it's normally small, unlike a bulk row insert) so no
        quoting/escaping concerns reach Fabric's parameter JSON. Returns
        (notebook_id, job_instance_id, result_path) - result_path is where
        the notebook will write its JSON result once done; the caller polls
        get_notebook_job then reads it back with read_onelake_file.
        """
        notebook_id = self.ensure_test_case_notebook()
        result_path = f"_test_case_results/{uuid.uuid4()}.json"
        params = {
            "workspace_id": {"value": self.workspace_id, "type": "string"},
            "lakehouse_id": {"value": lakehouse_id, "type": "string"},
            "script_b64": {"value": base64.b64encode(script_text.encode("utf-8")).decode("ascii"), "type": "string"},
            "result_path": {"value": result_path, "type": "string"},
        }
        resp = self._api_post(
            f"/workspaces/{self.workspace_id}/items/{notebook_id}/jobs/instances?jobType={NOTEBOOK_JOB_TYPE}",
            json={"executionData": {"parameters": params}},
        )
        if resp.status_code not in (200, 202):
            detail = (resp.text or "").strip()
            raise RuntimeError(f"HTTP {resp.status_code}: {detail[:400]}")

        location = resp.headers.get("Location") or ""
        job_instance_id = location.rstrip("/").rsplit("/", 1)[-1] if location else None
        if not job_instance_id:
            runs = self.get_notebook_job_history(notebook_id)
            job_instance_id = runs[0]["id"] if runs else None
        return notebook_id, job_instance_id, result_path

    def get_notebook_job(self, notebook_id, job_instance_id):
        """One notebook job instance's current state - same shape as get_pipeline_run."""
        payload = self._api_get(
            f"/workspaces/{self.workspace_id}/items/{notebook_id}/jobs/instances/{job_instance_id}"
        )
        return _pipeline_run_to_dict(payload)

    def get_notebook_job_history(self, notebook_id):
        payload = self._api_get(f"/workspaces/{self.workspace_id}/items/{notebook_id}/jobs/instances")
        runs = [_pipeline_run_to_dict(r) for r in (payload or [])]
        return sorted(runs, key=lambda r: r.get("started_at") or "", reverse=True)

    # --- Data pipelines ---------------------------------------------------

    def list_pipelines(self):
        """
        The workspace's Data Pipelines as [{"id", "name"}]. Unaffected by
        Lakehouse pinning - allowed_containers only ever narrows Lakehouses
        (see list_items), and a pipeline isn't a container.
        """
        return [
            {"id": item.id, "name": item.name}
            for item in self.list_items() if item.type == "DataPipeline"
        ]

    def run_pipeline(self, item_id):
        """
        Start a pipeline on demand and return the new job-instance id.

        Fabric answers 202 Accepted with an empty body, putting the instance id
        in the Location header. Raises RuntimeError with the upstream status and
        message on anything else, so the route can turn it into something the
        tester can act on.
        """
        resp = self._api_post(
            f"/workspaces/{self.workspace_id}/items/{item_id}/jobs/instances?jobType=Pipeline"
        )
        if resp.status_code not in (200, 202):
            detail = (resp.text or "").strip()
            raise RuntimeError(f"HTTP {resp.status_code}: {detail[:400]}")

        location = resp.headers.get("Location") or ""
        job_instance_id = location.rstrip("/").rsplit("/", 1)[-1] if location else None
        if not job_instance_id:
            # The run HAS started even without the header, so fall back to the
            # newest instance rather than failing - losing track of a live run
            # would be worse than one extra lookup.
            runs = self.list_pipeline_runs(item_id)
            job_instance_id = runs[0]["id"] if runs else None
        return job_instance_id

    def get_pipeline_run(self, item_id, job_instance_id):
        """One job instance's current state."""
        payload = self._api_get(
            f"/workspaces/{self.workspace_id}/items/{item_id}/jobs/instances/{job_instance_id}"
        )
        return _pipeline_run_to_dict(payload)

    def list_pipeline_runs(self, item_id):
        """
        Recent job instances, newest first. This is the call already verified
        against the live workspace with the existing service-principal token.
        """
        payload = self._api_get(
            f"/workspaces/{self.workspace_id}/items/{item_id}/jobs/instances"
        )
        runs = [_pipeline_run_to_dict(r) for r in (payload or [])]
        return sorted(runs, key=lambda r: r.get("started_at") or "", reverse=True)

    def validate_query(self, container_id, sql):
        """
        EXPLAIN the statement against this Lakehouse to parse + bind it without
        executing. Returns (ok, error_message). container_id is a Lakehouse id.

        Binding happens against the real attached schema, so this reports
        misspelled column and table names as well as syntax errors.
        """
        try:
            normalized = validate_select_only(sql)
        except ValueError as e:
            return False, str(e)

        try:
            con = self._duckdb_attach(container_id)
        except Exception as e:
            # Couldn't even reach the Lakehouse - that's an infrastructure
            # problem, not a verdict on the tester's SQL, so let the route
            # surface it as an upstream failure rather than "invalid query".
            raise RuntimeError(f"Could not connect to the Lakehouse: {e}")

        try:
            con.execute(f"EXPLAIN {normalized}")  # plan discarded - we only want the errors
            return True, None
        except Exception as e:
            return False, clean_explain_error(e)
        finally:
            con.close()

    def sample_rows(self, container_id, table, limit=20):
        """Random sample of rows for the AI rule-suggestion flow. container_id is a Lakehouse id."""
        con = self._duckdb_attach(container_id)
        try:
            result = con.execute(f"SELECT * FROM {table} ORDER BY RANDOM() LIMIT {limit}").fetchall()
            columns = [d[0] for d in con.description]
            return [dict(zip(columns, row)) for row in result]
        finally:
            con.close()