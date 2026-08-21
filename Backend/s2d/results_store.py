"""
The one place engine.py/app.py reach for test-run/result persistence and
reads, instead of importing s2d.db directly for these specific functions.

Today this is a pure pass-through to the SQLite implementation in s2d.db -
nothing about behavior changes by this file existing. What it buys: a single
seam to edit when test history needs to live somewhere other than the local
SQLite file this app already uses for everything else (connectors, mappings,
test cases, ...). That's a real production concern - a local device/SQLite
file isn't durable or shared storage for a server - but WHICH database
replaces it (Postgres? a managed service? something else?) hasn't been
decided, so no such backend is implemented here. When it is, its
implementation plugs in at STORAGE_BACKEND below, against the exact same
function signatures already used by every caller - no call site elsewhere
in the codebase has to change.

RETENTION_DAYS is the one named constant for "how much history to keep" -
change it here, not by hunting down a magic number in scheduler.py or db.py.
"""

from datetime import datetime, timedelta, timezone

from s2d import db as _sqlite_store

# Only "sqlite" exists today. A future backend (e.g. "postgres") would add its
# own module implementing the same function names used below and get
# selected here - actual implementation is deliberately not started until
# the production database is decided.
STORAGE_BACKEND = "sqlite"

RETENTION_DAYS = 20

if STORAGE_BACKEND == "sqlite":
    create_run = _sqlite_store.create_run
    add_result = _sqlite_store.add_result
    get_run = _sqlite_store.get_run
    analytics_results = _sqlite_store.analytics_results
    analytics_runs = _sqlite_store.analytics_runs
    analytics_orphaned_run_count = _sqlite_store.analytics_orphaned_run_count
    list_runs = _sqlite_store.list_runs
    _prune_before = _sqlite_store.prune_test_runs_before
else:
    raise RuntimeError(f"Unknown STORAGE_BACKEND: {STORAGE_BACKEND!r}")


def prune_older_than_days(days=RETENTION_DAYS):
    """Deletes every test run (and its results) older than `days` days. Returns the count deleted."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    return _prune_before(cutoff)
