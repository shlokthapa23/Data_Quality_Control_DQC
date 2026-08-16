## SESSION START
 
1. Read tasks/lessons.md — apply all lessons before touching anything
2. Read tasks/todo.md — understand current state
3. If neither exists, create them before starting
 
## WORKFLOW
 
### 1. Plan First
 
- Enter plan mode for any non-trivial task (3+ steps)
- Write plan to tasks/todo.md before implementing
- If something goes wrong, STOP and re-plan — never push through
 
### 2. Subagent Strategy
 
- Use subagents to keep main context clean
- One task per subagent
- Throw more compute at hard problems
 
### 3. Self-Improvement Loop
 
- After any correction: update tasks/lessons.md
- Format: [date] | what went wrong | rule to prevent it
- Review lessons at every session start
 
### 4. Verification Standard
 
- Never mark complete without proving it works
- Run tests, check logs, diff behavior
- Ask: "Would a staff engineer approve this?"
 
### 5. Demand Elegance
 
- For non-trivial changes: is there a more elegant solution?
- If a fix feels hacky: rebuild it properly
- Don't over-engineer simple things
 
### 6. Autonomous Bug Fixing
 
- When given a bug: just fix it
- Go to logs, find root cause, resolve it
- No hand-holding needed
 
## CORE PRINCIPLES
 
- Simplicity First — touch minimal code
- No Laziness — root causes only, no temp fixes
- Never Assume — verify paths, APIs, variables before using
- Ask Once — one question upfront if unclear, never interrupt mid-task
 
## TASK MANAGEMENT
 
1. Plan → tasks/todo.md
2. Verify → confirm before implementing
3. Track → mark complete as you go
4. Explain → high-level summary each step
5. Learn → tasks/lessons.md after corrections
 
## LEARNED

- **Effects that clear one-shot/handoff state must not do so in the same pass that consumes it.** React 18 StrictMode double-mounts in dev; clearing a trigger right after reading it means the throwaway first mount eats it before the real mount runs. Clear it only on an unambiguous, unrelated user action instead.
- **Lint errors are real signal, not noise** — `no-use-before-define`, etc. have caught genuine ordering bugs in this codebase. Fix by reordering/restructuring, never by suppressing.
- **Schema migrations are additive-only.** `ALTER TABLE ADD COLUMN` + backfill. Never drop-and-recreate for a shape change — rejected outright once already, don't reintroduce it.
- **Never assume "the first item the API returns" is disposable test fixture material**, especially mid-session while the user is doing real work in parallel. Print the full list, read names, and build a dedicated obviously-named throwaway object for any destructive verification.
- **Verification means proving it against real data**, not just a clean compile/lint pass — curl the live route, check the actual DB rows, or drive the real browser session before marking a feature done.
- **One SQL dialect everywhere: DuckDB.** Local runs it directly, Fabric through the mssql extension. `TOP`, `GETDATE()`, `ISNULL()` and `+` on strings all fail — use `LIMIT` and `||`. Verify example/placeholder SQL actually runs.
- **Never combine multiple aggregates into one statement against Fabric.** DuckDB's mssql extension mis-pushes them and returns silently wrong numbers (a 4-arm `UNION ALL` of `COUNT(*)` repeated arms 1–2 in place of 3–4). One aggregate per query, on the already-open connection — the connection is the expensive part, not the query. Row-level unions are unaffected.
- **On a live workspace, take both readings in the same moment.** The user runs pipelines mid-session, so row counts change between two calls; a mismatch is only a bug when two back-to-back truth reads agree with each other and disagree with the value. This has produced false alarms *and* a nearly-missed real bug.
- **When a test fails, check the test before the code** — several "failures" this session were bad assertions, wrong wait times, or a lifecycle simulation that didn't actually simulate anything (`init_scheduler()` early-returns, so calling it twice proves nothing about restarts). Browser text also needs case-insensitive matching: CSS `uppercase` changes `innerText`.
- **`??` not `||` for numerics that can be `0`** — `0` is falsy, and the zero case (an empty table, a zero count) is usually the one worth showing.
- **Normalise at the edge, not in the query layer.** Every uploaded file — csv, tsv, txt, json, ndjson, parquet, xml — becomes an ordinary DuckDB table at ingest, which is what lets ONE SQL dialect test all of them and why adding four formats needed no engine, connector or test-case change. Nested data flattens to dotted columns (`"a.b.c"`); arrays become JSON text. `.xlsx` is unsupported (needs the uninstalled `excel` extension).
- **Line endings are per file, not per repo** — `TestCasePanel.jsx` is CRLF while most files are LF. Scripted edits must detect the file's own ending and write with `newline=''`, or they match nothing or rewrite every line.
- **Additive-only vs `NOT NULL`**: when a column must be absent but is `NOT NULL`, store an empty value and treat empty as absent. Never rebuild the table.
- **Schedule kinds have no central registry.** `s2d_db.SCHEDULE_TABLES` is the one dispatch dict; a new kind also needs its own `init_scheduler` re-registration loop, routes, `api.js` block and dashboard table. Three of those spots fail *silently* if missed.
- Full lesson-by-lesson detail lives in `tasks/lessons.md` — read it every session start, this section is just the durable rollup.