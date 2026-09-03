# PySpark source for the second fixed notebook this app provisions per
# Fabric workspace (see FabricConnector.ensure_test_case_notebook) - runs a
# TESTER-AUTHORED PySpark script as an S2D test case, the PySpark counterpart
# to a SQL script's `connector.run_query(container_id, script_text)`.
#
# Same reasoning as the insert notebook (fabric_notebook_template.py) for why
# this has to be a real Spark job rather than anything through the SQL
# analytics endpoint: PySpark simply doesn't run there.
#
# Contract a tester's script is expected to follow - deliberately mirrors what
# a SQL test-case script already returns as a row (see s2d/engine.py's
# _interpret_row/_describe_extra_columns, which read this same shape):
#   - call `read_table('"schema"."table"')` (same quoted table-name format
#     the rest of this app already uses) to get a DataFrame for any table in
#     the target Lakehouse
#   - end by setting a `result` dict, e.g.:
#       result = {"passed": violations == 0, "violations": violations, "total_rows": total_rows}
#     "passed" is optional (an unasserted script is still a valid "measure
#     only" run, same as a SQL script with no `passed` column) - anything
#     else in the dict is surfaced verbatim as extra output, same as an
#     extra SELECT column would be for a SQL script.
#
# NOT yet verified against a live tenant - see tasks/lessons.md once this has
# been live-tested.
NOTEBOOK_SOURCE = '''# Fabric notebook source

# PARAMETERS CELL ********************

workspace_id = ""
lakehouse_id = ""
script_b64 = ""
result_path = ""

# CELL ********************

import base64
import json
import re

def read_table(table_name):
    """
    table_name: '"dbo"."orders"' - the same quoted schema.table format used
    everywhere else in this app (test-case editors, SQL scripts, error
    messages). Converted here to OneLake's Tables/<schema>/<table> path
    convention - the tester never has to know or care about that
    distinction, matching the placeholder examples this editor shows.
    """
    parts = re.findall(r'"((?:[^"]|"")*)"', table_name)
    if len(parts) != 2:
        raise ValueError(f'read_table() expects a quoted "schema"."table" name, got: {table_name!r}')
    schema, table = (p.replace('""', '"') for p in parts)
    full_path = f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com/{lakehouse_id}/Tables/{schema}/{table}"
    return spark.read.format("delta").load(full_path)

script_text = base64.b64decode(script_b64).decode("utf-8")

# The tester's script runs with `spark` and `read_table` already in scope,
# exactly like a SQL test-case script runs against an already-open
# connection - it never has to set up its own Spark session or Fabric auth.
namespace = {"spark": spark, "read_table": read_table}
try:
    exec(script_text, namespace)
    result = namespace.get("result")
    if result is None:
        result = {"passed": None, "details": "Script did not set a 'result' variable - nothing was asserted or measured."}
    elif not isinstance(result, dict):
        result = {"details": f"Script's 'result' must be a dict, got {type(result).__name__}: {result!r}"}
except Exception as e:
    result = {"passed": False, "details": f"Script raised an exception: {e}"}

result_full_path = f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com/{lakehouse_id}/Files/{result_path}"
# notebookutils is Fabric's own notebook utility library (the
# Databricks-world "dbutils" doesn't exist here) - NOT yet verified against
# a live tenant; if this call fails, the working alternative is almost
# certainly its older alias, mssparkutils.fs.put(...), same signature.
notebookutils.fs.put(result_full_path, json.dumps(result), True)
print(f"Wrote result to {result_path}: {result}")
'''
