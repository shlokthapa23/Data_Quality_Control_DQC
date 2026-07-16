import json

from connectors.fabric_connector import FabricConnector
from connectors.local_connector import LocalConnector

# Adding a new connector TYPE later means: write connectors/<type>_connector.py
# implementing BaseConnector, then add one line here. Nothing else in the
# app changes.
CONNECTOR_CLASSES = {
    "fabric": FabricConnector,
    "local": LocalConnector,
}


def build_connector(config):
    """config is a dict from catalog.db.get_connector_config()."""
    connector_type = config["type"]
    cls = CONNECTOR_CLASSES.get(connector_type)
    if not cls:
        raise ValueError(f"Unsupported connector type: {connector_type}")

    if connector_type == "fabric":
        allowed_containers = None
        raw = config.get("allowed_containers_json")
        if raw:
            allowed_containers = json.loads(raw)
        return cls(
            tenant_id=config["tenant_id"],
            client_id=config["client_id"],
            client_secret=config["client_secret"],
            workspace_id=config["workspace_id"],
            allowed_containers=allowed_containers,
        )

    if connector_type == "local":
        return cls(connector_id=config["id"])

    raise ValueError(f"No constructor wiring for connector type: {connector_type}")