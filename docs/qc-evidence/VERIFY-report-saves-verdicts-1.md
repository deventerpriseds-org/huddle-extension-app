# VERIFY: report-saves-verdicts, loop 1

WHAT:          Independent verification of branch `claude_report-saves-verdicts` @ 543df6af against origin/main @ 23c04496.
WHY:           Owner-approved change: the step=action report must run the app's own classify pass and render from stored verdicts.
SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file (written per claim as each lands).

PUBLIC REPO: counts only. No names, addresses, ids or message content.

Note on the branch: a second verifier worktree already holds the local branch name `claude_verify-report-saves-verdicts`
(not pushed when this pass started, 13:31Z). To avoid two agents writing one branch, this pass pushes to
`claude_verify-report-saves-verdicts-a5d3`.

Note on scope: origin/main..543df6af contains 5 commits, the first being the UNMERGED WIP base `76043a49`
("All time catch-up ... server half", branch `claude_actions-all-time-catchup`). Merging this branch also lands that WIP.

## Suites (re-run by this pass, worktree @ 543df6af)

| command | result |
|---|---|
| `bun scripts/report-saves-verdicts.test.ts` | 19 passed, 0 failed, exit 0 |
| `bun scripts/actions-accuracy.test.ts` | 60 passed, 0 failed, exit 0 |
| `bun scripts/actions-view.test.ts` | 96 passed, 0 failed, exit 0 |
| `bun scripts/actions-view-server.test.ts` (throwaway local PostgreSQL) | 28 passed, 0 failed, exit 0 |
| `npx tsc --noEmit` | exit 0, 0 errors |
| tsc with a temp config adding the 4 touched scripts | exit 0, 0 errors |
| verifier's own adversarial file (`VERIFY-report-saves-verdicts-1.adversarial.test.ts.txt`, synthetic) | 22 passed, 0 failed |

## Results per AC

### AC1 -- one admission path: CONFIRMED
- Read: `runReportClassify` calls `runClassify` (the heartbeat's function); with save ON its deps are `classifyDepsFor`,
  the exact deps factored out of `runActionsClassify` (heartbeat now calls the same factory). `admitActionVerdict` +
  `quoteIsVerbatim` + `settledGuard` run inside `runClassify`; `propose` only runs when the admitted status is `open`.
- Builder tests RA-1..RA-4 pass. Verifier adds: V1-1 Teams paraphrased quote -> stored `not_checked/quote_not_found`,
  0 proposals; V1-2 it is not a report row (listed not checked, counted not admitted); V1-4 settled email + kind=reply ->
  not open, 0 proposals.

### AC2 -- one key scheme + store, 0 calls on re-run, heartbeat 0 calls after: CONFIRMED
- `runReportClassify` reads the store, computes `currentlyJudgedKeys` (key AND CLASSIFIER_INPUT_VERSION) and passes
  it to `runClassify`. Builder RB-2/RB-3 pass. Verifier V2-2: after a report pass, the heartbeat call
  `runClassify(..., currentlyJudgedKeys(store), ...)` makes 0 model calls, 2 already judged.
- Live: builder's two runs show 0 calls / 139 and 140 already judged (log lines read from builder notes; not re-run here).

### AC3 -- HTML only from stored CURRENT verdicts: CONFIRMED
- `rowsFromStoredVerdicts` uses `verdictIsCurrent(v, u.itemKey, u.source)` (key + input version). Builder RC-5 covers a
  stale KEY only. Verifier V3-1: stale INPUT VERSION (Teams v1 vs current 2, email v99) -> 0 rows, both listed not
  checked; V3-2 their to-do text never reaches the HTML; V3-3 the report pass re-judges them (2 calls, 0 skipped).

### AC5 -- daily cap, concurrency 5: CONFIRMED (with one latent edge, below)
- Batch = `pending.slice(i, i + min(conc, callsLeft - res.calls))`; `callsLeft = classifyCallsLeft(usedToday, dailyCap, maxCalls)`.
- Verifier V5-1 (12 units, concurrency 5): cap leaving 0/1/3/4/5/6/7/11 -> recorded attempts and model calls equal
  exactly that number each time, in-flight never above min(5, left), the rest counted over cap. V5-2 already over the
  cap -> 0 attempts. V5-3 an attempt-record failure mid-batch stops further batches (5 attempted, 4 calls, 1 failure).
- Latent edge (not reachable today): `maxCalls = NaN` makes `callsLeft` NaN, the batch is always empty and the loop
  never advances -> the process HANGS (an endless microtask loop; measured: `timeout 15` -> exit 124, 0 model calls).
  The workflow path cannot produce NaN (`Number(PREVIEW_MAX_SOURCES) || 200`), and `dailyCap`/`usedToday` are
  sanitised upstream, so this is a robustness row, not a spend risk.
- Cross-process note: `usedToday` is read once at the start of the report. A heartbeat pass running at the same
  moment reads its own snapshot, so the two together can exceed the cap by at most the heartbeat's per-pass limit
  (6: on this branch the heartbeat still passes no concurrency and the default per-pass limit). Recorded, not a defect.
- Scope note: the WIP base adds `heartbeatPassShape`, `catchUpStopReason`, `catchUpContinue`, `CATCHUP_*`,
  `pendingUnitCount`, and the `unchecked`/`uncheckedCounts`/`preview` selection fields. grep over `src/`: NONE of them
  is consumed outside `actions.ts`/`pipeline.ts`. They are unused exports that would land on main with this merge.
  `selectActionItems` behaviour does change (not-checked items now also pushed to `unchecked`); `notChecked` count is
  preserved and actions-view 96/0 still passes.
