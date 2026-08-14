from abc import ABC, abstractmethod


class AssetItem:
    """A single discoverable item from a source system (a Lakehouse, a table, etc)."""

    def __init__(self, id, name, type, parent_id=None, extra=None):
        self.id = id
        self.name = name
        self.type = type          # e.g. "Lakehouse", "Table", "Notebook"
        self.parent_id = parent_id
        self.extra = extra or {}  # connector-specific metadata

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "parent_id": self.parent_id,
            **self.extra,
        }


class ColumnInfo:
    def __init__(self, name, data_type, nullable, default=None):
        self.name = name
        self.data_type = data_type
        self.nullable = nullable
        self.default = default

    def to_dict(self):
        return {
            "name": self.name,
            "data_type": self.data_type,
            "nullable": self.nullable,
            "default": self.default,
        }


def build_row_count_query(table):
    """
    COUNT(*) for ONE table.

    ### Do not "optimise" this into a single multi-table query. It was, and it
    ### returned wrong numbers.

    The obvious version is one `UNION ALL` with `COUNT(*)` per arm, so a whole
    container costs one round trip. Measured against a live Fabric Lakehouse,
    that silently produces garbage: for four tables whose true counts are
    [97377, 0, 1000, 883], the unioned query returned [97377, 0, 0, 97377] -
    arms 3 and 4 repeating arms 1 and 2. Two arms were fine; four were not. The
    same corruption happens with several scalar subqueries in one SELECT
    ([883, 1000, 1000, 883]), and with or without a table-name literal, so it's
    DuckDB's mssql extension mis-pushing MULTIPLE AGGREGATES in one statement -
    not anything in this repo.

    Row-level multi-arm unions are unaffected and remain safe: `COUNT(*)` over a
    four-arm `SELECT 1 FROM t` union returned exactly the right total, which is
    why s2d/engine.py's `_build_column_union` is fine as it stands.

    Per-table counting costs nothing meaningful here anyway, because the expense
    on Fabric is opening the connection (~9s), not the query (<1s) - callers run
    these on a connection that is already open.

    The table name is interpolated directly; it comes from the connector's own
    schema introspection, never from user input.
    """
    return f"SELECT COUNT(*) AS row_count FROM {table}"


class BaseConnector(ABC):
    """
    Every source system (Fabric, Local files, ADLS, S3, ...) implements
    this interface. The harvest engine, S2D engine, and catalog only ever
    talk to connectors through these methods - they never know which
    source they're dealing with.
    """

    connector_type = "base"  # override in subclasses, e.g. "fabric"

    @abstractmethod
    def test_connection(self):
        """Return (ok: bool, message: str)."""
        raise NotImplementedError

    @abstractmethod
    def list_items(self):
        """Return a flat list of AssetItem for top-level discoverable objects."""
        raise NotImplementedError

    @abstractmethod
    def get_schema(self, item_id, item_type):
        """
        Return a list of dicts like:
        [{ "table": "...", "kind": "BASE TABLE"|"VIEW", "columns": [...] }, ...]
        Item types with no tabular schema (Notebook, Report) return [].
        """
        raise NotImplementedError

    @abstractmethod
    def run_query(self, container_id, sql):
        """
        Run a single read-only SELECT against a specific container (a
        Lakehouse for Fabric, the local file store for Local) and return
        the first row as a dict (column_name -> value), or None if no rows
        were returned. Used by the S2D validation engine to execute
        test-case scripts. Implementations must reject anything that isn't
        a plain SELECT.
        """
        raise NotImplementedError

    @abstractmethod
    def run_query_all(self, container_id, sql):
        """
        Like run_query(), but returns EVERY matching row (list of dicts)
        instead of just the first. Used by cross_table_parity checks to
        fetch a full key-column result set from each side for an
        application-level (Python set) existence diff - run_query()'s
        one-row contract and sample_rows()'s random-sample contract don't
        fit that need.
        """
        raise NotImplementedError

    # --- Data pipelines (optional capability) -----------------------------
    # Deliberately NOT abstract: orchestration pipelines are a Fabric concept,
    # and forcing every connector to carry a dead override for them would be
    # worse than a documented default. Routes gate on the connector type before
    # calling these, so the NotImplementedError is a backstop, not a path a
    # tester can reach.

    def list_pipelines(self):
        """Return [{"id", "name"}] for this connector's runnable pipelines."""
        raise NotImplementedError(f"{self.connector_type} connectors have no pipelines")

    def run_pipeline(self, item_id):
        """Start a pipeline on demand; return the new run's id."""
        raise NotImplementedError(f"{self.connector_type} connectors have no pipelines")

    def get_pipeline_run(self, item_id, run_id):
        """Return one pipeline run's status."""
        raise NotImplementedError(f"{self.connector_type} connectors have no pipelines")

    def list_pipeline_runs(self, item_id):
        """Return recent pipeline runs, newest first."""
        raise NotImplementedError(f"{self.connector_type} connectors have no pipelines")

    @abstractmethod
    def validate_query(self, container_id, sql):
        """
        Parse and bind a SELECT against this container WITHOUT executing it,
        so the test-case editor can report a real syntax/column/table error
        before the tester saves and runs. Returns (ok, error_message) -
        error_message is None when the query is valid.

        Implementations must apply the same SELECT-only guard run_query() does
        BEFORE handing anything to the database, then EXPLAIN the statement and
        discard the plan. EXPLAIN both parses and binds, so this catches
        misspelled column and table names as well as syntax - which is why the
        real parser is used here rather than a regex.
        """
        raise NotImplementedError

    @abstractmethod
    def sample_rows(self, container_id, table, limit=20):
        """
        Return up to `limit` random rows from `table` (inside the given
        container) as a list of dicts (column_name -> value). Used to feed
        real sample data to the AI rule-suggestion flow, as opposed to
        run_query()'s single-row pass/fail contract.
        """
        raise NotImplementedError

    @abstractmethod
    def list_containers(self):
        """
        Return the containers this connector exposes for S2D mapping
        purposes - e.g. a Fabric connector's pinned pair of Lakehouses, or
        a Local connector's single implicit file store. Deliberately
        separate from list_items(): list_items() is the full, unrestricted
        workspace inventory used by Harvest; list_containers() is the
        (possibly restricted) set of things a mapping's source/destination
        can actually be built from.
        Return shape: [{"id": ..., "name": ..., "type": ...}, ...]
        """
        raise NotImplementedError

    @abstractmethod
    def list_tables_in_container(self, container_id, include_row_counts=False):
        """
        Return the queryable tables inside one container, in the same
        shape as get_schema(): [{"table": ..., "kind": ..., "columns": [...]}, ...]
        Powers the S2D mapping form's table dropdown once a container
        (Lakehouse / local file store) has been picked.

        include_row_counts adds a "row_count" key to every entry so the table
        pickers can show how big each table is before any test case is written.
        It's opt-in because counting costs real time on a remote endpoint, and
        the callers that only need columns (the column map editor, the template
        dropdowns) shouldn't pay for it. A count that fails leaves row_count as
        None - the table listing itself must never break over it.
        """
        raise NotImplementedError