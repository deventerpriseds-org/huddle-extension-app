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
- Mutation (verifier, `mutate.sh`, anchor from a file): batch sizing `Math.min(conc, callsLeft - res.calls)` -> `conc`
  -> `FIRED (control EQUIVALENT)`, exit 0, test RB-4; restore asserted against HEAD.

### AC4 -- save_verdicts=false writes NOTHING: REFUTED as worded (one durable write remains)
- `inMemoryWrites` overrides `propose`, `storeVerdict`, `addMeetingRows`; `recordCall` is kept from the real deps.
  Verifier V4-1 (save OFF, meetings ON, 1 email unit + 1 synthetic meeting): base storeVerdict 0, propose 0,
  addMeetingRows 0, recordCall 1. V4-2 control (save ON): meeting rows added 1. No other write path found in
  `runReportPassFor` (settings, ledger data, usedToday, loadVerdicts are reads; `deps(owner)` builds objects only).
- The remaining write: real `recordActionCall` = `UPDATE chat.correspondence_ledger SET result_ids = jsonb_set(...
  '{action_calls}' ...)` on the thread's latest ledger row -- the same row and jsonb column the verdicts live in. It
  raises the owner's "used today" count, which the in-app cap notice and the heartbeat read.
- Judgement: counting spend is defensible (an off switch that lets the report spend uncounted would break the cap),
  BUT three owner-facing texts say otherwise: the workflow input ("Off = the same check, nothing stored"), the log
  ("results kept in memory") and the HTML ("nothing new was stored in Huddle"). As shipped, the text is false. Either
  reword all three to "verdicts are not saved; the AI calls still count toward today's limit", or stop recording.

### AC6 -- nothing printed is content: CONFIRMED
- Every added `console.log` read (action-scan-steps.ts x3 + logLines x2 from action-report-html.ts + the files-path
  "save: OFF" line): counts, booleans, the cap number, category enum names, the model name, HTTP status and the fixed
  OneDrive path pattern. No name/address/subject/quote/to-do field is interpolated into any log line.
- Live: read the public job log of run 44092659832 (job 134071539936, head 3931449c): the report lines contain counts
  only and match the builder's table (0 calls, 140 already judged, used 128 -> 128 of 500, rows 73/56/11, HTTP 201).

### AC7 -- PREVIEW_STEP=reply and source=files unchanged: CONFIRMED
- reply-scan-preview.ts: the new branch fires only on `PREVIEW_STEP === "action" && source === "ledger"`; the reply
  code below it is untouched by the diff.
- files path: still `runActionScan` with its own loop (stores nothing). Normalised diff of main's inline HTML vs the
  moved `renderActionReportHtml`: variable renames, a shared `what()` helper with identical markup, and the
  not-checked heading/note now passed in with the SAME literals for the files path. Only visible change: the log
  label `not checked (cap)` -> `not checked`. Module import check: `bun -e import('./scripts/action-scan-steps.ts')`
  loads and exports runActionScan + runStoredActionScan.
- Not run live on the files source (needs Graph + OneDrive); evidence is code-level.

### AC8 -- concurrency (heartbeat + report): PARTLY REFUTED (narrow window)
- Store integrity: CONFIRMED. `storeVerdict` and `recordActionCall` are single-statement UPDATEs on one row; Postgres
  row locks plus READ COMMITTED re-evaluation mean neither overwrites the other's key (`action` vs `action_calls`).
  The real-PG suite's attempt-record tests pass (28/0).
- Same to-do twice: CONFIRMED idempotent. `proposalId(owner, source, sourceItemId, normTitle)` is deterministic and
  `upsertOnce` runs in a transaction with a refs table, `ON CONFLICT DO NOTHING` and a retry on 23505.
- Same THREAD, different wording: NOT prevented. If the heartbeat and the report both start while a thread is
  unjudged (each reads `judged` before either stores), each makes its own model call; if the two to-dos normalise to
  different titles, `proposeFromSource` creates two proposals (the F14 "reworded" check is a read OUTSIDE the
  transaction, so both miss each other). The later verdict wins `result_ids.action`; the other proposal is orphaned.
  Before this branch the report stored nothing, so this second writer is new. Inference from code (not reproduced);
  likelihood low (both must start within seconds of each other on the same unjudged thread).

## Findings outside the AC list

1. **The report ignores the owner's "AI sorting off" switch.** The heartbeat returns early when
   `classifyEnabled(s, true)` is false (`s.classify === false`). `runReportPassFor` computes `classifyOn` but only
   LOGS it; with save ON it still calls the model, stores verdicts and creates proposals. An owner who switched
   sorting off would get proposals from a report run. Live owner setting today is on (log: "in-app sorting on").
2. Feature head includes the unmerged WIP base `76043a49` (see scope note above); merging lands unused exports.
3. `maxCalls = NaN` hangs `runReportClassify` (not reachable from the workflow; see AC5).
4. The feature range moves `scripts/` and `.github/` with no `.claude/memory.md` / `actions.md` change; the push gate
   (G14) refuses it unless waived (observed when pushing this evidence branch).

## Verdict

PASS: AC1, AC2, AC3, AC5, AC6, AC7 | REFUTED: AC4 (as worded) | PARTLY REFUTED: AC8 (narrow race) | NOT REACHED: none
**FIX FIRST** -- two small items: (a) honour `classify === false` in the report pass (skip it, or force save OFF);
(b) make the save-OFF texts say the calls still count (or stop recording). AC8's wording race and the WIP-base
bundling are for the owner to accept or not; neither blocks once (a) and (b) land.
