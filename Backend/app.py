from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv
from s2d.engine import run_pipeline, run_one
from catalog import db as catalog_db
from connector_factory import build_connector
from harvest import run_harvest
from local_files import db as local_db
from s2d import db as s2d_db
from s2d.engine import run_pipeline

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


@app.route('/api/connectors/<connector_id>/items', methods=['GET'])
def get_connector_items(connector_id):
    """Full, unrestricted live browse - powers the Harvest wizard's checkbox tree."""
    try:
        _, connector = get_connector_instance(connector_id)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        items = connector.list_items()
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
    """
    try:
        _, connector = get_connector_instance(connector_id)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        schema = connector.list_tables_in_container(container_id)
        tables = [{"name": t["table"], "kind": t["kind"]} for t in schema]
        return jsonify({"tables": tables})
    except Exception as e:
        return jsonify({"error": "Failed to list tables", "details": str(e)}), 502


# --- Local connector: file upload -------------------------------------------

@app.route('/api/connectors/<connector_id>/local/upload', methods=['POST'])
def upload_local_file(connector_id):
    """
    Multipart form upload. Fields: 'file' (the .csv/.parquet), optional
    'display_name'. Ingests into DuckDB as a real table immediately.
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

    try:
        row = local_db.ingest_file(connector_id, file_storage, display_name=display_name)
        return jsonify(row), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": "Failed to ingest file", "details": str(e)}), 500


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

    result = run_harvest(connector, config["name"], items, mode=mode)
    return jsonify(result)


# --- Catalog -----------------------------------------------------------

@app.route('/api/catalog', methods=['GET'])
def get_catalog():
    connector_type = request.args.get('connector_type')
    asset_type = request.args.get('type')
    search = request.args.get('search')
    assets = catalog_db.list_assets(connector_type=connector_type, asset_type=asset_type, search=search)
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


@app.route('/api/s2d/mappings/<mapping_id>', methods=['DELETE'])
def delete_s2d_mapping(mapping_id):
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
    """
    mapping = s2d_db.get_mapping(mapping_id)
    if not mapping:
        return jsonify({"error": "Mapping not found"}), 404

    body = request.get_json(force=True)
    error = _validate_test_case_body(body, mapping)
    if error:
        return jsonify({"error": error}), 400

    test_case_id = s2d_db.create_test_case(
        mapping_id=mapping_id, name=body["name"], validation_type=body["validation_type"],
        check_type=body["check_type"], target=body.get("target"), target_table=body.get("target_table"),
        script_type=body.get("script_type"), script_text=body.get("script_text"),
        row_count_source_tables=body.get("row_count_source_tables"),
        row_count_destination_tables=body.get("row_count_destination_tables"),
    )
    return jsonify({"id": test_case_id}), 201


def _validate_test_case_body(body, mapping):
    """Shared validation for create and update. Returns an error string, or None if valid."""
    required = ["name", "validation_type", "check_type"]
    missing = [f for f in required if not body.get(f)]
    if missing:
        return f"Missing fields: {', '.join(missing)}"

    check_type = body["check_type"]
    if check_type not in ("sql", "row_count_match"):
        return "check_type must be 'sql' or 'row_count_match'"

    if check_type == "sql":
        target = body.get("target")
        script_type = body.get("script_type")
        script_text = body.get("script_text")
        if target not in ("source", "destination"):
            return "target must be 'source' or 'destination' for sql checks"
        if script_type not in ("sql", "pyspark"):
            return "script_type must be 'sql' or 'pyspark'"
        if not script_text:
            return "script_text is required for sql checks"
        target_table = body.get("target_table")
        if target_table:
            valid_tables = mapping["source_tables"] if target == "source" else mapping["destination_tables"]
            if target_table not in valid_tables:
                return f"target_table must be one of the mapping's {target} tables"

    if check_type == "row_count_match":
        rc_source = body.get("row_count_source_tables")
        rc_dest = body.get("row_count_destination_tables")
        if not rc_source or not rc_dest:
            return "row_count_source_tables and row_count_destination_tables are required for row_count_match checks"
        if not set(rc_source).issubset(set(mapping["source_tables"])):
            return "row_count_source_tables must be a subset of the mapping's source tables"
        if not set(rc_dest).issubset(set(mapping["destination_tables"])):
            return "row_count_destination_tables must be a subset of the mapping's destination tables"

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

    s2d_db.update_test_case(
        test_case_id, name=body["name"], validation_type=body["validation_type"],
        check_type=body["check_type"], target=body.get("target"), target_table=body.get("target_table"),
        script_type=body.get("script_type"), script_text=body.get("script_text"),
        row_count_source_tables=body.get("row_count_source_tables"),
        row_count_destination_tables=body.get("row_count_destination_tables"),
    )
    return jsonify({"updated": test_case_id})


@app.route('/api/s2d/test-cases/<test_case_id>', methods=['DELETE'])
def delete_s2d_test_case(test_case_id):
    s2d_db.delete_test_case(test_case_id)
    return jsonify({"deleted": test_case_id})


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


if __name__ == '__main__':
    app.run(debug=True, port=5000)