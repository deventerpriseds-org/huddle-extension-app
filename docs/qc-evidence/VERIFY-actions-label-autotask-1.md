<!--
WHAT:       Independent verification, loop 1, of PR #303 (Outlook label -> automatic board task), head dd1b874b.
WHY:        Tier 1 change: an independent verifier must check every claim before merge.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file. All data synthetic. Probe source kept outside the repo (scratchpad), quoted below in summary.
-->

# VERIFY: actions-label-autotask, loop 1 (head dd1b874b)

## VERDICT: FIX FIRST: once-per-conversation holds only across passes

## Claims

| # | Claim | Result | Evidence |
|---|---|---|---|
| 8 | Suites + tsc + build | PASS | actions-view 338/0, actions-view-server 56/0, correspondence-ingest 196/0, correspondence-ledger-sql 87/0, task-proposals 199/0, actions-accuracy 103/0, report-saves-verdicts 39/0, `npx tsc --noEmit` rc 0, `npm run build` rc 0 |
| 9 | Mutations (mutate.sh, re-run by me) | PASS 5/5 | once-per-conversation (`if (false && convDecided)`) -> RTL-6b FIRED (control EQUIVALENT) exit 0; record-then-act pre-write removed -> RTL-4b FIRED exit 0; board-read fail open (`board = []`) -> LAT-AC-3.28 FIRED exit 0; categories added to the email content hash -> LBL-AC-1.4 GUARD FIRED exit 0; substring matcher -> LBL-S GUARD FIRED exit 0 |
| 1 | Ingest: categories/status stored, not hashed, content-only refresh, Sent strips | PASS | email hash (source-item.ts ~397) = subject, body, from, received, etag only; `emailCategories` normalises bare string, `;` string, `{displayName}` and arrays (probe run); Sent path destructures both out (source-item.ts:294); RTL-13 real-PG refresh assertions pass |
| 2 | Setting: seed, [] kept, whole-label match, stale-client carry-over | PASS | LBL-AC-3.1..3.4 pass; my look-alike probe: `Action Needed!`, `No Action Needed`, `Action Neede`, Cyrillic A, zero-width space -> 0 creates; double space, CAPS, NBSP -> 1 |
| 3a | Once per email | PASS | LAT-AC-3.18 + my concurrent probe (two passes, same email, shared store) -> 1 create |
| 3b | Once per conversation | **FAIL** | see Finding F-1 and F-2 below |
| 3c | Judge links to label proposal (AC-3.12) | PASS (read + test) | pipeline.ts `labelProposalFor`; M09 in BUILD; LAT-AC-3.12 passes |
| 3d | Retry cap 5, persisted, record-write failure | PASS | RTL-4, RTL-4b, RTL-5b pass; mutation m2 FIRED |
| 3e | Fail closed on board read | PASS | mutation m4 FIRED |
| 3f | Label removal never edits/deletes | PASS (by reading) | the pass never calls edit/decide; terminal records skipped |
| 3g | At most 10 per pass | PASS | probe: 25 labelled -> 10 created, 15 deferred |
| 3h | Never another owner's mailbox | PASS (by reading) | every SQL filters `owner_email = ANY($owners)`; proposals scoped by owners |
| 4 | "Added to board" closed row | PASS | LAT-AC-3.32 / 3.33 pass |
| 5 | `status` never interpreted, no write-back | PASS | grep: only `emailStatus` (store) and the refresh comparison read it; the back-fill does GET only |
| 6 | Back-fill dry run writes nothing, counts only | PASS (by reading) | the new block is one SELECT + two count lines; "DRY RUN: nothing written" branch |
| 7 | Regressions (#282, #277, #278, markProcessed) | PASS (suite-level) | the suites above are green; markProcessed keeps `action`, `action_calls` and `autotask` (ledger.server.ts diff); LAT-PG-3 passes |

## Findings

**F-1 (FAIL, claim 3b): two labelled emails in one conversation processed in the SAME pass, different titles -> 2 tasks.**
Probe V-1: A "Synthetic budget" + B "RE: Synthetic budget revised figures", same conversation key, no verdict, one pass ->
createTask 2. The same two emails across two passes (V-1b) -> 1. So the result depends only on whether the reply landed
before or after a heartbeat. Cause: `convProposals` is built from records as read at pass START, and the in-pass check is
the title-keyed board check. The contract itself contradicts: AC-6.3 still says "different titles -> 2 tasks", while the
AC-3.21 note says once per conversation, any title.

**F-2 (FAIL, claim 3b): once A's label is removed, a later labelled reply in the same conversation gets a second task.**
Probe V-2: A tasked in pass 1; pass 2 loads only B (A's categories are now [], so `loadLabelRows` drops A and its record
never reaches `convProposals`); B has another title -> createTask total 2. A common workflow is to clear the "Action Needed"
label once the task exists, so this path is likely. The FIX file notes the same gap for purged content only.

**F-3 (note): concurrent passes on two emails of one conversation create 2 tasks** (probe V-6b). In practice the heartbeat is
single-flight per process (`classifying` promise in actions.server.ts) and the report does not run the label pass, so this
needs two server instances. No thread lock is used by the label pass.

**F-4 (note): the AI judge and the label pass on the same thread.** In one heartbeat they run in sequence (label first,
then classify links via `labelProposalFor`). If the report judges the thread between the label pass reading rows and saving
its record, the thread can hold an actionable AI proposal (another title) beside the label's approved one, and the
display then shows the AI one (`buildCandidates` uses the label proposal only when the verdict has none or the same one).
Only an owner click would make a 2nd task. Not reproduced live.

**F-5 (note): `loadLabelRows` has no time window** (LIMIT 2000, no ORDER BY). Labelled emails older than the plan window get
no conversation key, so the once-per-conversation check never applies to them. The dry-run "at most N" count is the guard.

**F-6 (note): heartbeat time budget.** The label pass has no deadline of its own: up to 10 sequential journey creates plus a
store read per pending row run before the classify step. AC-P1 has no timed test (the builder says so). NOT REACHED as a
measurement.

## Adversarial questions asked
- Two tasks from label + AI concurrently: not automatically (only the label pass creates); see F-4.
- The 2 real records with `categories: []`: probe V-4 -> matched 0, created 0; the loader also excludes empty arrays.
- Owner already put it on the board by hand: same title -> 0 creates (V-3, `alreadyOnBoard`); a hand-typed different
  title -> 1 create (V-3b), which is by design (title dedup only).
- Heartbeat budget: F-6.
