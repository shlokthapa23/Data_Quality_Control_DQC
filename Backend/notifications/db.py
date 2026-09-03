from datetime import datetime, timezone

from catalog.db import get_conn, autoincrement_pk  # same shared catalog.db every other module uses

# Deliberately NOT scoped per-user or per-organization: this app's data model
# has no organization_id on connectors/mappings/schedules to scope against
# (only auth's users/organizations tables carry it), and schedule jobs fire
# from a background scheduler thread with no request/current_user context at
# all - there's no user to attribute a "schedule fired" notification to
# without a much bigger change. Every notification is visible to every
# logged-in user for now; "read" state is tracked client-side (a
# last-seen-timestamp in localStorage), not per-user server-side, for the
# same reason.


def init_notifications_table():
    with get_conn() as conn:
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS notifications (
                id {autoincrement_pk()},
                type TEXT NOT NULL,        -- 'schedule_fired' | 'suite_run' | 'test_data_inserted' | ...
                message TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)


def record_notification(type_, message):
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO notifications (type, message, created_at) VALUES (?, ?, ?)",
            (type_, message, now),
        )


def list_notifications(limit=50):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, type, message, created_at FROM notifications ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
