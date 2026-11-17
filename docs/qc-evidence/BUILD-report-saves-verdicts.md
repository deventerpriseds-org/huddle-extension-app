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

