import os
from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv
from s2d.engine import run_pipeline, run_one, run_suite
from catalog import db as catalog_db
from connector_factory import build_connector
from harvest import run_harvest
from local_files import db as local_db
from s2d import column_map as s2d_column_map
from s2d import db as s2d_db
from s2d.engine import run_pipeline
from ai_service import (
    generate_test_case_sql, generate_rules_from_sample, generate_parity_rules_from_samples,
    generate_key_column_suggestion, generate_key_column_suggestions_from_samples,
)
# Straight from the engine's metric registry, so a request can never be accepted
# for a column_parity metric that has no implementation behind it.
from s2d.engine import PARITY_VALIDATION_TYPES, shares_connection
from connectors.sql_guard import suggest_fix, validate_select_only
import scheduler as _scheduler



load_dotenv()
catalog_db.init_db()
s2d_db.init_s2d_tables()
local_db.init_local_tables_table()

app = Flask(__name__)
CORS(app)


def get_connector_instance(connector_id):
    config = catalog_db.get_connector_config(connector_id)
    if not config:
        raise KeyError(f"Unknown connector: {connector_id}")
    return config, build_connector(config)


@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({"status": "healthy"})


# --- Connect: manage connector instances -----------------------------------

@app.route('/api/connectors', methods=['GET'])
def list_connectors():
    return jsonify(catalog_db.list_connector_configs())


@app.route('/api/connectors', methods=['POST'])
def create_connector():
    """
    Body (Fabric): { "name": "...", "type": "fabric", "tenant_id": "...",
                      "client_id": "...", "client_secret": "...", "workspace_id": "..." }
    Body (Local):  { "name": "...", "type": "local" }
    """
    body = request.get_json(force=True)
    name = body.get("name")
    connector_type = body.get("type")

    if not name or not connector_type:
        return jsonify({"error": "name and type are required"}), 400

    if connector_type == "fabric":
        required = ["tenant_id", "client_id", "client_secret", "workspace_id"]
        missing = [f for f in required if not body.get(f)]
        if missing:
            return jsonify({"error": f"Missing fields for fabric connector: {', '.join(missing)}"}), 400

        config_id = catalog_db.create_connector_config(
            name=name, type=connector_type,
            tenant_id=body["tenant_id"], client_id=body["client_id"],
            client_secret=body["client_secret"], workspace_id=body["workspace_id"],
        )
        return jsonify({"id": config_id}), 201

    if connector_type == "local":
        config_id = catalog_db.create_connector_config(name=name, type="local")
        return jsonify({"id": config_id}), 201

    return jsonify({"error": f"Unsupported connector type: {connector_type}"}), 400


@app.route('/api/connectors/test-draft', methods=['POST'])
def test_connector_draft():
    """
    Test credentials before saving them - same payload shape as POST
    /api/connectors, but nothing gets persisted. Local connectors have
    nothing external to verify, so this just confirms the type is valid.
    """
    body = request.get_json(force=True)
    connector_type = body.get("type")

    if connector_type == "local":
        return jsonify({"ok": True, "message": "Local file store ready"})

    try:
        connector = build_connector({
            "type": connector_type,
            "tenant_id": body.get("tenant_id"),
            "client_id": body.get("client_id"),
            "client_secret": body.get("client_secret"),
            "workspace_id": body.get("workspace_id"),
        })
    except ValueError as e:
        return jsonify({"ok": False, "message": str(e)}), 400

    ok, message = connector.test_connection()
    return jsonify({"ok": ok, "message": message}), (200 if ok else 502)


@app.route('/api/connectors/<connector_id>', methods=['DELETE'])
def delete_connector(connector_id):
    # Deregister and delete this connector's schedules BEFORE dropping it.
    # Previously they were left behind entirely, so a deleted connector kept a
    # live APScheduler job firing forever - erroring on every tick against a
    # connector that no longer existed. Same reasoning as delete_s2d_mapping,
    # which already deregisters its suites' schedules.
    for schedule_id in s2d_db.delete_harvest_schedules_for_connector(connector_id):
        _scheduler.remove_harvest_schedule_job(schedule_id)
    for schedule_id in s2d_db.delete_pipeline_schedules_for_connector(connector_id):
        _scheduler.remove_pipeline_schedule_job(schedule_id)
    catalog_db.delete_connector_config(connector_id)
    return jsonify({"deleted": connector_id})


@app.route('/api/connectors/<connector_id>/test', methods=['POST'])
def test_connector(connector_id):
    try:
        _, connector = get_connector_instance(connector_id)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    ok, message = connector.test_connection()
    return jsonify({"ok": ok, "message": message}), (200 if ok else 502)


HARVEST_VISIBLE_FABRIC_TYPES = {"Lakehouse", "Warehouse", "DataPipeline"}


@app.route('/api/connectors/<connector_id>/items', methods=['GET'])
def get_connector_items(connector_id):
    """Powers the Harvest wizard's checkbox tree. For Fabric connectors, only
    surfaces the item types testers actually validate against (Lakehouse,
    Warehouse, DataPipeline) - Reports/SemanticModels/Notebooks/etc are real
    workspace items but not ones a tester harvests metadata for here. Local
    connectors are untouched (their items aren't Fabric-typed at all)."""
    try:
        config, connector = get_connector_instance(connector_id)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        items = connector.list_items()
        if config.get("type") == "fabric":
            items = [i for i in items if i.type in HARVEST_VISIBLE_FABRIC_TYPES]
        return jsonify({"items": [i.to_dict() for i in items]})
    except Exception as e:
        return jsonify({"error": "Failed to list items", "details": str(e)}), 502
    
@app.route('/api/connectors/<connector_id>/lakehouses', methods=['GET'])
def get_all_lakehouses(connector_id):
    """
    Deliberately unfiltered Lakehouse list - used by the Connect page's
    pinning checkbox UI itself, since list_items() narrows Lakehouses
    down to whatever's already pinned (correct for Harvest, but it would
    make it impossible to ever change your pinning selection if we used
    the same endpoint here).
    """
    try:
        config, connector = get_connector_instance(connector_id)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    if config["type"] != "fabric":
        return jsonify({"error": "Only fabric connectors have Lakehouses"}), 400

    try:
        items = connector.list_all_lakehouses()
        return jsonify({"items": [i.to_dict() for i in items]})
    except Exception as e:
        return jsonify({"error": "Failed to list lakehouses", "details": str(e)}), 502


# --- Data pipelines ---------------------------------------------------------

def _fabric_connector_or_error(connector_id):
    """
    (connector, None) for a Fabric connector, or (None, (response, status)) to
    return. Pipelines are a Fabric-only concept, so every route below refuses
    other connector types up front rather than relying on the base class's
    NotImplementedError.
    """
    config = catalog_db.get_connector_config(connector_id)
    if not config:
        return None, (jsonify({"error": f"Unknown connector: {connector_id}"}), 404)
    if config["type"] != "fabric":
        return None, (jsonify({"error": "Pipelines are only available on fabric connectors"}), 400)
    try:
        _, connector = get_connector_instance(connector_id)
    except KeyError as e:
        return None, (jsonify({"error": str(e)}), 404)
    except ValueError as e:
        return None, (jsonify({"error": str(e)}), 400)
    return connector, None


@app.route('/api/connectors/<connector_id>/pipelines', methods=['GET'])
def list_connector_pipelines(connector_id):
    """The workspace's Data Pipelines - {"pipelines": [{"id", "name"}, ...]}."""
    connector, error = _fabric_connector_or_error(connector_id)
    if error:
        return error

    try:
        return jsonify({"pipelines": connector.list_pipelines()})
    except Exception as e:
        return jsonify({"error": "Failed to list pipelines", "details": str(e)}), 502


@app.route('/api/connectors/<connector_id>/pipelines/<item_id>/run', methods=['POST'])
def run_connector_pipeline(connector_id, item_id):
    """
    Starts the pipeline on demand and returns {"run_id": ...} to poll.

    Note on the error mapping below: listing pipelines and reading their run
    history both work with a plain service-principal token, but STARTING a job
    is a separate Fabric permission. A 401/403 here therefore almost always
    means the SP lacks the run-on-demand right rather than that anything is
    misconfigured, so it says exactly that instead of a bare "failed".
    """
    connector, error = _fabric_connector_or_error(connector_id)
    if error:
        return error

    try:
        run_id = connector.run_pipeline(item_id)
    except Exception as e:
        detail = str(e)
        if "401" in detail or "403" in detail:
            return jsonify({
                "error": "This connector isn't allowed to start pipeline runs. It can list pipelines "
                         "and read their history, so this is specifically the run-on-demand "
                         "permission - the service principal needs at least Contributor on the "
                         "Fabric workspace.",
                "details": detail,
            }), 403
        if "404" in detail:
            return jsonify({
                "error": "That pipeline no longer exists in the workspace - refresh the list.",
                "details": detail,
            }), 404
        return jsonify({"error": "Could not start the pipeline", "details": detail}), 502

    if not run_id:
        return jsonify({
            "error": "The pipeline was started but Fabric didn't report a run id, so its progress "
                     "can't be followed here. Check the run history below in a moment.",
        }), 502
    return jsonify({"run_id": run_id})


@app.route('/api/connectors/<connector_id>/pipelines/<item_id>/runs', methods=['GET'])
def list_connector_pipeline_runs(connector_id, item_id):
    """Recent runs for one pipeline, newest first."""
    connector, error = _fabric_connector_or_error(connector_id)
    if error:
        return error

    try:
        return jsonify({"runs": connector.list_pipeline_runs(item_id)})
    except Exception as e:
        return jsonify({"error": "Failed to read pipeline run history", "details": str(e)}), 502


@app.route('/api/connectors/<connector_id>/pipelines/<item_id>/runs/<run_id>', methods=['GET'])
def get_connector_pipeline_run(connector_id, item_id, run_id):
    """One run's current status - polled by the Pipelines tab while it's live."""
    connector, error = _fabric_connector_or_error(connector_id)
    if error:
        return error

    try:
        return jsonify(connector.get_pipeline_run(item_id, run_id))
    except Exception as e:
        return jsonify({"error": "Failed to read the pipeline run", "details": str(e)}), 502


@app.route('/api/connectors/<connector_id>/pin-containers', methods=['POST'])
def pin_connector_containers(connector_id):
    """
    Body: { "containers": [{"id": "...", "name": "..."}, ...] }
    Restricts a Fabric connector's S2D-visible (and Harvest-visible)
    Lakehouses to this set - every other Lakehouse in the workspace stops
    showing up in S2D mapping dropdowns and in Harvest's checkbox tree.
    Notebooks/Reports/Warehouses/SemanticModels are never part of this
    restriction and always show in full. Doesn't apply to (and isn't
    needed for) Local connectors, which have only one implicit container.
    """
    config = catalog_db.get_connector_config(connector_id)
    if not config:
        return jsonify({"error": "Unknown connector"}), 404
    if config["type"] != "fabric":
        return jsonify({"error": "Pinning containers only applies to fabric connectors"}), 400

    body = request.get_json(force=True)
    containers = body.get("containers", [])
    if not containers:
        return jsonify({"error": "Select at least one Lakehouse to pin"}), 400

    catalog_db.update_connector_containers(connector_id, containers)
    return jsonify({"pinned": containers})

@app.route('/api/connectors/<connector_id>/containers', methods=['GET'])
def get_connector_containers(connector_id):
    """
    S2D-facing container list - a Fabric connector's pinned pair of
    Lakehouses (or every Lakehouse if not pinned yet), or a Local
    connector's single implicit file store.
    """
    try:
        _, connector = get_connector_instance(connector_id)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        return jsonify({"containers": connector.list_containers()})
    except Exception as e:
        return jsonify({"error": "Failed to list containers", "details": str(e)}), 502


@app.route('/api/connectors/<connector_id>/containers/<container_id>/tables', methods=['GET'])
def get_container_tables_live(connector_id, container_id):
    """
    Live table list for one container - powers the S2D mapping form's
    table dropdown. Works identically for a Fabric Lakehouse or a Local
    file store, since both implement list_tables_in_container().

    ?include_row_counts=1 adds "row_count" to each table so the pickers can show
    how big it is before any test case exists. Opt-in: counting costs real time
    against a remote endpoint, and callers that only want columns shouldn't pay
    for it. Omitting the flag returns exactly the original shape.
    """
    include_row_counts = request.args.get("include_row_counts") in ("1", "true", "yes")

    try:
        _, connector = get_connector_instance(connector_id)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        schema = connector.list_tables_in_container(container_id, include_row_counts=include_row_counts)
        tables = []
        for t in schema:
            entry = {"name": t["table"], "kind": t["kind"], "columns": t["columns"]}
            if include_row_counts:
                entry["row_count"] = t.get("row_count")
            tables.append(entry)
        return jsonify({"tables": tables})
    except Exception as e:
        return jsonify({"error": "Failed to list tables", "details": str(e)}), 502


# --- Local connector: file upload -------------------------------------------

@app.route('/api/connectors/<connector_id>/local/upload', methods=['POST'])
def upload_local_file(connector_id):
    """
    Multipart form upload. Fields: 'file' (any of local_db.SUPPORTED_EXTENSIONS),
    optional 'display_name', optional 'xml_record_element' to override which
    repeating element XML rows are taken from. Ingests into DuckDB as a real
    table immediately, so the file is queryable with the same SQL as everything
    else regardless of the format it arrived in.
    """
    config = catalog_db.get_connector_config(connector_id)
    if not config:
        return jsonify({"error": "Unknown connector"}), 404
    if config["type"] != "local":
        return jsonify({"error": "This connector isn't a Local connector"}), 400

    if 'file' not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file_storage = request.files['file']
    display_name = request.form.get('display_name')
    xml_record_element = request.form.get('xml_record_element') or None

    try:
        row = local_db.ingest_file(
            connector_id, file_storage,
            display_name=display_name, xml_record_element=xml_record_element)
        return jsonify(row), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        # A malformed file is the tester's problem to fix, so give them the
        # parser's own words rather than a generic failure.
        return jsonify({"error": "Couldn't read that file", "details": str(e)}), 400


@app.route('/api/connectors/<connector_id>/local/tables/<table_id>/reingest', methods=['POST'])
def reingest_local_table(connector_id, table_id):
    """
    Body: { "xml_record_element": "..." }. Rebuilds an XML table from a
    different repeating element when the auto-detected one was wrong - the raw
    upload is still on disk, so this costs no re-upload.
    """
    config = catalog_db.get_connector_config(connector_id)
    if not config:
        return jsonify({"error": "Unknown connector"}), 404
    if config["type"] != "local":
        return jsonify({"error": "This connector isn't a Local connector"}), 400

    body = request.get_json(force=True) or {}
    element = (body.get("xml_record_element") or "").strip()
    if not element:
        return jsonify({"error": "xml_record_element is required"}), 400

    try:
        return jsonify(local_db.reingest_xml(connector_id, table_id, element))
    except KeyError:
        return jsonify({"error": "Unknown table"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": "Couldn't re-read that file", "details": str(e)}), 400


@app.route('/api/connectors/<connector_id>/local/tables', methods=['GET'])
def list_local_files(connector_id):
    """
    Management listing for the Connect page's upload panel - includes the
    upload's own id (needed to delete it), unlike the generic
    containers/<id>/tables endpoint used by the S2D mapping form, which
    only needs the queryable name.
    """
    config = catalog_db.get_connector_config(connector_id)
    if not config:
        return jsonify({"error": "Unknown connector"}), 404
    if config["type"] != "local":
        return jsonify({"error": "This connector isn't a Local connector"}), 400

    return jsonify({"tables": local_db.list_local_tables(connector_id)})


@app.route('/api/connectors/<connector_id>/local/tables/<table_id>', methods=['DELETE'])
def delete_local_file(connector_id, table_id):
    local_db.delete_local_table(connector_id, table_id)
    return jsonify({"deleted": table_id})


# --- Harvest -----------------------------------------------------------

@app.route('/api/harvest', methods=['POST'])
def harvest_route():
    """
    Body: { "connector_id": "...", "mode": "incremental"|"full_refresh",
            "items": [{"id":..., "name":..., "type":...}, ...] }
    """
    body = request.get_json(force=True)
    connector_id = body.get("connector_id")
    mode = body.get("mode", "incremental")
    items = body.get("items", [])

    if not items:
        return jsonify({"error": "No items selected"}), 400

    try:
        config, connector = get_connector_instance(connector_id)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    result = run_harvest(connector, connector_id, config["name"], items, mode=mode)
    return jsonify(result)


# --- Catalog -----------------------------------------------------------

@app.route('/api/catalog', methods=['GET'])
def get_catalog():
    connector_id = request.args.get('connector_id')
    connector_type = request.args.get('connector_type')
    asset_type = request.args.get('type')
    search = request.args.get('search')
    assets = catalog_db.list_assets(connector_id=connector_id, connector_type=connector_type, asset_type=asset_type, search=search)
    return jsonify({"assets": assets})


@app.route('/api/catalog/<path:asset_id>', methods=['GET'])
def get_catalog_asset(asset_id):
    asset = catalog_db.get_asset(asset_id)
    if not asset:
        return jsonify({"error": "Asset not found"}), 404
    return jsonify(asset)


# --- S2D: Source-to-Destination validation ---------------------------------

@app.route('/api/s2d/mappings', methods=['GET'])
def list_s2d_mappings():
    return jsonify(s2d_db.list_mappings())


@app.route('/api/s2d/mappings', methods=['POST'])
def create_s2d_mapping():
    """
    Body: {
      "name": "...",
      "source_connector_id": "...", "source_connector_name": "...",
      "source_container_id": "...", "source_container_name": "...", "source_tables": ["...", "..."],
      "destination_connector_id": "...", "destination_connector_name": "...",
      "destination_container_id": "...", "destination_container_name": "...", "destination_tables": ["...", "..."]
    }
    Source and destination are fully independent - same connector+container
    (classic single-Lakehouse bronze/silver case), same connector+different
    container (the pinned-pair case), or different connectors entirely
    (Fabric <-> Local, Local <-> Local). Each side can hold multiple tables.
    """
    body = request.get_json(force=True)
    required = [
        "name",
        "source_connector_id", "source_connector_name", "source_container_id", "source_container_name", "source_tables",
        "destination_connector_id", "destination_connector_name", "destination_container_id", "destination_container_name", "destination_tables",
    ]
    missing = [f for f in required if not body.get(f)]
    if missing:
        return jsonify({"error": f"Missing fields: {', '.join(missing)}"}), 400

    source_tables = body["source_tables"]
    destination_tables = body["destination_tables"]
    if not isinstance(source_tables, list) or not isinstance(destination_tables, list):
        return jsonify({"error": "source_tables and destination_tables must be arrays"}), 400
    if not source_tables or not destination_tables:
        return jsonify({"error": "Select at least one table on each side"}), 400

    if (body["source_connector_id"] == body["destination_connector_id"]
            and body["source_container_id"] == body["destination_container_id"]
            and set(source_tables) == set(destination_tables)):
        return jsonify({"error": "Source and destination can't be the exact same set of tables"}), 400

    mapping_id = s2d_db.create_mapping(
        name=body["name"],
        source_connector_id=body["source_connector_id"], source_connector_name=body["source_connector_name"],
        source_container_id=body["source_container_id"], source_container_name=body["source_container_name"],
        source_tables=source_tables,
        destination_connector_id=body["destination_connector_id"], destination_connector_name=body["destination_connector_name"],
        destination_container_id=body["destination_container_id"], destination_container_name=body["destination_container_name"],
        destination_tables=destination_tables,
    )
    return jsonify({"id": mapping_id}), 201


@app.route('/api/s2d/mappings/<mapping_id>', methods=['PATCH'])
def rename_s2d_mapping(mapping_id):
    if not s2d_db.get_mapping(mapping_id):
        return jsonify({"error": "Mapping not found"}), 404
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    s2d_db.rename_mapping(mapping_id, name)
    return jsonify(s2d_db.get_mapping(mapping_id))


@app.route('/api/s2d/mappings/<mapping_id>/column-map', methods=['PUT'])
def set_s2d_column_map(mapping_id):
    """
    Body: { "column_map": [ { "name": "order_id",
                              "source": {"<table>": "<column>", ...},
                              "destination": {"<table>": "<column>", ...} }, ... ] }

    Full replace, same as suite membership - the editor always submits the
    whole map. Entirely opt-in: an empty array clears it and puts every test
    case in this validation back on plain literal column names.

    Deliberately does NOT verify the columns still exist - that would mean a
    live connector round-trip on every save, and the editor already builds its
    dropdowns from live schema. A column renamed upstream afterwards surfaces
    as a query error on the next run.
    """
    mapping = s2d_db.get_mapping(mapping_id)
    if not mapping:
        return jsonify({"error": "Mapping not found"}), 404

    body = request.get_json(force=True) or {}
    error, cleaned = s2d_column_map.prepare(
        body.get("column_map") or [], mapping["source_tables"], mapping["destination_tables"]
    )
    if error:
        return jsonify({"error": error}), 400

    s2d_db.set_column_map(mapping_id, cleaned)
    return jsonify(s2d_db.get_mapping(mapping_id))


@app.route('/api/s2d/mappings/<mapping_id>/validate-sql', methods=['POST'])
def validate_s2d_sql(mapping_id):
    """
    Body: { "target": "source"|"destination", "sql": "SELECT ..." }

    Parses and binds the script against that side's real connector WITHOUT
    executing it, so the editor can report a genuine syntax/column/table error
    before the tester saves and runs. Writes nothing.

    Returns 200 for BOTH outcomes - {"ok": true} or {"ok": false, "error": ...} -
    because a syntax error is a successful validation result, not a failed
    request. Non-2xx stays reserved for "we couldn't run the check at all"
    (unknown connector, Lakehouse unreachable).
    """
    mapping = s2d_db.get_mapping(mapping_id)
    if not mapping:
        return jsonify({"error": "Mapping not found"}), 404

    body = request.get_json(force=True) or {}
    target = body.get("target")
    sql = (body.get("sql") or "").strip()
    if target not in ("source", "destination"):
        return jsonify({"error": "target must be 'source' or 'destination'"}), 400
    if not sql:
        return jsonify({"error": "sql is required"}), 400

    connector_id = mapping[f"{target}_connector_id"]
    container_id = mapping[f"{target}_container_id"]
    try:
        _, connector = get_connector_instance(connector_id)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        ok, error = connector.validate_query(container_id, sql)
    except Exception as e:
        return jsonify({"error": "Could not check the query", "details": str(e)}), 502

    # The database says what's wrong; the hint says what to change. Derived from
    # the error text and the script alone, so it costs no extra queries.
    return jsonify({"ok": ok, "error": error, "hint": None if ok else suggest_fix(sql, error)})


@app.route('/api/s2d/mappings/<mapping_id>', methods=['DELETE'])
def delete_s2d_mapping(mapping_id):
    # Deregister any live APScheduler jobs for this mapping's suites BEFORE
    # the cascade delete removes the rows they point to - otherwise the job
    # stays scheduled in memory and fires forever against a suite that can
    # never be found again (s2d_db.delete_mapping can't do this itself:
    # scheduler.py already imports s2d.db, so the reverse import would be
    # circular).
    for suite in s2d_db.list_suites(mapping_id=mapping_id):
        for schedule in s2d_db.list_suite_schedules(suite_id=suite["id"]):
            _scheduler.remove_suite_schedule_job(schedule["id"])
    s2d_db.delete_mapping(mapping_id)
    return jsonify({"deleted": mapping_id})


@app.route('/api/s2d/mappings/<mapping_id>/test-cases', methods=['GET'])
def list_s2d_test_cases(mapping_id):
    return jsonify(s2d_db.list_test_cases(mapping_id))


@app.route('/api/s2d/mappings/<mapping_id>/test-cases', methods=['POST'])
def create_s2d_test_case(mapping_id):
    """
    Body (sql check):  { "name": "...", "validation_type": "...", "check_type": "sql",
                          "target": "source"|"destination", "target_table": "..." (optional, for display),
                          "script_type": "sql"|"pyspark", "script_text": "..." }
    Body (built-in):   { "name": "...", "validation_type": "...", "check_type": "row_count_match",
                          "row_count_source_tables": ["..."], "row_count_destination_tables": ["..."] }
    Body (parity):     { "name": "...", "validation_type": "Null Value Constraint"|"Uniqueness Constraint"|"Boundary Range Constraint",
                          "check_type": "column_parity",
                          "source_tables": ["..."], "source_column": "...",
                          "destination_tables": ["..."], "destination_column": "..." }
    Body (cross-table parity): { "name": "...", "validation_type": "...", "check_type": "sql",
                          "check_scope": "cross_table_parity", "key_column": "...",
                          "source_target_tables": ["..."], "destination_target_tables": ["..."] }
    Body (dual script):{ "name": "...", "validation_type": "...", "check_type": "sql",
                          "check_scope": "dual_script", "script_type": "sql",
                          "script_text": "<source script>", "destination_script_text": "<destination script>" }
      Each script returns one row with a 'value' column, which the engine compares
      for equality - the only way to check both sides at once when they live on
      different connections. See s2d/engine.py's _run_dual_script_check.
    """
    mapping = s2d_db.get_mapping(mapping_id)
    if not mapping:
        return jsonify({"error": "Mapping not found"}), 404

    body = request.get_json(force=True)
    error = _validate_test_case_body(body, mapping)
    if error:
        return jsonify({"error": error}), 400

    target_tables = body.get("target_tables") or ([body["target_table"]] if body.get("target_table") else None)

    test_case_id = s2d_db.create_test_case(
        mapping_id=mapping_id, name=body["name"], validation_type=body["validation_type"],
        check_type=body["check_type"], target=body.get("target"), target_table=body.get("target_table"),
        script_type=body.get("script_type"), script_text=body.get("script_text"),
        destination_script_text=body.get("destination_script_text"),
        row_count_source_tables=body.get("row_count_source_tables"),
        row_count_destination_tables=body.get("row_count_destination_tables"),
        source_tables=body.get("source_tables"), source_column=body.get("source_column"),
        destination_tables=body.get("destination_tables"), destination_column=body.get("destination_column"),
        target_tables=target_tables, check_scope=body.get("check_scope"), key_column=body.get("key_column"),
        source_target_tables=body.get("source_target_tables"),
        destination_target_tables=body.get("destination_target_tables"),
        parity_config=body.get("parity_config"),
        severity=body.get("severity", "error"), description=body.get("description"),
    )
    return jsonify({"id": test_case_id}), 201


def _validate_test_case_body(body, mapping):
    """Shared validation for create and update. Returns an error string, or None if valid."""
    required = ["name", "validation_type", "check_type"]
    missing = [f for f in required if not body.get(f)]
    if missing:
        return f"Missing fields: {', '.join(missing)}"

    check_type = body["check_type"]
    if check_type not in ("sql", "row_count_match", "column_parity"):
        return "check_type must be 'sql', 'row_count_match', or 'column_parity'"

    if check_type == "sql":
        check_scope = body.get("check_scope") or "single_side"
        if check_scope not in ("single_side", "cross_table_parity", "dual_script"):
            return "check_scope must be 'single_side', 'cross_table_parity', or 'dual_script' for sql checks"

        if check_scope == "dual_script":
            if body.get("script_type") not in ("sql", "pyspark"):
                return "script_type must be 'sql' or 'pyspark'"
            if not body.get("script_text"):
                return "script_text (the source script) is required for dual_script checks"
            if not body.get("destination_script_text"):
                return "destination_script_text is required for dual_script checks"

        if check_scope == "single_side":
            target = body.get("target")
            script_type = body.get("script_type")
            script_text = body.get("script_text")
            if target not in ("source", "destination"):
                return "target must be 'source' or 'destination' for single_side sql checks"
            if script_type not in ("sql", "pyspark"):
                return "script_type must be 'sql' or 'pyspark'"
            if not script_text:
                return "script_text is required for single_side sql checks"
            # Fallback for any caller still sending only the legacy singular
            # target_table - derive target_tables server-side rather than
            # hard-breaking on it.
            target_tables = body.get("target_tables") or ([body["target_table"]] if body.get("target_table") else None)
            if not target_tables:
                return "target_tables is required for single_side sql checks"
            # When both sides sit on the same connector AND container there is
            # only one connection, so a single script can legitimately join
            # source and destination tables together - allow it to declare
            # tables from either side. Across different connections that's
            # physically impossible, so the original one-side rule stands.
            valid_tables = mapping["source_tables"] if target == "source" else mapping["destination_tables"]
            if shares_connection(mapping):
                valid_tables = list(mapping["source_tables"]) + list(mapping["destination_tables"])
            if not set(target_tables).issubset(set(valid_tables)):
                return (f"target_tables must be a subset of the mapping's {target} tables"
                        if not shares_connection(mapping)
                        else "target_tables must be a subset of this validation's source or destination tables")

        if check_scope == "cross_table_parity":
            key_column = body.get("key_column")
            source_target_tables = body.get("source_target_tables")
            destination_target_tables = body.get("destination_target_tables")
            if not key_column:
                return "key_column is required for cross_table_parity checks"
            if not source_target_tables or not destination_target_tables:
                return "source_target_tables and destination_target_tables are required for cross_table_parity checks"
            if not set(source_target_tables).issubset(set(mapping["source_tables"])):
                return "source_target_tables must be a subset of the mapping's source tables"
            if not set(destination_target_tables).issubset(set(mapping["destination_tables"])):
                return "destination_target_tables must be a subset of the mapping's destination tables"

    if check_type == "row_count_match":
        rc_source = body.get("row_count_source_tables")
        rc_dest = body.get("row_count_destination_tables")
        if not rc_source or not rc_dest:
            return "row_count_source_tables and row_count_destination_tables are required for row_count_match checks"
        if not set(rc_source).issubset(set(mapping["source_tables"])):
            return "row_count_source_tables must be a subset of the mapping's source tables"
        if not set(rc_dest).issubset(set(mapping["destination_tables"])):
            return "row_count_destination_tables must be a subset of the mapping's destination tables"

    if check_type == "column_parity":
        # Validated against the engine's own metric registry (s2d/engine.py's
        # PARITY_METRICS) rather than a list duplicated here - a hardcoded copy
        # had already drifted once and would silently reject the very metrics
        # the UI offers.
        validation_type = body["validation_type"]
        if validation_type not in PARITY_VALIDATION_TYPES:
            return f"column_parity checks only support: {', '.join(PARITY_VALIDATION_TYPES)}"
        if validation_type == "Regex Pattern Check" and not (body.get("parity_config") or {}).get("pattern"):
            return "Regex Pattern Check needs parity_config.pattern"
        source_tables = body.get("source_tables")
        source_column = body.get("source_column")
        destination_tables = body.get("destination_tables")
        destination_column = body.get("destination_column")
        if not source_tables or not source_column or not destination_tables or not destination_column:
            return "source_tables, source_column, destination_tables, and destination_column are all required for column_parity checks"
        if not set(source_tables).issubset(set(mapping["source_tables"])):
            return "source_tables must be a subset of the mapping's source tables"
        if not set(destination_tables).issubset(set(mapping["destination_tables"])):
            return "destination_tables must be a subset of the mapping's destination tables"

    return None


@app.route('/api/s2d/test-cases/<test_case_id>', methods=['PUT'])
def update_s2d_test_case(test_case_id):
    existing = s2d_db.get_test_case(test_case_id)
    if not existing:
        return jsonify({"error": "Test case not found"}), 404

    mapping = s2d_db.get_mapping(existing["mapping_id"])
    if not mapping:
        return jsonify({"error": "Mapping not found"}), 404

    body = request.get_json(force=True)
    error = _validate_test_case_body(body, mapping)
    if error:
        return jsonify({"error": error}), 400

    target_tables = body.get("target_tables") or ([body["target_table"]] if body.get("target_table") else None)

    s2d_db.update_test_case(
        test_case_id, name=body["name"], validation_type=body["validation_type"],
        check_type=body["check_type"], target=body.get("target"), target_table=body.get("target_table"),
        script_type=body.get("script_type"), script_text=body.get("script_text"),
        destination_script_text=body.get("destination_script_text"),
        row_count_source_tables=body.get("row_count_source_tables"),
        row_count_destination_tables=body.get("row_count_destination_tables"),
        source_tables=body.get("source_tables"), source_column=body.get("source_column"),
        destination_tables=body.get("destination_tables"), destination_column=body.get("destination_column"),
        target_tables=target_tables, check_scope=body.get("check_scope"), key_column=body.get("key_column"),
        source_target_tables=body.get("source_target_tables"),
        destination_target_tables=body.get("destination_target_tables"),
        parity_config=body.get("parity_config"),
        severity=body.get("severity"), description=body.get("description"),
    )
    return jsonify({"updated": test_case_id})


@app.route('/api/s2d/test-cases/<test_case_id>', methods=['DELETE'])
def delete_s2d_test_case(test_case_id):
    s2d_db.delete_test_case(test_case_id)
    return jsonify({"deleted": test_case_id})


@app.route('/api/s2d/test-cases/<test_case_id>/active', methods=['PATCH'])
def set_s2d_test_case_active(test_case_id):
    """Body: { "active": true|false } - powers the rule-list's Active toggle."""
    existing = s2d_db.get_test_case(test_case_id)
    if not existing:
        return jsonify({"error": "Test case not found"}), 404

    body = request.get_json(force=True)
    if "active" not in body:
        return jsonify({"error": "active is required"}), 400

    active = bool(body["active"])
    s2d_db.set_test_case_active(test_case_id, active)
    return jsonify({"updated": test_case_id, "active": active})


@app.route('/api/s2d/test-cases/<test_case_id>/run', methods=['POST'])
def run_single_s2d_test_case(test_case_id):
    """Runs exactly one test case (still recorded as a normal run, total_checkpoints=1)."""
    test_case = s2d_db.get_test_case(test_case_id)
    if not test_case:
        return jsonify({"error": "Test case not found"}), 404

    mapping = s2d_db.get_mapping(test_case["mapping_id"])
    if not mapping:
        return jsonify({"error": "Mapping not found"}), 404

    try:
        _, source_connector = get_connector_instance(mapping["source_connector_id"])
        _, destination_connector = get_connector_instance(mapping["destination_connector_id"])
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    run_id = run_one(source_connector, destination_connector, mapping, test_case)
    return jsonify({"run_id": run_id})

  # --- Genrative Ai test case route --- #

@app.route('/api/s2d/ai/generate-test-case', methods=['POST'])
def ai_generate_test_case():
    """
    Body (single_side, default): { "check_scope": "single_side" (optional),
            "tables": [{"table_name":..., "columns":[...]}, ...], "description": "..." }
      Legacy shape still accepted: { "table_name": "...", "columns": [...], "description": "..." }
      (wrapped into a 1-element tables list server-side, so old callers don't break).

    Body (cross_table_parity): { "check_scope": "cross_table_parity",
            "source_tables": [{"table_name":..., "columns":[...]}, ...],
            "destination_tables": [{"table_name":..., "columns":[...]}, ...], "description": "...",
            "mapping_id": "..." (optional) }

    mapping_id is optional and only used to load that validation's column map,
    so a common name covering every selected table counts as a valid key even
    when no single physical column name is shared across them. Omitting it
    just means literal-name matching, exactly as before.

    The real table name(s) and real column list(s) are supplied by the
    frontend (pulled from the same live schema the table dropdowns already
    use) - the model never has to guess anything about the schema.
    single_side returns {"sql": ...}, still checked against the same
    SELECT-only safety guard every other test case's SQL passes through.
    cross_table_parity has no SQL to generate/validate - that check is
    engine-computed (s2d/engine.py's _run_cross_table_parity_check), so
    this returns {"key_column": ..., "name": ...} instead, after confirming
    the suggested key_column actually exists in every selected table on
    both sides.
    """
    body = request.get_json(force=True)
    check_scope = body.get("check_scope") or "single_side"
    description = body.get("description")

    if not description:
        return jsonify({"error": "description is required"}), 400

    if check_scope == "cross_table_parity":
        source_tables = body.get("source_tables")
        destination_tables = body.get("destination_tables")
        if not source_tables or not destination_tables:
            return jsonify({"error": "source_tables and destination_tables are required for cross_table_parity"}), 400

        mapping = s2d_db.get_mapping(body["mapping_id"]) if body.get("mapping_id") else None

        try:
            suggestion = generate_key_column_suggestion(
                source_tables, destination_tables, description,
                column_map_text=s2d_column_map.describe(mapping),
            )
        except Exception as e:
            print(f"AI key column suggestion error: {e}")
            return jsonify({"error": "AI generation failed", "details": str(e)}), 502

        key_column = suggestion.get("key_column")
        # A key is valid if it's a physical column present on every selected
        # table (the original rule) OR a common name from the validation's
        # column map that covers every selected table on that side.
        source_column_names = set.intersection(*({c["name"] for c in t["columns"]} for t in source_tables))
        destination_column_names = set.intersection(*({c["name"] for c in t["columns"]} for t in destination_tables))
        source_column_names |= set(s2d_column_map.common_names(
            mapping, "source", [t["table_name"] for t in source_tables]))
        destination_column_names |= set(s2d_column_map.common_names(
            mapping, "destination", [t["table_name"] for t in destination_tables]))
        if key_column not in source_column_names or key_column not in destination_column_names:
            return jsonify({
                "error": f"AI suggested key_column '{key_column}', which isn't common to every selected table on both sides - pick one manually",
            }), 422

        return jsonify({"key_column": key_column, "name": suggestion.get("name")})

    tables = body.get("tables")
    if not tables:
        table_name = body.get("table_name")
        columns = body.get("columns")
        if table_name and columns:
            tables = [{"table_name": table_name, "columns": columns}]

    if not tables:
        return jsonify({"error": "tables (or legacy table_name/columns) is required"}), 400

    try:
        sql = generate_test_case_sql(tables, description)
    except Exception as e:
        print(f"AI generation error: {e}")
        return jsonify({"error": "AI generation failed", "details": str(e)}), 502

    try:
        validate_select_only(sql)
    except ValueError as e:
        return jsonify({
            "error": f"The generated SQL failed the safety check ({e}) - try rephrasing the description",
            "generated_sql": sql,
        }), 422

    return jsonify({"sql": sql})


@app.route('/api/s2d/mappings/<mapping_id>/ai/suggest-rules', methods=['POST'])
def ai_suggest_rules(mapping_id):
    """
    Body: { "target": "source"|"destination", "table_name": "..." }

    No user-typed description involved: a random sample of the table's
    actual rows is pulled straight from the connector and handed to the
    AI, which infers several rules on its own. Each surviving rule (after
    the same SELECT-only safety check every other test case's SQL goes
    through) is saved immediately as an 'ai'-origin test case - no manual
    "Add Test Case" step required.
    """
    mapping = s2d_db.get_mapping(mapping_id)
    if not mapping:
        return jsonify({"error": "Mapping not found"}), 404

    body = request.get_json(force=True)
    target = body.get("target")
    table_name = body.get("table_name")
    if target not in ("source", "destination"):
        return jsonify({"error": "target must be 'source' or 'destination'"}), 400
    if not table_name:
        return jsonify({"error": "table_name is required"}), 400

    connector_id = mapping["source_connector_id"] if target == "source" else mapping["destination_connector_id"]
    container_id = mapping["source_container_id"] if target == "source" else mapping["destination_container_id"]

    try:
        _, connector = get_connector_instance(connector_id)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    # Raw SQL is too fuzzy to compare token-for-token across repeat AI
    # calls, so existing rule NAMES for this exact target+table are the
    # practical dedup key here - the AI tends to reuse the same short name
    # when it reconverges on the same idea (low temperature + same sample).
    existing_names = {
        tc["name"].strip().lower()
        for tc in s2d_db.list_test_cases(mapping_id)
        if tc["check_type"] == "sql" and tc.get("check_scope") == "single_side"
        and tc.get("target") == target and (tc.get("target_tables") or [tc.get("target_table")]) == [table_name]
    }
    already_covered_text = "\n".join(f"- {n}" for n in sorted(existing_names)) if existing_names else ""

    try:
        schema = connector.list_tables_in_container(container_id)
        table_entry = next((t for t in schema if t["table"] == table_name), None)
        if not table_entry:
            return jsonify({"error": f"Table '{table_name}' not found in this container"}), 404

        sample = connector.sample_rows(container_id, table_name, limit=20)
        rules = generate_rules_from_sample(table_name, table_entry["columns"], sample, already_covered_text=already_covered_text)
    except Exception as e:
        print(f"AI rule suggestion error: {e}")
        return jsonify({"error": "AI rule suggestion failed", "details": str(e)}), 502

    created = []
    skipped = []
    for rule in rules:
        name = rule.get("name", "unnamed")
        script_text = rule.get("script_text", "")

        if name.strip().lower() in existing_names:
            skipped.append({"name": name, "reason": "Duplicate of an existing rule"})
            continue
        try:
            validate_select_only(script_text)
        except ValueError as e:
            skipped.append({"name": name, "reason": str(e)})
            continue

        test_case_id = s2d_db.create_test_case(
            mapping_id=mapping_id, name=rule.get("name", "Untitled rule"),
            validation_type=rule.get("validation_type", "Custom"), check_type="sql",
            target=target, target_table=table_name, target_tables=[table_name],
            check_scope="single_side", script_type="sql", script_text=script_text,
            origin="ai", severity=rule.get("severity", "error"), description=rule.get("description"),
        )
        created.append(s2d_db.get_test_case(test_case_id))
        existing_names.add(name.strip().lower())  # guard against the AI proposing the same name twice in one batch

    response = {"created": created, "skipped": skipped}
    if not created and rules:
        response["message"] = "The AI didn't find anything new to suggest — every rule it proposed already exists. Try a different table, or add one manually."
    return jsonify(response)


@app.route('/api/s2d/mappings/<mapping_id>/ai/suggest-parity-rules', methods=['POST'])
def ai_suggest_parity_rules(mapping_id):
    """
    Body: { "source_tables": ["..."], "destination_tables": ["..."] }

    The actual point of S2D validation: reads a random sample from the
    FIRST table on each side (multiple tables per side are assumed
    similarly-shaped, same assumption row_count_match already makes), hands
    both samples to the AI, and lets it find corresponding column pairs to
    run column_parity checks on (null/uniqueness/range compared across the
    two sides) - proving data reached the destination intact, not just
    checking one side alone. Every surviving suggestion is validated
    against EVERY selected table's schema on its side (not just the
    first) and saved immediately as an 'ai'-origin column_parity test
    case spanning the full table lists, no manual save step.
    """
    mapping = s2d_db.get_mapping(mapping_id)
    if not mapping:
        return jsonify({"error": "Mapping not found"}), 404

    body = request.get_json(force=True)
    source_tables = body.get("source_tables")
    destination_tables = body.get("destination_tables")
    if not source_tables or not destination_tables:
        return jsonify({"error": "source_tables and destination_tables are required"}), 400

    try:
        _, source_connector = get_connector_instance(mapping["source_connector_id"])
        _, destination_connector = get_connector_instance(mapping["destination_connector_id"])
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        source_schema = source_connector.list_tables_in_container(mapping["source_container_id"])
        source_entries = {t["table"]: t for t in source_schema if t["table"] in source_tables}
        missing_source = set(source_tables) - source_entries.keys()
        if missing_source:
            return jsonify({"error": f"Source table(s) not found: {', '.join(missing_source)}"}), 404

        destination_schema = destination_connector.list_tables_in_container(mapping["destination_container_id"])
        destination_entries = {t["table"]: t for t in destination_schema if t["table"] in destination_tables}
        missing_destination = set(destination_tables) - destination_entries.keys()
        if missing_destination:
            return jsonify({"error": f"Destination table(s) not found: {', '.join(missing_destination)}"}), 404

        first_source_table, first_destination_table = source_tables[0], destination_tables[0]
        source_sample = source_connector.sample_rows(mapping["source_container_id"], first_source_table, limit=20)
        destination_sample = destination_connector.sample_rows(mapping["destination_container_id"], first_destination_table, limit=20)

        # Signature = (source tables, source column, destination tables,
        # destination column, validation type) for every existing
        # column_parity rule - this is what actually guarantees no
        # duplicates get saved, independent of whether the AI cooperates
        # with the prompt-level nudge below.
        existing_signatures = {
            (
                tuple(sorted(tc.get("source_tables") or [])), tc.get("source_column"),
                tuple(sorted(tc.get("destination_tables") or [])), tc.get("destination_column"),
                tc.get("validation_type"),
                # The pattern is part of the identity: two Regex Pattern Checks
                # on the same column pair with different patterns are different
                # rules, not duplicates.
                (tc.get("parity_config") or {}).get("pattern"),
            )
            for tc in s2d_db.list_test_cases(mapping_id)
            if tc["check_type"] == "column_parity"
        }
        already_covered_text = "\n".join(
            f"- {sig[1]} (source) <-> {sig[3]} (destination): {sig[4]}" for sig in sorted(existing_signatures, key=lambda s: (s[1] or "", s[3] or ""))
        ) if existing_signatures else ""

        rules = generate_parity_rules_from_samples(
            first_source_table, source_entries[first_source_table]["columns"], source_sample,
            first_destination_table, destination_entries[first_destination_table]["columns"], destination_sample,
            already_covered_text=already_covered_text,
            column_map_text=s2d_column_map.describe(mapping),
        )
    except Exception as e:
        print(f"AI parity rule suggestion error: {e}")
        return jsonify({"error": "AI parity rule suggestion failed", "details": str(e)}), 502

    # Column must exist on EVERY selected table per side, not just the one
    # the AI actually saw a sample of - otherwise the UNION ALL query the
    # engine builds would fail against tables the AI never looked at. A common
    # name from the validation's column map counts too, as long as the map
    # covers every selected table on that side: the engine resolves it to each
    # table's own physical column, so the UNION ALL is still valid.
    source_column_names = set.intersection(*(
        {c["name"] for c in entry["columns"]} for entry in source_entries.values()
    )) | set(s2d_column_map.common_names(mapping, "source", source_tables))
    destination_column_names = set.intersection(*(
        {c["name"] for c in entry["columns"]} for entry in destination_entries.values()
    )) | set(s2d_column_map.common_names(mapping, "destination", destination_tables))

    created = []
    skipped = []
    for rule in rules:
        name = rule.get("name", "unnamed")
        validation_type = rule.get("validation_type")
        source_column = rule.get("source_column")
        destination_column = rule.get("destination_column")

        if validation_type not in PARITY_VALIDATION_TYPES:
            skipped.append({"name": name, "reason": f"Unsupported validation_type: {validation_type}"})
            continue
        # Regex Pattern Check is the one metric that needs a parameter. If the
        # model proposed the type without a pattern there's nothing to execute,
        # so skip it rather than saving a rule that can only ERROR at run time.
        parity_config = {"pattern": rule["pattern"]} if rule.get("pattern") else None
        if validation_type == "Regex Pattern Check" and not parity_config:
            skipped.append({"name": name, "reason": "Regex Pattern Check proposed without a pattern"})
            continue
        if source_column not in source_column_names:
            skipped.append({"name": name, "reason": f"source_column '{source_column}' isn't common to every selected source table"})
            continue
        if destination_column not in destination_column_names:
            skipped.append({"name": name, "reason": f"destination_column '{destination_column}' isn't common to every selected destination table"})
            continue

        signature = (
            tuple(sorted(source_tables)), source_column,
            tuple(sorted(destination_tables)), destination_column,
            validation_type, (parity_config or {}).get("pattern"),
        )
        if signature in existing_signatures:
            skipped.append({"name": name, "reason": "Duplicate of an existing rule"})
            continue

        test_case_id = s2d_db.create_test_case(
            mapping_id=mapping_id, name=name, validation_type=validation_type, check_type="column_parity",
            source_tables=source_tables, source_column=source_column,
            destination_tables=destination_tables, destination_column=destination_column,
            parity_config=parity_config,
            origin="ai", severity=rule.get("severity", "error"), description=rule.get("description"),
        )
        created.append(s2d_db.get_test_case(test_case_id))
        existing_signatures.add(signature)  # guard against the AI proposing the same pair twice in one batch

    response = {"created": created, "skipped": skipped}
    if not created and rules:
        response["message"] = "The AI didn't find any new column pair to suggest — every rule it proposed already exists. Try different tables, or add one manually."
    return jsonify(response)


@app.route('/api/s2d/mappings/<mapping_id>/ai/suggest-cross-table-parity-rules', methods=['POST'])
def ai_suggest_cross_table_parity_rules(mapping_id):
    """
    Body: { "source_tables": ["..."], "destination_tables": ["..."] }

    Sample-based counterpart to ai_suggest_parity_rules, but for
    cross_table_parity instead of column_parity: reads a random sample from
    the FIRST table on each side (multiple tables per side are assumed
    similarly-shaped, same assumption row_count_match/ai_suggest_parity_rules
    already make), hands both samples to the AI, and lets it propose one or
    more candidate join/key columns on its own - no description required.
    cross_table_parity has no SQL to generate/validate (it's engine-computed
    by s2d/engine.py's _run_cross_table_parity_check), so each surviving
    suggestion is validated by confirming its key_column exists in EVERY
    selected table's schema on both sides, then saved immediately as an
    'ai'-origin cross_table_parity test case spanning the full table lists.
    """
    mapping = s2d_db.get_mapping(mapping_id)
    if not mapping:
        return jsonify({"error": "Mapping not found"}), 404

    body = request.get_json(force=True)
    source_tables = body.get("source_tables")
    destination_tables = body.get("destination_tables")
    if not source_tables or not destination_tables:
        return jsonify({"error": "source_tables and destination_tables are required"}), 400

    try:
        _, source_connector = get_connector_instance(mapping["source_connector_id"])
        _, destination_connector = get_connector_instance(mapping["destination_connector_id"])
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        source_schema = source_connector.list_tables_in_container(mapping["source_container_id"])
        source_entries = {t["table"]: t for t in source_schema if t["table"] in source_tables}
        missing_source = set(source_tables) - source_entries.keys()
        if missing_source:
            return jsonify({"error": f"Source table(s) not found: {', '.join(missing_source)}"}), 404

        destination_schema = destination_connector.list_tables_in_container(mapping["destination_container_id"])
        destination_entries = {t["table"]: t for t in destination_schema if t["table"] in destination_tables}
        missing_destination = set(destination_tables) - destination_entries.keys()
        if missing_destination:
            return jsonify({"error": f"Destination table(s) not found: {', '.join(missing_destination)}"}), 404

        first_source_table, first_destination_table = source_tables[0], destination_tables[0]
        source_sample = source_connector.sample_rows(mapping["source_container_id"], first_source_table, limit=20)
        destination_sample = destination_connector.sample_rows(mapping["destination_container_id"], first_destination_table, limit=20)

        # Signature = (source tables, destination tables, key column) for
        # every existing cross_table_parity rule - guarantees no duplicates
        # get saved regardless of whether the AI cooperates with the
        # prompt-level nudge below.
        existing_signatures = {
            (
                tuple(sorted(tc.get("source_target_tables") or [])),
                tuple(sorted(tc.get("destination_target_tables") or [])),
                tc.get("key_column"),
            )
            for tc in s2d_db.list_test_cases(mapping_id)
            if tc["check_type"] == "sql" and tc.get("check_scope") == "cross_table_parity"
        }
        already_covered_text = "\n".join(
            f"- key column: {sig[2]}" for sig in sorted(existing_signatures, key=lambda s: s[2] or "")
        ) if existing_signatures else ""

        rules = generate_key_column_suggestions_from_samples(
            first_source_table, source_entries[first_source_table]["columns"], source_sample,
            first_destination_table, destination_entries[first_destination_table]["columns"], destination_sample,
            already_covered_text=already_covered_text,
            column_map_text=s2d_column_map.describe(mapping),
        )
    except Exception as e:
        print(f"AI cross-table parity rule suggestion error: {e}")
        return jsonify({"error": "AI parity rule suggestion failed", "details": str(e)}), 502

    # Key column must exist on EVERY selected table per side, not just the
    # one the AI actually saw a sample of - otherwise the UNION ALL query
    # the engine builds would fail against tables the AI never looked at. A
    # common name from the validation's column map counts too when the map
    # covers every selected table on that side, since the engine resolves it
    # per table - that's the whole point of the map, and without this the AI
    # can't propose anything at all for tables that renamed their key.
    source_column_names = set.intersection(*(
        {c["name"] for c in entry["columns"]} for entry in source_entries.values()
    )) | set(s2d_column_map.common_names(mapping, "source", source_tables))
    destination_column_names = set.intersection(*(
        {c["name"] for c in entry["columns"]} for entry in destination_entries.values()
    )) | set(s2d_column_map.common_names(mapping, "destination", destination_tables))

    created = []
    skipped = []
    for rule in rules:
        name = rule.get("name", "unnamed")
        key_column = rule.get("key_column")

        if key_column not in source_column_names:
            skipped.append({"name": name, "reason": f"key_column '{key_column}' isn't common to every selected source table"})
            continue
        if key_column not in destination_column_names:
            skipped.append({"name": name, "reason": f"key_column '{key_column}' isn't common to every selected destination table"})
            continue

        signature = (tuple(sorted(source_tables)), tuple(sorted(destination_tables)), key_column)
        if signature in existing_signatures:
            skipped.append({"name": name, "reason": "Duplicate of an existing rule"})
            continue

        test_case_id = s2d_db.create_test_case(
            mapping_id=mapping_id, name=name, validation_type="Custom", check_type="sql",
            check_scope="cross_table_parity", key_column=key_column,
            source_target_tables=source_tables, destination_target_tables=destination_tables,
            origin="ai", severity=rule.get("severity", "error"), description=rule.get("description"),
        )
        created.append(s2d_db.get_test_case(test_case_id))
        existing_signatures.add(signature)  # guard against the AI proposing the same key twice in one batch

    response = {"created": created, "skipped": skipped}
    if not created and rules:
        response["message"] = "The AI didn't find any new key column to suggest — every rule it proposed already exists. Try different tables, or add one manually."
    return jsonify(response)


# --- S2D: Test suites -------------------------------------------------------

@app.route('/api/s2d/suites', methods=['GET'])
def list_all_s2d_suites():
    mapping_id = request.args.get('mapping_id')
    return jsonify(s2d_db.list_suites(mapping_id=mapping_id))


@app.route('/api/s2d/mappings/<mapping_id>/suites', methods=['GET'])
def list_s2d_suites_for_mapping(mapping_id):
    return jsonify(s2d_db.list_suites(mapping_id=mapping_id))


@app.route('/api/s2d/mappings/<mapping_id>/suites', methods=['POST'])
def create_s2d_suite(mapping_id):
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    description = body.get("description")
    test_case_ids = body.get("test_case_ids") or []

    if not name:
        return jsonify({"error": "name is required"}), 400
    if not isinstance(test_case_ids, list):
        return jsonify({"error": "test_case_ids must be a list"}), 400

    if not s2d_db.get_mapping(mapping_id):
        return jsonify({"error": "Mapping not found"}), 404

    if test_case_ids:
        mapping_test_case_ids = {tc["id"] for tc in s2d_db.list_test_cases(mapping_id)}
        invalid = [tc_id for tc_id in test_case_ids if tc_id not in mapping_test_case_ids]
        if invalid:
            return jsonify({"error": f"test_case_ids do not belong to this mapping: {invalid}"}), 400

    suite_id = s2d_db.create_suite(mapping_id, name, description, test_case_ids)
    return jsonify({"id": suite_id}), 201


@app.route('/api/s2d/suites/<suite_id>', methods=['GET'])
def get_s2d_suite(suite_id):
    suite = s2d_db.get_suite(suite_id)
    if not suite:
        return jsonify({"error": "Suite not found"}), 404
    return jsonify(suite)


@app.route('/api/s2d/suites/<suite_id>', methods=['PATCH'])
def update_s2d_suite(suite_id):
    suite = s2d_db.get_suite(suite_id)
    if not suite:
        return jsonify({"error": "Suite not found"}), 404

    body = request.get_json(force=True) or {}
    name = body.get("name")
    description = body.get("description")
    test_case_ids = body.get("test_case_ids")

    if test_case_ids is not None:
        if not isinstance(test_case_ids, list) or not test_case_ids:
            return jsonify({"error": "test_case_ids must be a non-empty list"}), 400
        mapping_test_case_ids = {tc["id"] for tc in s2d_db.list_test_cases(suite["mapping_id"])}
        invalid = [tc_id for tc_id in test_case_ids if tc_id not in mapping_test_case_ids]
        if invalid:
            return jsonify({"error": f"test_case_ids do not belong to this suite's mapping: {invalid}"}), 400

    s2d_db.update_suite(suite_id, name=name, description=description, test_case_ids=test_case_ids)
    return jsonify(s2d_db.get_suite(suite_id))


@app.route('/api/s2d/suites/<suite_id>', methods=['DELETE'])
def delete_s2d_suite(suite_id):
    s2d_db.delete_suite(suite_id)
    return jsonify({"ok": True})


@app.route('/api/s2d/suites/<suite_id>/run', methods=['POST'])
def run_s2d_suite(suite_id):
    suite = s2d_db.get_suite(suite_id)
    if not suite:
        return jsonify({"error": "Suite not found"}), 404
    if not suite.get("mapping"):
        return jsonify({"error": "Suite's mapping no longer exists"}), 400

    active_test_cases = [tc for tc in suite["test_cases"] if tc.get("active")]
    if not active_test_cases:
        return jsonify({"error": "This suite has no active test cases to run"}), 400

    mapping = suite["mapping"]
    try:
        _, source_connector = get_connector_instance(mapping["source_connector_id"])
        _, destination_connector = get_connector_instance(mapping["destination_connector_id"])
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    run_id = run_suite(source_connector, destination_connector, mapping, suite_id, active_test_cases)
    return jsonify({"run_id": run_id})


@app.route('/api/s2d/mappings/<mapping_id>/run', methods=['POST'])
def run_s2d_pipeline(mapping_id):
    mapping = s2d_db.get_mapping(mapping_id)
    if not mapping:
        return jsonify({"error": "Mapping not found"}), 404

    test_cases = s2d_db.list_test_cases(mapping_id)
    if not test_cases:
        return jsonify({"error": "This mapping has no test cases yet"}), 400

    try:
        _, source_connector = get_connector_instance(mapping["source_connector_id"])
        _, destination_connector = get_connector_instance(mapping["destination_connector_id"])
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    run_id = run_pipeline(source_connector, destination_connector, mapping, test_cases)
    return jsonify({"run_id": run_id})


@app.route('/api/s2d/runs', methods=['GET'])
def list_s2d_runs():
    mapping_id = request.args.get('mapping_id')
    return jsonify(s2d_db.list_runs(mapping_id=mapping_id))


@app.route('/api/s2d/runs/<run_id>', methods=['GET'])
def get_s2d_run(run_id):
    run = s2d_db.get_run(run_id)
    if not run:
        return jsonify({"error": "Run not found"}), 404
    return jsonify(run)


# --- Schedules --------------------------------------------------------------

def _validate_schedule_body(body):
    """Common validation for suite + harvest schedule payloads. Returns (error, tuple_or_None).
    On success returns (None, (trigger_type, trigger_config, timezone_name)).
    """
    trigger_type = body.get("trigger_type")
    trigger_config = body.get("trigger_config")
    timezone_name = body.get("timezone") or "UTC"

    if trigger_type not in ("cron", "interval"):
        return "trigger_type must be 'cron' or 'interval'", None
    if not isinstance(trigger_config, dict):
        return "trigger_config must be an object", None

    if trigger_type == "cron":
        expr = trigger_config.get("expression")
        if not isinstance(expr, str) or not expr.strip():
            return "trigger_config.expression is required for cron", None
        try:
            from apscheduler.triggers.cron import CronTrigger
            from zoneinfo import ZoneInfo
            CronTrigger.from_crontab(expr.strip(), timezone=ZoneInfo(timezone_name))
        except Exception as e:
            return f"Invalid cron expression or timezone: {e}", None
    else:
        try:
            seconds = int(trigger_config.get("seconds"))
        except (TypeError, ValueError):
            return "trigger_config.seconds must be an integer", None
        if seconds < 60:
            return "trigger_config.seconds must be at least 60", None

    return None, (trigger_type, trigger_config, timezone_name)


def _serialize_next_fires(trigger_type, trigger_config, timezone_name, count=3):
    try:
        return [dt.isoformat() for dt in _scheduler.compute_next_fires(trigger_type, trigger_config, timezone_name, count=count)]
    except Exception:
        return []


# Suite schedules ------------------------------------------------------------

@app.route('/api/s2d/suites/<suite_id>/schedules', methods=['GET'])
def list_suite_schedules_route(suite_id):
    schedules = s2d_db.list_suite_schedules(suite_id=suite_id)
    for s in schedules:
        s["next_fires"] = _serialize_next_fires(s["trigger_type"], s["trigger_config"], s.get("timezone")) if s.get("active") else []
    return jsonify(schedules)


@app.route('/api/s2d/suites/<suite_id>/schedules', methods=['POST'])
def create_suite_schedule_route(suite_id):
    if not s2d_db.get_suite(suite_id):
        return jsonify({"error": "Suite not found"}), 404
    body = request.get_json(force=True) or {}
    err, parsed = _validate_schedule_body(body)
    if err:
        return jsonify({"error": err}), 400
    trigger_type, trigger_config, timezone_name = parsed
    schedule_id = s2d_db.create_suite_schedule(suite_id, trigger_type, trigger_config, timezone_name)
    row = s2d_db.get_suite_schedule(schedule_id)
    try:
        _scheduler.add_suite_schedule_job(row)
    except Exception as e:
        s2d_db.delete_suite_schedule(schedule_id)
        return jsonify({"error": f"Failed to register schedule: {e}"}), 500
    return jsonify({"id": schedule_id, "next_fires": _serialize_next_fires(trigger_type, trigger_config, timezone_name)}), 201


@app.route('/api/s2d/schedules/<schedule_id>', methods=['PATCH'])
def update_suite_schedule_route(schedule_id):
    existing = s2d_db.get_suite_schedule(schedule_id)
    if not existing:
        return jsonify({"error": "Schedule not found"}), 404
    body = request.get_json(force=True) or {}

    trigger_changed = any(k in body for k in ("trigger_type", "trigger_config", "timezone"))
    if trigger_changed:
        merged = {
            "trigger_type": body.get("trigger_type", existing["trigger_type"]),
            "trigger_config": body.get("trigger_config", existing["trigger_config"]),
            "timezone": body.get("timezone", existing.get("timezone") or "UTC"),
        }
        err, _ = _validate_schedule_body(merged)
        if err:
            return jsonify({"error": err}), 400

    s2d_db.update_suite_schedule(
        schedule_id,
        trigger_type=body.get("trigger_type"),
        trigger_config=body.get("trigger_config"),
        timezone_name=body.get("timezone"),
        active=body.get("active"),
    )
    updated = s2d_db.get_suite_schedule(schedule_id)
    _scheduler.remove_suite_schedule_job(schedule_id)
    if updated.get("active"):
        try:
            _scheduler.add_suite_schedule_job(updated)
        except Exception as e:
            return jsonify({"error": f"Failed to re-register schedule: {e}"}), 500
    updated["next_fires"] = _serialize_next_fires(updated["trigger_type"], updated["trigger_config"], updated.get("timezone")) if updated.get("active") else []
    return jsonify(updated)


@app.route('/api/s2d/schedules/<schedule_id>', methods=['DELETE'])
def delete_suite_schedule_route(schedule_id):
    _scheduler.remove_suite_schedule_job(schedule_id)
    s2d_db.delete_suite_schedule(schedule_id)
    return jsonify({"ok": True})


@app.route('/api/s2d/schedules/<schedule_id>/events', methods=['GET'])
def list_suite_schedule_events_route(schedule_id):
    limit = int(request.args.get('limit', 50))
    return jsonify(s2d_db.list_schedule_events('suite', schedule_id, limit=limit))


# Harvest schedules ----------------------------------------------------------

@app.route('/api/connectors/<connector_id>/schedules', methods=['GET'])
def list_harvest_schedules_route(connector_id):
    schedules = s2d_db.list_harvest_schedules(connector_id=connector_id)
    for s in schedules:
        s["next_fires"] = _serialize_next_fires(s["trigger_type"], s["trigger_config"], s.get("timezone")) if s.get("active") else []
    return jsonify(schedules)


def _validate_selected_items(items):
    """Returns (error, cleaned_list) — a list of {id, name, type} dicts."""
    if not isinstance(items, list) or not items:
        return "selected_items must be a non-empty list", None
    cleaned = []
    for it in items:
        if not isinstance(it, dict):
            return "each selected_items entry must be an object with id/name/type", None
        item_id = it.get("id")
        item_type = it.get("type")
        item_name = it.get("name")
        if not item_id or not item_type:
            return "each selected_items entry must have id and type", None
        cleaned.append({"id": str(item_id), "name": item_name, "type": str(item_type)})
    return None, cleaned


@app.route('/api/connectors/<connector_id>/schedules', methods=['POST'])
def create_harvest_schedule_route(connector_id):
    if not catalog_db.get_connector_config(connector_id):
        return jsonify({"error": "Connector not found"}), 404
    body = request.get_json(force=True) or {}
    err, parsed = _validate_schedule_body(body)
    if err:
        return jsonify({"error": err}), 400
    trigger_type, trigger_config, timezone_name = parsed
    mode = body.get("mode") or "incremental"
    if mode not in ("incremental", "full_refresh"):
        return jsonify({"error": "mode must be 'incremental' or 'full_refresh'"}), 400

    items_err, selected_items = _validate_selected_items(body.get("selected_items"))
    if items_err:
        return jsonify({"error": items_err}), 400

    schedule_id = s2d_db.create_harvest_schedule(
        connector_id, mode, trigger_type, trigger_config, timezone_name,
        selected_items=selected_items,
    )
    row = s2d_db.get_harvest_schedule(schedule_id)
    try:
        _scheduler.add_harvest_schedule_job(row)
    except Exception as e:
        s2d_db.delete_harvest_schedule(schedule_id)
        return jsonify({"error": f"Failed to register schedule: {e}"}), 500
    return jsonify({"id": schedule_id, "next_fires": _serialize_next_fires(trigger_type, trigger_config, timezone_name)}), 201


@app.route('/api/harvest/schedules/<schedule_id>', methods=['PATCH'])
def update_harvest_schedule_route(schedule_id):
    existing = s2d_db.get_harvest_schedule(schedule_id)
    if not existing:
        return jsonify({"error": "Schedule not found"}), 404
    body = request.get_json(force=True) or {}

    if "mode" in body and body["mode"] not in ("incremental", "full_refresh"):
        return jsonify({"error": "mode must be 'incremental' or 'full_refresh'"}), 400

    trigger_changed = any(k in body for k in ("trigger_type", "trigger_config", "timezone"))
    if trigger_changed:
        merged = {
            "trigger_type": body.get("trigger_type", existing["trigger_type"]),
            "trigger_config": body.get("trigger_config", existing["trigger_config"]),
            "timezone": body.get("timezone", existing.get("timezone") or "UTC"),
        }
        err, _ = _validate_schedule_body(merged)
        if err:
            return jsonify({"error": err}), 400

    selected_items_arg = None
    if "selected_items" in body:
        items_err, selected_items_arg = _validate_selected_items(body["selected_items"])
        if items_err:
            return jsonify({"error": items_err}), 400

    s2d_db.update_harvest_schedule(
        schedule_id,
        mode=body.get("mode"),
        trigger_type=body.get("trigger_type"),
        trigger_config=body.get("trigger_config"),
        timezone_name=body.get("timezone"),
        active=body.get("active"),
        selected_items=selected_items_arg,
    )
    updated = s2d_db.get_harvest_schedule(schedule_id)
    _scheduler.remove_harvest_schedule_job(schedule_id)
    if updated.get("active"):
        try:
            _scheduler.add_harvest_schedule_job(updated)
        except Exception as e:
            return jsonify({"error": f"Failed to re-register schedule: {e}"}), 500
    updated["next_fires"] = _serialize_next_fires(updated["trigger_type"], updated["trigger_config"], updated.get("timezone")) if updated.get("active") else []
    return jsonify(updated)


@app.route('/api/harvest/schedules/<schedule_id>', methods=['DELETE'])
def delete_harvest_schedule_route(schedule_id):
    _scheduler.remove_harvest_schedule_job(schedule_id)
    s2d_db.delete_harvest_schedule(schedule_id)
    return jsonify({"ok": True})


@app.route('/api/harvest/schedules/<schedule_id>/events', methods=['GET'])
def list_harvest_schedule_events_route(schedule_id):
    limit = int(request.args.get('limit', 50))
    return jsonify(s2d_db.list_schedule_events('harvest', schedule_id, limit=limit))


# Cross-cutting --------------------------------------------------------------

# --- Pipeline schedules -----------------------------------------------------
# Note the URL shape: /api/connectors/<id>/schedules is already the harvest
# schedule list, so pipelines get their own path rather than overloading it.

@app.route('/api/connectors/<connector_id>/pipeline-schedules', methods=['GET'])
def list_pipeline_schedules_route(connector_id):
    item_id = request.args.get("pipeline_item_id")
    schedules = s2d_db.list_pipeline_schedules(connector_id=connector_id, pipeline_item_id=item_id)
    for s in schedules:
        s["next_fires"] = _serialize_next_fires(
            s["trigger_type"], s["trigger_config"], s.get("timezone")) if s.get("active") else []
    return jsonify({"schedules": schedules})


@app.route('/api/connectors/<connector_id>/pipeline-schedules', methods=['POST'])
def create_pipeline_schedule_route(connector_id):
    """Body: { pipeline_item_id, pipeline_name, trigger_type, trigger_config, timezone }"""
    connector, error = _fabric_connector_or_error(connector_id)
    if error:
        return error

    body = request.get_json(force=True) or {}
    item_id = (body.get("pipeline_item_id") or "").strip()
    if not item_id:
        return jsonify({"error": "pipeline_item_id is required"}), 400

    err, parsed = _validate_schedule_body(body)
    if err:
        return jsonify({"error": err}), 400
    trigger_type, trigger_config, timezone_name = parsed

    schedule_id = s2d_db.create_pipeline_schedule(
        connector_id, item_id, body.get("pipeline_name"), trigger_type, trigger_config, timezone_name)
    row = s2d_db.get_pipeline_schedule(schedule_id)
    try:
        _scheduler.add_pipeline_schedule_job(row)
    except Exception as e:
        # Roll the row back rather than leave a schedule that will never fire.
        s2d_db.delete_pipeline_schedule(schedule_id)
        return jsonify({"error": f"Failed to register schedule: {e}"}), 500
    return jsonify({
        "id": schedule_id,
        "next_fires": _serialize_next_fires(trigger_type, trigger_config, timezone_name),
    }), 201


@app.route('/api/pipelines/schedules/<schedule_id>', methods=['PATCH'])
def update_pipeline_schedule_route(schedule_id):
    existing = s2d_db.get_pipeline_schedule(schedule_id)
    if not existing:
        return jsonify({"error": "Schedule not found"}), 404
    body = request.get_json(force=True) or {}

    if any(k in body for k in ("trigger_type", "trigger_config", "timezone")):
        # Validate the MERGED trigger, so changing only the timezone still
        # checks it against the stored cron expression.
        merged = {
            "trigger_type": body.get("trigger_type", existing["trigger_type"]),
            "trigger_config": body.get("trigger_config", existing["trigger_config"]),
            "timezone": body.get("timezone", existing.get("timezone") or "UTC"),
        }
        err, _ = _validate_schedule_body(merged)
        if err:
            return jsonify({"error": err}), 400

    s2d_db.update_pipeline_schedule(
        schedule_id,
        trigger_type=body.get("trigger_type"),
        trigger_config=body.get("trigger_config"),
        timezone_name=body.get("timezone"),
        active=body.get("active"),
    )
    updated = s2d_db.get_pipeline_schedule(schedule_id)
    # Unconditional remove then conditional re-add is how the active toggle
    # pauses a job without losing the row.
    _scheduler.remove_pipeline_schedule_job(schedule_id)
    if updated.get("active"):
        try:
            _scheduler.add_pipeline_schedule_job(updated)
        except Exception as e:
            return jsonify({"error": f"Failed to re-register schedule: {e}"}), 500
    updated["next_fires"] = _serialize_next_fires(
        updated["trigger_type"], updated["trigger_config"], updated.get("timezone")) if updated.get("active") else []
    return jsonify(updated)


@app.route('/api/pipelines/schedules/<schedule_id>', methods=['DELETE'])
def delete_pipeline_schedule_route(schedule_id):
    _scheduler.remove_pipeline_schedule_job(schedule_id)
    s2d_db.delete_pipeline_schedule(schedule_id)
    return jsonify({"ok": True})


@app.route('/api/pipelines/schedules/<schedule_id>/events', methods=['GET'])
def list_pipeline_schedule_events_route(schedule_id):
    limit = request.args.get("limit", default=50, type=int)
    return jsonify({"events": s2d_db.list_schedule_events("pipeline", schedule_id, limit=limit)})


@app.route('/api/schedules', methods=['GET'])
def list_all_schedules_route():
    suites = s2d_db.list_suite_schedules()
    harvests = s2d_db.list_harvest_schedules()
    pipelines = s2d_db.list_pipeline_schedules()
    for s in suites:
        s["kind"] = "suite"
        s["next_fires"] = _serialize_next_fires(s["trigger_type"], s["trigger_config"], s.get("timezone")) if s.get("active") else []
    for h in harvests:
        h["kind"] = "harvest"
        h["next_fires"] = _serialize_next_fires(h["trigger_type"], h["trigger_config"], h.get("timezone")) if h.get("active") else []
    for p in pipelines:
        p["kind"] = "pipeline"
        p["next_fires"] = _serialize_next_fires(p["trigger_type"], p["trigger_config"], p.get("timezone")) if p.get("active") else []
    return jsonify({
        "suite_schedules": suites,
        "harvest_schedules": harvests,
        "pipeline_schedules": pipelines,
    })


@app.route('/api/schedules/preview', methods=['POST'])
def preview_schedule_route():
    body = request.get_json(force=True) or {}
    err, parsed = _validate_schedule_body(body)
    if err:
        return jsonify({"error": err}), 400
    trigger_type, trigger_config, timezone_name = parsed
    return jsonify({"next_fires": _serialize_next_fires(trigger_type, trigger_config, timezone_name, count=5)})


if __name__ == '__main__':
    # WERKZEUG_RUN_MAIN='true' is set only in the child reloader process that
    # actually serves requests. Without this guard, debug=True would spin up
    # two schedulers (parent watcher + child) and every fire would double.
    # For a WSGI deploy (gunicorn/waitress) the app.run() branch isn't hit
    # anyway; that entry point should call scheduler.init_scheduler() itself.
    if os.environ.get('WERKZEUG_RUN_MAIN') == 'true':
        _scheduler.init_scheduler()
    app.run(debug=True, port=5000)