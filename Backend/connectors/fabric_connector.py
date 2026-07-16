import requests
import pyodbc

from azure.identity import ClientSecretCredential

from .base import BaseConnector, AssetItem, ColumnInfo
from .sql_guard import validate_select_only

FABRIC_API_BASE = "https://api.fabric.microsoft.com/v1"


class FabricConnector(BaseConnector):
    connector_type = "fabric"

    def __init__(self, tenant_id, client_id, client_secret, workspace_id, allowed_containers=None):
        self.tenant_id = tenant_id
        self.client_id = client_id
        self.client_secret = client_secret
        self.workspace_id = workspace_id
        # The pinned pair of Lakehouses for S2D, e.g. [{"id":..,"name":..}, ...].
        # None means "not pinned yet" - list_containers() falls back to
        # showing every Lakehouse in the workspace in that case.
        self.allowed_containers = allowed_containers
        self._lakehouse_conn_cache = {}

    # --- auth -----------------------------------------------------------

    def _get_token(self):
        credential = ClientSecretCredential(
            tenant_id=self.tenant_id,
            client_id=self.client_id,
            client_secret=self.client_secret,
        )
        token = credential.get_token("https://api.fabric.microsoft.com/.default")
        return token.token

    def _api_get(self, path):
        token = self._get_token()
        headers = {"Authorization": f"Bearer {token}"}
        url = f"{FABRIC_API_BASE}{path}"

        all_items = []
        next_url = url
        next_params = None

        while next_url:
            resp = requests.get(next_url, headers=headers, params=next_params, timeout=30)
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

    def _get_db_connection(self, server, database):
        conn_str = (
            f"Driver={{ODBC Driver 18 for SQL Server}};"
            f"Server={server},1433;"
            f"Database={database};"
            f"Authentication=ActiveDirectoryServicePrincipal;"
            f"UID={self.client_id};"
            f"PWD={self.client_secret};"
            f"Encrypt=yes;"
            f"TrustServerCertificate=no;"
        )
        return pyodbc.connect(conn_str)

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

    # --- BaseConnector interface -----------------------------------------

    def test_connection(self):
        try:
            self._get_token()
            self._api_get(f"/workspaces/{self.workspace_id}")
            return True, "Connected successfully"
        except Exception as e:
            return False, str(e)

    def list_items(self):
        """
        Workspace inventory used by Harvest. Once a pair of Lakehouses is
        pinned (for S2D), Harvest is scoped down to just those 2 Lakehouses
        too - but Notebooks/Reports/Warehouses/SemanticModels are never
        part of the pinning concept, so they're always shown in full.
        """
        items = self._api_get(f"/workspaces/{self.workspace_id}/items")
        all_items = [
            AssetItem(
                id=i.get("id"),
                name=i.get("displayName"),
                type=i.get("type", "Other"),
                extra={"description": i.get("description", "")},
            )
            for i in items
        ]

        if self.allowed_containers:
            allowed_ids = {c["id"] for c in self.allowed_containers}
            return [i for i in all_items if i.type != "Lakehouse" or i.id in allowed_ids]

        return all_items

    def list_containers(self):
        """
        S2D-facing container list - only the pinned pair of Lakehouses,
        once pinning has been configured via the Connect page. Falls back
        to every Lakehouse in the workspace if nothing's pinned yet.
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
    def get_schema(self, item_id, item_type):
        if item_type != "Lakehouse":
            # Notebooks/Reports/etc have no tabular schema through this connector
            return []

        conn_info = self._resolve_lakehouse_connection(item_id)
        conn = self._get_db_connection(conn_info["server"], conn_info["database"])
        cursor = conn.cursor()

        cursor.execute("""
            SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
            FROM INFORMATION_SCHEMA.TABLES
            ORDER BY TABLE_SCHEMA, TABLE_NAME
        """)
        tables = cursor.fetchall()

        result = []
        for schema, name, kind in tables:
            cursor.execute("""
                SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                ORDER BY ORDINAL_POSITION
            """, (schema, name))
            columns = [
                ColumnInfo(
                    name=c[0], data_type=c[1],
                    nullable=(c[2] == 'YES'), default=c[3],
                ).to_dict()
                for c in cursor.fetchall()
            ]
            result.append({
                "table": f"[{schema}].[{name}]",
                "kind": "VIEW" if kind == "VIEW" else "BASE TABLE",
                "columns": columns,
            })

        cursor.close()
        conn.close()
        return result

    def list_tables_in_container(self, container_id):
        """container_id here is a Lakehouse id."""
        return self.get_schema(container_id, "Lakehouse")

    def run_query(self, container_id, sql):
        """
        Run one read-only SELECT against this Lakehouse's SQL analytics
        endpoint and return the first row as a dict, or None if empty.
        container_id is a Lakehouse id.
        """
        normalized = validate_select_only(sql)

        conn_info = self._resolve_lakehouse_connection(container_id)
        conn = self._get_db_connection(conn_info["server"], conn_info["database"])
        cursor = conn.cursor()
        cursor.execute(normalized)

        row = cursor.fetchone()
        if row is None:
            cursor.close()
            conn.close()
            return None

        columns = [c[0] for c in cursor.description]
        result = dict(zip(columns, row))

        cursor.close()
        conn.close()
        return result