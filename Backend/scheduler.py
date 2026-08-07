"""
In-process scheduling for suite runs and harvest metadata refreshes.

Owned by app.py: init_scheduler() is called once on Flask startup (guarded by
WERKZEUG_RUN_MAIN so the debug reloader doesn't spawn two schedulers).
Everything else in this module is helpers that app.py routes call when
schedules are created / updated / deleted.

The scheduler is defensive against overrun and outages:
- max_instances=1: a running suite blocks its own next fire (no stacking).
- coalesce=True: multiple missed fires collapse into ONE catch-up run when
  the slot opens, so a 6-hour outage doesn't produce 24 back-to-back runs.
- misfire_grace_time=1800: fires older than 30 min count as missed and are
  logged (not silently dropped).

Job IDs follow "suite:<schedule_id>" / "harvest:<schedule_id>" so the
misfire listener can figure out which schedule to bump.
"""

import logging
import threading
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.events import EVENT_JOB_MISSED

from s2d import db as s2d_db
from s2d.engine import run_suite
from catalog import db as catalog_db
from connector_factory import build_connector
from harvest import run_harvest


log = logging.getLogger(__name__)

_scheduler = None
_scheduler_lock = threading.Lock()

DEFAULT_MISFIRE_GRACE_SECONDS = 30 * 60


def get_scheduler():
    return _scheduler


def _build_trigger(trigger_type, trigger_config, timezone_name):
    if trigger_type == "cron":
        expr = trigger_config["expression"]
        tz = ZoneInfo(timezone_name) if timezone_name else ZoneInfo("UTC")
        return CronTrigger.from_crontab(expr, timezone=tz)
    if trigger_type == "interval":
        seconds = int(trigger_config["seconds"])
        return IntervalTrigger(seconds=seconds)
    raise ValueError(f"Unknown trigger_type: {trigger_type!r}")


def compute_next_fires(trigger_type, trigger_config, timezone_name, count=3):
    """Read-only: preview the next N fire times for a would-be schedule."""
    trigger = _build_trigger(trigger_type, trigger_config, timezone_name)
    fires = []
    prev = None
    now = datetime.now(timezone.utc)
    for _ in range(count):
        nxt = trigger.get_next_fire_time(prev, now)
        if nxt is None:
            break
        fires.append(nxt)
        # Advance BOTH the "previous fire" cursor and the "now" cursor past
        # this fire, otherwise the next iteration returns the same value
        # (cron especially: without moving `now`, it picks the same next fire).
        prev = nxt
        now = nxt
    return fires


def init_scheduler():
    """Start the scheduler and register all active schedules from the DB."""
    global _scheduler
    with _scheduler_lock:
        if _scheduler is not None:
            return _scheduler
        scheduler = BackgroundScheduler(
            job_defaults={
                "max_instances": 1,
                "coalesce": True,
                "misfire_grace_time": DEFAULT_MISFIRE_GRACE_SECONDS,
            }
        )
        scheduler.add_listener(_on_job_missed, EVENT_JOB_MISSED)
        scheduler.start()
        _scheduler = scheduler

    # Re-register active schedules from the DB
    for row in s2d_db.list_suite_schedules():
        if row.get("active"):
            try:
                add_suite_schedule_job(row)
            except Exception as e:
                log.error("Failed to register suite schedule %s: %s", row["id"], e)
    for row in s2d_db.list_harvest_schedules():
        if row.get("active"):
            try:
                add_harvest_schedule_job(row)
            except Exception as e:
                log.error("Failed to register harvest schedule %s: %s", row["id"], e)

    log.info("Scheduler started with %d jobs", len(_scheduler.get_jobs()))
    return _scheduler


# --- Suite jobs -------------------------------------------------------------

def _suite_job_id(schedule_id):
    return f"suite:{schedule_id}"


def add_suite_schedule_job(schedule_row):
    if _scheduler is None:
        return
    trigger = _build_trigger(
        schedule_row["trigger_type"], schedule_row["trigger_config"], schedule_row.get("timezone") or "UTC"
    )
    _scheduler.add_job(
        _run_suite_job,
        trigger=trigger,
        id=_suite_job_id(schedule_row["id"]),
        args=[schedule_row["id"]],
        replace_existing=True,
    )


def remove_suite_schedule_job(schedule_id):
    if _scheduler is None:
        return
    try:
        _scheduler.remove_job(_suite_job_id(schedule_id))
    except Exception:
        pass


def _run_suite_job(schedule_id):
    """Fires when a suite schedule is due. Same code path as the manual run route."""
    schedule = s2d_db.get_suite_schedule(schedule_id)
    if not schedule:
        log.warning("Suite schedule %s vanished before firing", schedule_id)
        return

    suite = s2d_db.get_suite(schedule["suite_id"])
    if not suite or not suite.get("mapping"):
        msg = "Suite or its mapping no longer exists"
        s2d_db.touch_suite_schedule(schedule_id, "errored")
        s2d_db.record_schedule_event("suite", schedule_id, "errored", message=msg)
        return

    active_test_cases = [tc for tc in suite["test_cases"] if tc.get("active")]
    if not active_test_cases:
        msg = "Suite has no active test cases"
        s2d_db.touch_suite_schedule(schedule_id, "errored")
        s2d_db.record_schedule_event("suite", schedule_id, "errored", message=msg)
        return

    mapping = suite["mapping"]
    try:
        source_config = catalog_db.get_connector_config(mapping["source_connector_id"])
        destination_config = catalog_db.get_connector_config(mapping["destination_connector_id"])
        if not source_config or not destination_config:
            raise KeyError("Connector config missing")
        source_connector = build_connector(source_config)
        destination_connector = build_connector(destination_config)
        run_id = run_suite(source_connector, destination_connector, mapping, schedule["suite_id"], active_test_cases)
        s2d_db.touch_suite_schedule(schedule_id, "ran", last_run_id=run_id)
        s2d_db.record_schedule_event("suite", schedule_id, "ran", run_id=run_id)
    except Exception as e:
        log.exception("Suite schedule %s errored", schedule_id)
        s2d_db.touch_suite_schedule(schedule_id, "errored")
        s2d_db.record_schedule_event("suite", schedule_id, "errored", message=str(e))


# --- Harvest jobs -----------------------------------------------------------

def _harvest_job_id(schedule_id):
    return f"harvest:{schedule_id}"


def add_harvest_schedule_job(schedule_row):
    if _scheduler is None:
        return
    trigger = _build_trigger(
        schedule_row["trigger_type"], schedule_row["trigger_config"], schedule_row.get("timezone") or "UTC"
    )
    _scheduler.add_job(
        _run_harvest_job,
        trigger=trigger,
        id=_harvest_job_id(schedule_row["id"]),
        args=[schedule_row["id"]],
        replace_existing=True,
    )


def remove_harvest_schedule_job(schedule_id):
    if _scheduler is None:
        return
    try:
        _scheduler.remove_job(_harvest_job_id(schedule_id))
    except Exception:
        pass


def _run_harvest_job(schedule_id):
    """Fires when a harvest schedule is due. Uses the item selection frozen at
    schedule-creation time (only those assets get harvested). Legacy rows with
    a NULL selected_items fall back to "everything the connector sees" for
    backward compatibility, but new schedules always store an explicit list."""
    schedule = s2d_db.get_harvest_schedule(schedule_id)
    if not schedule:
        log.warning("Harvest schedule %s vanished before firing", schedule_id)
        return

    try:
        config = catalog_db.get_connector_config(schedule["connector_id"])
        if not config:
            raise KeyError(f"Connector {schedule['connector_id']} not found")
        connector = build_connector(config)

        selected_items = schedule.get("selected_items")
        if selected_items:
            # Frozen snapshot from schedule creation — the user's chosen assets.
            selected = [
                {"id": it.get("id"), "name": it.get("name"), "type": it.get("type")}
                for it in selected_items
                if it.get("id") and it.get("type")
            ]
        else:
            # Legacy fallback: harvest everything the connector reports now.
            items = connector.list_items()
            selected = []
            for it in items or []:
                d = {
                    "id": getattr(it, "id", None) if hasattr(it, "__dict__") else it.get("id") if isinstance(it, dict) else None,
                    "name": getattr(it, "name", None) if hasattr(it, "__dict__") else it.get("name") if isinstance(it, dict) else None,
                    "type": getattr(it, "type", None) if hasattr(it, "__dict__") else it.get("type") if isinstance(it, dict) else None,
                }
                if d["id"] and d["type"]:
                    selected.append(d)

        if not selected:
            msg = "Nothing to harvest — the schedule's selection is empty"
            s2d_db.touch_harvest_schedule(schedule_id, "ran")
            s2d_db.record_schedule_event("harvest", schedule_id, "ran", message=msg)
            return

        result = run_harvest(connector, schedule["connector_id"], config["name"], selected, mode=schedule.get("mode") or "incremental")
        n_harvested = len(result.get("harvested", []))
        n_errors = len(result.get("errors", []))
        message = f"harvested {n_harvested}/{len(selected)} items ({n_errors} errors)"
        s2d_db.touch_harvest_schedule(schedule_id, "ran")
        s2d_db.record_schedule_event("harvest", schedule_id, "ran", message=message)
    except Exception as e:
        log.exception("Harvest schedule %s errored", schedule_id)
        s2d_db.touch_harvest_schedule(schedule_id, "errored")
        s2d_db.record_schedule_event("harvest", schedule_id, "errored", message=str(e))


# --- Misfire listener -------------------------------------------------------

def _on_job_missed(event):
    """Record when APScheduler decides a fire was too late to bother with."""
    job_id = event.job_id or ""
    if ":" not in job_id:
        return
    kind, _, schedule_id = job_id.partition(":")
    if kind not in ("suite", "harvest"):
        return
    try:
        s2d_db.bump_schedule_misfire(kind, schedule_id)
        s2d_db.record_schedule_event(kind, schedule_id, "missed",
                                     message="APScheduler dropped a fire (grace time exceeded)")
    except Exception:
        log.exception("Failed to log misfire for %s", job_id)
