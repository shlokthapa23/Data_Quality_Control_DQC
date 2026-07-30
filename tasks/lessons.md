# Lessons Learned

Format: `[YYYY-MM-DD]` | what went wrong | rule to prevent it

Reviewed at every session start. Applied before touching anything.

---

## Carried forward from HANDOFF.md (pre-2026-07)

- **[pre-2026-07]** | Flask `debug=True` auto-reloader can execute half-saved migration code against live `catalog.db`, corrupting rows | Write `s2d/db.py` migrations correct in ONE edit; if forced to iterate, immediately verify + repair data via a direct sqlite3 check.
- **[pre-2026-07]** | Browser-automation `form_input` on a checkbox sets the DOM `.checked` without firing React `onChange`, so state stays stale | For controlled checkboxes, dispatch a native `click()` via `javascript_tool`; never use `form_input`.
- **[pre-2026-07]** | Two schema-fetching `useEffect`s in `TestCasePanel.jsx` had a race: switching mappings quickly let a stale fetch resolve after a newer one and overwrite state with the wrong mapping's schema | For any effect that fetches per-selection data, use a `cancelled` flag + cleanup function.
- **[pre-2026-07]** | Destructive drop-and-recreate migrations (`_migrate_stale_schema_if_needed` pattern) risk data loss and were rejected by the user | Schema migrations must be additive: `ALTER TABLE ADD COLUMN` + backfill from old columns. Never drop-and-recreate for a shape change.
