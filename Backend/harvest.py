from datetime import datetime, timezone
from catalog import db


def run_harvest(connector, connector_id, connector_name, selected_items, mode="incremental"):
    """
    selected_items: list of {"id": ..., "name": ..., "type": ...} - exactly
    the shape the frontend's checkbox tree already sends us.
    mode: "incremental" (upsert in place) or "full_refresh" (drop the stored
    copy of the SELECTED items first, then re-pull them).

    Neither mode touches an asset the tester didn't select. full_refresh used to
    clear every asset of the selected types, so harvesting a second Lakehouse
    deleted the first - asking for one more thing took the previous one away,
    which is never what "harvest this as well" means. Re-harvesting is now
    always additive, and the Catalog and the validation container picker both
    grow as a tester harvests more.

    connector_id scopes both the clear and the upsert to this specific connector
    instance, so a second connector of the same type (e.g. a second Fabric
    workspace) never collides with this one in the catalog.
    """
    started_at = datetime.now(timezone.utc).isoformat()

    if mode == "full_refresh":
        db.clear_assets_by_item_ids(
            connector.connector_type, connector_id,
            [item["id"] for item in selected_items],
        )

    harvested = []
    errors = []

    for item in selected_items:
        try:
            schema = connector.get_schema(item["id"], item["type"])
            asset_id = db.upsert_asset(
                connector_id, connector.connector_type, connector_name, item, schema=schema,
            )
            harvested.append(asset_id)
        except Exception as e:
            errors.append({"item": item["name"], "error": str(e)})

    finished_at = datetime.now(timezone.utc).isoformat()
    status = "failed" if (errors and not harvested) else "success"

    db.record_job(
        connector.connector_type, connector_name, mode,
        asset_count=len(harvested), status=status,
        error_message="; ".join(e["error"] for e in errors) if errors else None,
        started_at=started_at, finished_at=finished_at,
    )

    return {"harvested": harvested, "errors": errors}