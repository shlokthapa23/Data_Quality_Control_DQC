from .base import BaseConnector, AssetItem, build_row_count_query
from local_files import db as local_db

LOCAL_CONTAINER_ID = "local"


class LocalConnector(BaseConnector):
    """
    Wraps uploaded CSV/Parquet files as a queryable source, using the same
    interface as FabricConnector so S2D mappings can pair a Fabric table
    against a local file (or two local files against each other) without
    any special-casing elsewhere in the app.
    """

    connector_type = "local"

    def __init__(self, connector_id):
        self.connector_id = connector_id

    def test_connection(self):
        # No external dependency to verify - local files are either
        # uploaded or they aren't. Always reachable.
        return True, "Local file store ready"

    def list_items(self):
        # There's no meaningful "workspace inventory" distinct from the
        # uploaded tables themselves, so this mirrors list_containers().
        return [AssetItem(id=LOCAL_CONTAINER_ID, name="Local Files", type="LocalFileSet")]

    def list_containers(self):
        return [{"id": LOCAL_CONTAINER_ID, "name": "Local Files", "type": "LocalFileSet"}]

    def get_schema(self, item_id, item_type):
        if item_type != "LocalFileSet":
            return []
        return self.list_tables_in_container(item_id)

    def list_tables_in_container(self, container_id, include_row_counts=False):
        tables = local_db.list_local_tables(self.connector_id)
        result = []
        for t in tables:
            columns = local_db.get_table_schema(self.connector_id, t["duckdb_table_name"])
            result.append({
                "table": t["duckdb_table_name"],
                "kind": "BASE TABLE",
                "columns": columns,
            })

        if include_row_counts:
            # One query per table, matching the Fabric path. Native DuckDB would
            # tolerate a single unioned query, but keeping one code path means
            # there's no second, subtly-different implementation to get wrong -
            # and see build_row_count_query for why the unioned form was removed.
            # Cheap here regardless: all of these together measured ~0.03s.
            for entry in result:
                entry["row_count"] = None
                try:
                    row = local_db.run_query(
                        self.connector_id, build_row_count_query(entry["table"])
                    )
                    entry["row_count"] = row["row_count"] if row else None
                except Exception as e:
                    print(f"Row count failed for {entry['table']}, showing it without one: {e}")

        return result

    def run_query(self, container_id, sql):
        return local_db.run_query(self.connector_id, sql)

    def run_query_all(self, container_id, sql):
        return local_db.run_query_all(self.connector_id, sql)

    def validate_query(self, container_id, sql):
        return local_db.validate_query(self.connector_id, sql)

    def sample_rows(self, container_id, table, limit=20):
        return local_db.sample_rows(self.connector_id, table, limit)