from datetime import datetime, timezone
from catalog import db


def run_harvest(connector, connector_name, selected_items, mode="incremental"):
    """
    selected_items: list of {"id": ..., "name": ..., "type": ...} - exactly
    the shape the frontend's checkbox tree already sends us.
    mode: "incremental" (upsert) or "full_refresh" (wipe this connector's
    assets of the selected types first, then re-pull only what's selected).
    """
    started_at = datetime.now(timezone.utc).isoformat()

    if mode == "full_refresh":
        types_being_harvested = list({item["type"] for item in selected_items})
        db.full_refresh_clear(connector.connector_type, asset_types=types_being_harvested)

    harvested = []
    errors = []

    for item in selected_items:
        try:
            schema = connector.get_schema(item["id"], item["type"])
            asset_id = db.upsert_asset(
                connector.connector_type, connector_name, item, schema=schema,
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