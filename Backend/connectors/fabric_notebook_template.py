# PySpark source for the one fixed notebook this app provisions per Fabric
# workspace (see FabricConnector.ensure_test_data_notebook) to do the one
# write Fabric's SQL analytics endpoint categorically cannot do: append rows
# into a real Lakehouse Delta table. The SQL endpoint is read-only by
# Microsoft's own design (error 24559 on any DML) - a Spark job is one of the
# only ways Fabric allows writing to a Lakehouse table at all.
#
# This is Fabric's own "notebook-content.py" source format: a plain .py file
# with `# CELL` markers Fabric's notebook editor understands, uploaded via
# the Item Definition API as this file's base64 content. NOT yet verified
# against a live tenant - if Fabric rejects this exact marker syntax on
# creation, the fix is to correct the markers here, not to change the
# approach (see tasks/lessons.md once this has been live-tested).
#
# Parameters (Fabric's "parameters cell" convention - a cell tagged
# "parameters" so a notebook-run job can override these three via
# executionData.parameters): workspace_id, lakehouse_id, table_path (e.g.
# "dbo/orders" - already converted from the app's '"dbo"."orders"' quoting
# by the caller), staging_path (the CSV just written under Files/).
NOTEBOOK_SOURCE = '''# Fabric notebook source

# PARAMETERS CELL ********************

workspace_id = ""
lakehouse_id = ""
table_path = ""
staging_path = ""

# CELL ********************

from pyspark.sql.functions import col

target_path = f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com/{lakehouse_id}/Tables/{table_path}"
staging_full_path = f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com/{lakehouse_id}/Files/{staging_path}"

# Every value this app generates arrives as a string (dates, decimals,
# booleans included - see TestDataDraftModal.jsx) - read the staging CSV
# with every column as a string first, then cast each one to the TARGET
# table's real type, rather than trusting CSV type inference (which would
# guess wrong for things like a zero-padded code or a "true"/"false" text
# column that isn't actually boolean-typed downstream).
target_schema = spark.read.format("delta").load(target_path).schema
staged_df = spark.read.option("header", "true").csv(staging_full_path)

casted_df = staged_df.select([
    col(field.name).cast(field.dataType).alias(field.name)
    for field in target_schema
    if field.name in staged_df.columns
])

casted_df.write.format("delta").mode("append").save(target_path)

print(f"Appended {casted_df.count()} row(s) into {table_path}")
'''
