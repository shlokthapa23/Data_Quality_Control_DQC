# Lessons Learned

Format: `[YYYY-MM-DD]` | what went wrong | rule to prevent it

Reviewed at every session start. Applied before touching anything.

---

## Carried forward from HANDOFF.md (pre-2026-07)

- **[pre-2026-07]** | Flask `debug=True` auto-reloader can execute half-saved migration code against live `catalog.db`, corrupting rows | Write `s2d/db.py` migrations correct in ONE edit; if forced to iterate, immediately verify + repair data via a direct sqlite3 check.
- **[pre-2026-07]** | Browser-automation `form_input` on a checkbox sets the DOM `.checked` without firing React `onChange`, so state stays stale | For controlled checkboxes, dispatch a native `click()` via `javascript_tool`; never use `form_input`.
- **[pre-2026-07]** | Two schema-fetching `useEffect`s in `TestCasePanel.jsx` had a race: switching mappings quickly let a stale fetch resolve after a newer one and overwrite state with the wrong mapping's schema | For any effect that fetches per-selection data, use a `cancelled` flag + cleanup function.
- **[pre-2026-07]** | Destructive drop-and-recreate migrations (`_migrate_stale_schema_if_needed` pattern) risk data loss and were rejected by the user | Schema migrations must be additive: `ALTER TABLE ADD COLUMN` + backfill from old columns. Never drop-and-recreate for a shape change.

## 2026-08-05

- **[2026-08-05]** | A cross-page "focus" handoff (App.jsx `s2dFocus` → S2DPage → TestCasePanel, used by Test Suites' "Edit Suite"/"Edit test case" buttons) worked in isolated logic review but silently failed in the browser: the effect that consumed `focus` also called a callback to clear it in the parent immediately after acting. Under React 18 StrictMode's dev-only double-mount check (mount → cleanup → remount, to verify effects are safely re-runnable), the first throwaway mount's effect cleared the parent's trigger before the second real mount could see it — so the real mount had nothing left to act on. | Any state meant to survive a component being torn down and rebuilt (cross-page handoffs, one-shot "do X then reset" triggers) must NOT be cleared by the same effect that consumes it. Clear it only on an unambiguous, unrelated user action (here: `goToPage`, i.e. any manual sidebar nav) so a StrictMode remount of the subtree sees the identical trigger value both times and produces the identical result — true idempotency, not just "runs without crashing twice."
- **[2026-08-05]** | Added a `useEffect` that referenced `startEdit`/`enterSuiteSelection`/`loadSuiteMembers` (consts defined later in the same component) before their declaration lines. It's actually safe at runtime — the effect callback only executes after the full render function has finished, by which point all consts are assigned — but ESLint's `no-use-before-define` check is purely static and doesn't know that, so it correctly flagged it as a real lint error, not a false positive. | When an effect needs to call handlers defined later in a large component, physically move the effect below those handlers' declarations rather than reaching for a suppression comment — the static-ordering rule is enforcing a real readability property even when the runtime behavior is safe.

## 2026-08-06

- **[2026-08-06]** | While setting up a fixture to verify cascade-delete, grabbed `mappings[0]` from the live API to attach a throwaway test suite + schedule to — turned out to be "D to source," the user's real, current, in-progress mapping (built around freshly-uploaded Kaggle data), not leftover test data. Caught it by checking the mapping list again before running the actual destructive delete, and cleaned up the attached suite/schedule without touching the mapping itself. | Before attaching anything to "the first mapping/connector/whatever the API returns" for test-fixture purposes, print the full list and read the names — never assume index 0 is disposable, especially in a session where the user has been actively doing real work between turns. For genuinely destructive verification (deleting a mapping to prove cascade behavior), always build a dedicated, obviously-named throwaway object first rather than repurposing anything that already exists.
