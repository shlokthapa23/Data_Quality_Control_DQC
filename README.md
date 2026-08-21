# Data Quality Control

An internal data platform for Microsoft Fabric (and local CSV/Parquet files):
connect to workspaces, harvest metadata into a searchable catalog, and run
source-to-destination data validation tests with real pass/fail results.

## Architecture

Everything is built around one interface: `BaseConnector`. Every data source
- Fabric, Local files, and anything added later - implements the same five
methods (`test_connection`, `list_items`, `get_schema`, `list_containers`,
`list_tables_in_container`, `run_query`). Nothing else in the app (Harvest,
Catalog, S2D) knows or cares which actual source it's talking to. Adding a
new connector type later means writing one new file, not touching the rest
of the app.

### Modules

- **Connect** - register a data source. Fabric connectors need Tenant
  ID/Client ID/Client Secret/Workspace ID and let you pin a subset of
  Lakehouses (which then also scopes what Harvest shows for that
  connector); Local connectors need nothing and let you upload
  `.csv`/`.parquet` files directly, ingested into DuckDB as real tables.
- **Harvest** - pulls metadata (schema, not data) from a connector into
  our own SQLite catalog. A snapshot, not a live view - browsing the
  Catalog afterward never re-queries the source.
- **Catalog** - browse everything harvested. Reads only from our own
  database, so it works even if the source is temporarily unreachable.
- **S2D Validation** - the main feature. Build a mapping (independent
  source and destination, each: connector + container + one or more
  tables), attach test cases (custom SQL, or the built-in Row Count
  Match), and run them for real, live, against the actual source(s).
- **History** - every past test run, clickable into its full results.

### Data model notes

- A mapping's source and destination are fully independent - same
  connector+container (classic single-Lakehouse case), same connector +
  different container (cross-Lakehouse), or entirely different connectors
  (Fabric <-> Local, Local <-> Local).
- Test cases are either `sql` (a raw script you write, targeting one
  specific side) or `row_count_match` (built-in: sums `COUNT(*)` across
  whichever tables you pick on each side, in one query per side, then
  compares the totals in Python - the only check type that can safely
  span two different connectors, since no single SQL query can join
  across two separate database connections).
- Every SQL test-case script must return exactly one row with a `passed`
  column (0/1 or true/false) and optionally a `details` column - that
  contract is how the engine grades PASS/FAIL.
- **PySpark test cases save but don't execute yet** - marked `ERROR` with
  an explicit "not wired up" message rather than silently skipped.
- **The "AI Prompt Generator" tab is a visible stub** - no backend behind
  it, by design, until that's prioritized.

### Important operational details

- `client_secret` is stored in **plaintext** in the SQLite catalog, same
  trust model as a `.env` file. Fine for an internal tool on a trusted
  machine; harden before exposing more broadly.
- The SELECT-only guard on test-case SQL is a **defensive keyword check**,
  not a real SQL parser - it stops accidental destructive statements, not
  a determined bad actor. The service principal's actual read-only Fabric
  role is the real backstop.
- **SQL dialect depends on which side you target.** Fabric connectors
  speak T-SQL (via `pyodbc` -> SQL Server); Local connectors speak DuckDB
  SQL (e.g. `||` for string concatenation instead of `+`). The "Runs
  against: Source/Destination" selector on a test case is really picking
  which SQL engine your script has to be valid for.
- **Schema migrations here are destructive, not backward-compatible.**
  When the data model's shape changes, `init_*_tables()` functions detect
  the stale schema and drop-and-recreate the affected tables. This has
  happened a few times already as the app evolved - check the comments
  above `_migrate_stale_schema_if_needed()` in `s2d/db.py` if you're
  debugging something that looks like missing data after a pull.

## Project structure