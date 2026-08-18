import requests
import duckdb
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

from azure.identity import ClientSecretCredential

from .base import BaseConnector, AssetItem, ColumnInfo, build_row_count_query
from .sql_guard import clean_explain_error, validate_select_only

FABRIC_API_BASE = "https://api.fabric.microsoft.com/v1"
FABRIC_TOKEN_SCOPE = "https://api.fabric.microsoft.com/.default"
SQL_TOKEN_SCOPE = "https://database.windows.net/.default"

# Fixed alias used for every ATTACH - each run_query()/get_schema() call
# opens its own short-lived DuckDB connection (mirroring how the old
# pyodbc connections were opened per-call), so there's never more than
# one attached catalog alive at a time and no name collision risk.
ATTACHED_DB_ALIAS = "fabric_db"

# A Fabric job instance is finished in every state except these two.
PIPELINE_ACTIVE_STATUSES = ("NotStarted", "InProgress")

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

    def _api_post(self, path):
        """
        Same auth/timeout/proxy handling as _api_get, but returns the raw
        response rather than a parsed payload: the job-trigger endpoint answers
        202 Accepted with an EMPTY body and puts the new job-instance id in the
        Location header, so callers need the status and headers too.
        """
        token = self._get_fabric_token()
        headers = {"Authorization": f"Bearer {token}"}
        # verify=False for the same corporate-proxy SSL reason as _api_get.
        return requests.post(
            f"{FABRIC_API_BASE}{path}", headers=headers, timeout=60, verify=False,
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

        conn_info = {"server": server, "database": database}
        self._lakehouse_conn_cache[lakehouse_id] = conn_info
        return conn_info

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
            for i in items if i.get("type") == "Lakehouse"
        ]

    def list_containers(self):
        """
        S2D-facing container list - only the pinned Lakehouses, once
        pinning has been configured via the Connect page. Falls back to
        every Lakehouse in the workspace if nothing's pinned yet.
        """
        if self.allowed_containers:
            return [
                {"id": c["id"], "name": c["name"], "type": "Lakehouse"}
                for c in self.allowed_containers
            ]
        return [
            {"id": i.id, "name": i.name, "type": "Lakehouse"}
            for i in self.list_items() if i.type == "Lakehouse"
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

    # --- Data pipelines ---------------------------------------------------

    # What Fabric calls the job when you start one. Determined from the live
    # API, not documentation: a Dataflow's own run history reports
    # jobType "Refresh", asking for its Pipeline schedules returns 400
    # InvalidJobType, and asking for its Refresh schedules returns 200.
    RUNNABLE_TYPES = {
        "DataPipeline": {"job_type": "Pipeline", "label": "Pipeline"},
        "Dataflow": {"job_type": "Refresh", "label": "Dataflow Gen2"},
    }

    def list_pipelines(self):
        """
        Everything in the workspace this framework can start on demand:
        Data Pipelines and Dataflow Gen2, as
        [{"id", "name", "type", "job_type", "label"}].

        Unaffected by Lakehouse pinning - allowed_containers only ever narrows
        Lakehouses (see list_items), and neither of these is a container.
        """
        runnable = []
        for item in self.list_items():
            spec = self.RUNNABLE_TYPES.get(item.type)
            if spec:
                runnable.append({
                    "id": item.id, "name": item.name, "type": item.type,
                    "job_type": spec["job_type"], "label": spec["label"],
                })
        # Pipelines first, then dataflows, each alphabetical - a stable order so
        # the list doesn't reshuffle between loads.
        runnable.sort(key=lambda i: (i["type"] != "DataPipeline", (i["name"] or "").lower()))
        return runnable

    def run_pipeline(self, item_id, job_type="Pipeline"):
        """
        Start a pipeline or a Dataflow Gen2 refresh on demand and return the new
        job-instance id. Everything after the POST - polling, run history - is
        identical for both, so only the job type varies.

        Fabric answers 202 Accepted with an empty body, putting the instance id
        in the Location header. Raises RuntimeError with the upstream status and
        message on anything else, so the route can turn it into something the
        tester can act on.
        """
        resp = self._api_post(
            f"/workspaces/{self.workspace_id}/items/{item_id}/jobs/instances?jobType={job_type}"
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