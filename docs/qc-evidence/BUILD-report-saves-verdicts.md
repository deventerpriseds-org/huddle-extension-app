# BUILD: the action-scan report saves its AI verdicts into the Actions view's store

WHAT:          Build notes for branch `claude_report-saves-verdicts` (base `claude_actions-all-time-catchup` @ 76043a49).
WHY:           Owner-approved 2026-11-17: the step=action HTML report must SAVE its verdicts into the store the in-app
               Actions view reads, so (1) the view shows what the report found and (2) no AI call is spent twice on a
               thread that already has a current verdict.
SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; the tests named below; the live runs recorded at the bottom.

PUBLIC REPO: counts only in this file. No names, addresses, ids or message content.

## Baseline (before any change, base 76043a49)

| suite | result |
|---|---|
| `bun scripts/actions-accuracy.test.ts` | 60 passed, 0 failed |
| `bun scripts/actions-view.test.ts` | 96 passed, 0 failed |
| `bun scripts/actions-view-server.test.ts` (real local PostgreSQL) | 28 passed, 0 failed |

## Facts re-checked by reading the code (this session)

- The report's step=action path (`scripts/action-scan-steps.ts runActionScan`) had its OWN classify loop: it called
  `callOpenAIRouter` directly, checked the quote with `quoteIsVerbatim` for DISPLAY only, and stored nothing.
- The app's pass is `runClassify` (pipeline.ts). It takes the units from `threadUnits`, skips `judged` keys
  (`currentlyJudgedKeys` = same key AND current `CLASSIFIER_INPUT_VERSION`), records the attempt BEFORE the call
  (`recordCall`, counted by the daily cap), admits through `admitActionVerdict` (verbatim quote + settled guard),
  backs an open item with a proposal (`propose` -> EXISTING `proposeFromSource`), and stores via `storeVerdict`
  on `chat.correspondence_ledger.result_ids.action` of the thread's latest message row.
- Real deps were built INLINE inside `runActionsClassify` (actions.server.ts) -- not reusable as they stood.
- `assembleLedgerPlan(data, cfg, sinceMs)` builds the same plan the report built by hand (same helpers), with the
  window as a parameter, so the report can use its own window (since 2026-11-09) through the app's own assembly.
- Daily cap default is 500 (`DAILY_CAP_DEFAULT`), so a ~144-call report fits inside it.

## Design (extend, don't duplicate)

Chosen route: the report RUNS THE APP'S OWN PASS. Nothing about the classifier is copied.

```
report (step=action, source=ledger)
  -> actions.server.ts runReportPassFor(cfg, sinceMs, maxCalls, save)          [binds real deps]
       -> assembleLedgerPlan(data, cfg, sinceMs)                               [app's plan, report's window]
       -> pipeline.ts runReportClassify(...)                                   [pure orchestration]
            judged     = currentlyJudgedKeys(stored verdicts)                  [same skip rule as heartbeat]
            callsLeft  = classifyCallsLeft(usedToday, dailyCap, maxCalls)      [same cap rule]
            runClassify(..., concurrency 5)                                    [same admission + store]
            verdicts   = loadVerdicts() again                                  [read back from the store]
  -> scripts/action-report-html.ts rowsFromStoredVerdicts + renderActionReportHtml   [HTML FROM THE STORE]
  -> OneDrive file (+ email when asked)                                        [unchanged output]
```

- One admission path (`admitActionVerdict` inside `runClassify`), one key scheme (`threadUnits` item keys), one store
  (`result_ids.action`), one cap count (`recordActionCall` / `actionCallsToday`).
- Switch: workflow input `save_verdicts` (default true) -> `PREVIEW_SAVE`. OFF = the SAME `runClassify`, but its
  verdict / proposal / meeting-row writes go to memory only [CORRECTED loop 1: the attempt record is still written,
  so AI calls still count toward today's limit]; it still READS the stored verdicts, so already-judged threads
  still cost 0 calls.
- `source=files` cannot save (no ledger rows to store on): the old loop is kept for that comparison path only and
  says so in the log.
- Spend: report-run calls are recorded as attempts exactly like in-app calls, so they count toward the owner's daily
  cap, AND the report is bounded by what the cap has left (min(max_sources, cap left)) -- one cap rule.

## Progress log

### Chunk 1 -- wiring (commit 53978ead)

- `pipeline.ts`: `runReportClassify` (pure orchestration: stored verdicts -> `currentlyJudgedKeys` -> `classifyCallsLeft`
  -> `runClassify` with concurrency 5 -> verdicts re-read) and `inMemoryWrites` (save OFF).
- `actions.server.ts`: the real deps factored out of `runActionsClassify` into `classifyDepsFor` (heartbeat behaviour
  unchanged: same deps, same 20s deadline, concurrency still 1); `loadVerdicts` exported; `runReportPassFor(cfg, ...)`.
- `scripts/action-report-html.ts` (new, pure): the report HTML moved out of `action-scan-steps.ts`, plus
  `rowsFromStoredVerdicts` (only CURRENT verdicts; only `open`/`none` are rows; a not-admitted answer is listed as
  not checked, never as open -- the old report showed it as an open row marked "quote not found").
- `scripts/action-scan-steps.ts`: `runStoredActionScan` (ledger path); the old loop stays for `source=files` only.
- `scripts/reply-scan-preview.ts`: step=action + ledger branches to `runStoredActionScan` before its own load.
  `PREVIEW_STEP=reply` untouched.
- Workflow: input `save_verdicts` (boolean, default true) -> `PREVIEW_SAVE`.

Behaviour differences vs the old report, all because it now IS the app's pass:
1. CC/list conversations the owner already answered used to be skipped before the model; the app's pass judges them
   (its settled guard then decides). Expect a few more calls on the FIRST run than the old report's 144.
2. Sources and the uninvolved-chat switch come from the owner's Actions settings (what the view covers).
3. Meeting items: the app pass also adds the EXISTING untriaged meeting triage rows for in-window meetings (idempotent
   by ref) -- exactly what the heartbeat does. Skipped when save is OFF.
4. Save OFF still RECORDS the attempt (spend is spend); it writes no verdict, proposal or meeting row.

### Chunk 2 -- tests (commit f9ab65c5) + mutation proofs

`bun scripts/report-saves-verdicts.test.ts`: **19 passed, 0 failed** (fake model + fake store, synthetic data).

| guard | test | mutation (mutate.sh, anchors in files) | verdict |
|---|---|---|---|
| report skips already-judged threads | RB-2 | `judged = currentlyJudgedKeys(before)` -> empty set | FIRED (control EQUIVALENT), exit 0 |
| report bounded by the daily cap's remainder | RB-4 | `classifyCallsLeft(...)` -> `maxCalls` only | FIRED (control EQUIVALENT), exit 0 |
| HTML uses only CURRENT verdicts | RC-5 | `verdictIsCurrent(...)` check removed | FIRED (control EQUIVALENT), exit 0 |
| not-admitted answers never rendered as rows | RC-6 | status filter -> bad_shape only | FIRED (control EQUIVALENT), exit 0 |
| only stored `open` is a YES | RC-2 | `yes: v.status === "open"` -> `yes: true` | FIRED (control EQUIVALENT), exit 0 |
| report-path verdicts go through the verbatim guard | RA-1 | haystack widened to include the model's own quote | FIRED (control EQUIVALENT), exit 0 |
| save OFF writes nothing to the store | RB-6 | in-memory `storeVerdict` -> real `storeVerdict` | FIRED (control EQUIVALENT), exit 0 |

All seven restores asserted against HEAD by mutate.sh.

Suites after the change: actions-accuracy 60/0, actions-view 96/0, actions-view-server (real local PostgreSQL)
28/0, report-saves-verdicts 19/0. `npx tsc --noEmit`: 0 errors (src). The touched scripts (outside tsconfig's
include) type-checked with a temporary config that adds them: 0 errors.


### Live runs (proposals-preview.yml, ref = this branch @ 3931449c, step=action, since 2026-11-09T05:00Z, email off, save on)

Counts read from the job logs (public-safe lines only).

| | run 1 (44092073096) | run 2 (44092659832) |
|---|---|---|
| conclusion | success | success |
| model calls | **0** | **0** |
| already judged (0 calls) | 139 | 140 |
| verdicts stored this run (open / none / not_checked) | 0 / 0 / 0 | 0 / 0 / 0 |
| failures / over cap | 0 / 0 | 0 / 0 |
| report rows read FROM THE STORE: open / none / not checked | 73 / 55 / 11 | 73 / 56 / 11 |
| of the not checked: AI answer not admitted (quote not found) | 11 | 11 |
| used today (owner's daily cap 500): before -> after | 127 -> 127 | 128 -> 128 |
| uninvolved chats skipped / meeting rows added | 9 / 0 | 9 / 0 |
| OneDrive file | HTTP 201 | HTTP 201 |

Reading of it:
- **Run 1 already cost 0 calls.** By the time it ran, the in-app heartbeat (127 attempts recorded today) had judged
  every in-scope thread, so the report's pass skipped all 139 through the SAME `currentlyJudgedKeys` rule. That is
  goal (2) observed live: no AI call spent twice. The "first run makes ~144 calls" picture from the old report did not
  occur, because the old report never read the store.
- **Run 2: 0 calls again.** One more thread appeared between the runs; it was judged by the heartbeat (used today
  127 -> 128), not by the report, and the report then read its verdict from the store (140 judged, none 55 -> 56).
- The report's rows are the store's: 73 open + 55/56 none + 11 not admitted = the units the Actions view covers.
- **Not exercised live:** a report run that actually WRITES verdicts (there was nothing unjudged to write). The write
  path is the heartbeat's own `storeVerdict` / `recordActionCall` / `proposeFromSource`, unchanged and already in
  production, and the report-path wiring around it is covered offline (RA-*, RB-*). The first live write will happen
  on the first report run that finds a thread the heartbeat has not judged yet.
- Observation for the owner (not changed here): the 11 "not admitted" verdicts are stored `not_checked` and count as
  judged, so neither the heartbeat nor the report re-asks them -- that is the app's existing rule.

## Verifier loop 1 (VERIFY-report-saves-verdicts-1 on claude_verify-report-saves-verdicts-a5d3: FIX FIRST) -- fixes

- **Fix 5 (unused WIP exports):** removed `heartbeatPassShape`, `HEARTBEAT_BACKLOG_PER_PASS`, `CATCHUP_CHUNK_BUDGET_MS`,
  `CATCHUP_TOTAL_MS`, `CatchUpStop`, `catchUpStopReason`, `catchUpContinue` from pipeline.ts (grep: no consumer).
  Kept `concurrency` in runClassify, `CLASSIFY_PARALLEL`, `pendingUnitCount` and the `unchecked`/`preview` fields
  (the parallel catch-up branch uses them). tsc 0 errors; actions-view 96/0, actions-accuracy 60/0, report 19/0.
- **Fix 6 (ledgers):** `.claude/memory.md` entry + `.claude/actions.md` row ACT:report-saves-verdicts.
- **Fix 1 (sorting off):** `runReportClassify` takes `sortingOn` (= `classifyEnabled(settings, true)`, the heartbeat's
  own switch, required parameter). Off -> no `runClassify` at all: 0 model calls, 0 attempts, 0 proposals, 0 meeting
  rows; the report renders only the verdicts already stored and says so (log + HTML). Tests RS-1..RS-3.
- **Fix 2 (save-off wording):** workflow input, log line and HTML now say "verdicts are not saved; AI calls still count
  toward today's limit". Attempts are still recorded. Comments in action-scan-steps.ts / reply-scan-preview.ts and the
  Design section above corrected the same way.
- **Fix 4 (maxCalls guard):** a non-finite or non-positive `maxCalls` is 0 in `runReportClassify`; `runClassify` also
  treats a non-finite allowance as 0 (NaN used to make every batch empty and loop forever). Tests RM-1 (NaN, -3,
  +Infinity, -Infinity -> callsLeft 0, 0 calls, returns) and RM-2 (runClassify with NaN returns).
- **Fix 3 (AC8, one proposal per thread):** `ClassifyDeps.lockThread` (optional). The real one (`withThreadLock`,
  actions.server.ts) opens a transaction, takes `pg_advisory_xact_lock(hashtextextended('actions-thread:'||itemKey, 0))`,
  re-reads the thread's stored verdict INSIDE that transaction (`tx.current()`), and stores there (`tx.store()`).
  `runClassify` runs propose + store inside it; a pass that finds a CURRENT verdict already stored (the other pass won
  while it waited) writes nothing and counts the thread as already judged. Lock holders per process are capped at
  `SHARED_POOL_MAX - 3` (5), because each holds one pooled connection while its proposal write needs another: the
  pool can never be filled with lock holders waiting on themselves. Save-off (`inMemoryWrites`) drops the lock, since
  `tx.store` writes the real store. Tests: AC8-S1 (real local PostgreSQL, real deps, model faked, both answers
  released together: 2 calls, 1 proposal, 1 open + 1 adopted, the stored verdict points at that proposal, 0 failures),
  RL-1 (offline lock, 1 proposal), RL-2 (save off never enters the lock).
- Cost of the adopt path: the second pass's model call is still spent (it was made before the lock); only its
  duplicate proposal and verdict are avoided.

### Mutation proofs, loop-1 fixes (mutate.sh, anchors in files, every restore asserted against HEAD)

| guard | test | mutation | verdict |
|---|---|---|---|
| sorting off stops the report | RS-1 | `if (!a.sortingOn)` -> `if (false && !a.sortingOn)` | FIRED (control EQUIVALENT), exit 0 |
| maxCalls sanitised | RM-1 (NaN) | finite check removed (`Math.max(0, Math.floor(maxCalls))`) | FIRED (control EQUIVALENT), exit 0 |
| runClassify never loops on NaN | RM-2 | `limit = callsLeft` | FIRED (control EQUIVALENT), exit 0 (the hang is caught by a 60 s timeout wrapper that names RM-2) |
| the lock is used | AC8-S1 (real PG) | `lockThread ? lockThread(u, finish) : finish()` -> `finish()` | FIRED (control EQUIVALENT), exit 0 |
| the in-transaction check | AC8-S1 (real PG) | `if (cur && verdictIsCurrent(...)) return "adopted"` removed | FIRED (control EQUIVALENT), exit 0 |
| the DB advisory lock itself | AC8-S1 (real PG) | `pg_advisory_xact_lock(...)` -> `SELECT 1` | FIRED (control EQUIVALENT), exit 0 |
| save off drops the lock | RL-2 | `lockThread: undefined` removed | FIRED (control EQUIVALENT), exit 0 |
| the lock is used (offline) | RL-1 | as AC8-S1 row 1 | FIRED (control EQUIVALENT), exit 0 |

### Suites after the loop-1 fixes

| suite | result |
|---|---|
| `bun scripts/report-saves-verdicts.test.ts` | 29 passed, 0 failed |
| `bun scripts/actions-accuracy.test.ts` | 60 passed, 0 failed |
| `bun scripts/actions-view.test.ts` | 96 passed, 0 failed |
| `bun scripts/actions-view-server.test.ts` (real local PostgreSQL) | 29 passed, 0 failed |
| verifier's adversarial file (VERIFY-...-1.adversarial, `sortingOn: true` added to its calls; path pointed here) | 22 passed, 0 failed; its V5-4 NaN probe now returns ("done calls=0") instead of hanging |
| `npx tsc --noEmit` | exit 0 |
| tsc with a temporary config adding the touched scripts | exit 0 |
