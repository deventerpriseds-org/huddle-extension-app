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
  store / propose / recordCall write to memory only; it still READS the stored verdicts, so already-judged threads
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

