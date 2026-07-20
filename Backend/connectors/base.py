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
    def list_tables_in_container(self, container_id):
        """
        Return the queryable tables inside one container, in the same
        shape as get_schema(): [{"table": ..., "kind": ..., "columns": [...]}, ...]
        Powers the S2D mapping form's table dropdown once a container
        (Lakehouse / local file store) has been picked.
        """
        raise NotImplementedError