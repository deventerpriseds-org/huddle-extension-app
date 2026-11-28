<!--
WHAT:       Independent verification, loop 2, of PR #303 (Outlook label -> automatic board task), head 5105324d.
WHY:        Tier 1 change. Loop 1 (VERIFY-actions-label-autotask-1.md) found V-1/V-2 (once-per-conversation) and F-6;
            the fix landed in ba67d3e5 / 8a0ba699. This loop re-derives those and decides F-3.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file. All data synthetic. Probe source kept outside the repo (session scratchpad), summarised below.
-->

# VERIFY: actions-label-autotask, loop 2 (head 5105324d)

## VERDICT: FIX FIRST: F-3 (cross-instance concurrent passes can still make 2 tasks for one conversation)

## Suites (run by me, head 5105324d, detached)

| Suite | Result |
|---|---|
| actions-view | 347 passed, 0 failed (rc 0) |
| actions-view-server (real Postgres) | 59 passed, 0 failed (rc 0) |
| correspondence-ingest | 196 passed, 0 failed |
| correspondence-ledger-sql | 87 passed, 0 failed |
| task-proposals | 199 passed, 0 failed |
| actions-accuracy | 103 passed, 0 failed |
| report-saves-verdicts | 39 passed, 0 failed |
| `npx tsc --noEmit` | rc 0 |
| `npm run build` | rc 0 |

## Full re-derivation of the loop-1 failures

| # | Claim | Result | Evidence |
|---|---|---|---|
| V-1 | same pass, one conversation, different titles -> 1 task | PASS | my probe L2-V1 (shared thread_id, two titles, one pass) -> createTask 1; L2-V1p (plan key only, no thread_id) -> 1. Code: `convTasked` set in `finish()` for every outcome except meta_guard, checked at the top of each email. |
| V-2 | label removed from the first email, labelled reply with another title -> no 2nd task | PASS | my probe L2-V2 with `priorConversations` built exactly as `loadAutoTaskConversations` does (every recorded row with a proposal and a thread_id, loaded or not) -> createTask 1, B recorded `decided` on A's proposal. My loop-1 probe V-2 still reports 2 because it never passes the new dep (the server wiring is what supplies it; LAT-PG-V2 covers that wiring on real SQL). |
| V-2 key | `thread_id` and `content.conversationId` come from one source | PASS (by reading) | `source-item.ts` `emailSourceItem`: `threadId: mapped.conversationId ?? null` (~line 395); `emailContent`: `conversationId: mapped.conversationId ?? null` (~line 253). `thread_id` exists since the ledger's first commit (e0602c4b / 53d7143e, 2026-11-12), so there are no old rows with a conversationId and a null thread_id. Upsert keeps thread_id unless the hash changes (`ledger.server.ts:245`); a purge does not touch it. |
| V-2 SQL | loader has no label / content / purge filter | PASS (by reading) | `loadAutoTaskConversations`: `owner_email = ANY($1) AND source='email' AND thread_id IS NOT NULL AND result_ids ? 'autotask' AND proposalId IS NOT NULL`. Owner-scoped. Read before the pass; a throw stops the pass before any create (fail closed). |
| F-6 | deadline checked before each email and before each create; deferred uses no attempt | PASS | my probe L2-DL: clock jumps past deadline after the 1st create -> created 1, deferred 2, no record for the deferred two; the next pass picks them up. `nowMs()` returning 0 does not disable it (the guard tests the function, not its value). Server: `deadlineMs: startMs + LABEL_AUTOTASK_BUDGET_MS` (8 000), `nowMs: () => Date.now()`. |
| adv | first email's create fails, sibling of the same conversation creates in that pass, retry pass | PASS | my probe L2-F1: 1 successful create total; the retry finds the sibling's approved proposal and records `decided`. |

## Mutations (mutate.sh, re-run by me)

All with my own anchor files; every one restored to HEAD (mutate.sh asserted it).

| # | Defect reinstated | Test that must fail | Result |
|---|---|---|---|
| M-V1 | in-pass skip off: `if (false && ck && convTasked.has(ck))` | LAT-V1 GUARD | FIRED (control EQUIVALENT), exit 0 |
| M-V2 | prior map ignored: `for (const c of ([] as any[])) addConv(` | LAT-V2 GUARD | FIRED (control EQUIVALENT), exit 0 |
| M-DL | `const pastDeadline = () => false;` | LAT-DL GUARD | FIRED (control EQUIVALENT), exit 0 |
| M-PG-V2 | loader SQL adds `AND content_purged_at IS NULL` | LAT-PG-V2 GUARD (real PG) | FIRED (control EQUIVALENT), exit 0 |
| M-KEY (new, mine) | `rowConversationKey` ignores thread_id (`if (false && r.threadId)`) | LAT-PG-V2 GUARD (real PG) | FIRED (control EQUIVALENT), exit 0 |
| loop-1 m1 | `if (false && convDecided)` | RTL-6b | FIRED (control EQUIVALENT), exit 0 |
| loop-1 m4 | board read fails open (`board = []`) | LAT-AC-3.28 | FIRED (control EQUIVALENT), exit 0 |

(A first attempt passed `FAIL <name>` as the pattern and got UNDETERMINED, rc 4, for all five: wrong pattern, nothing
proven; re-run with the bare test names above.)

## Reduced-depth re-check of loop-1 PASS claims

| # | Claim | Result | Evidence |
|---|---|---|---|
| 1 | ingest + hash exclusion | PASS | correspondence-ingest 196/0, ledger-sql 87/0; hash at source-item.ts still subject/body/from/received/etag only |
| 2 | setting + whole-label matcher | PASS | actions-view 347/0; my loop-1 look-alike probe re-run: `!`, `No ` prefix, truncation, Cyrillic, ZWSP -> 0; double space, CAPS, NBSP -> 1. (The probe's string / `;` / object inputs return 0 at the pass; they never reach it, `loadLabelRows` requires a jsonb array, and ingest normalises them, claim 1.) |
| 3a | once per email | PASS | probe V-6 (two concurrent passes, same email) -> 1 |
| 3c | judge link | PASS (suite) | LAT-AC-3.12 passes |
| 3d | retry cap | PASS (suite) | RTL-4 / RTL-4b / RTL-5b pass |
| 3e | fail-closed board read | PASS (suite) | LAT-AC-3.28 passes |
| 3f | label removal never edits/deletes | PASS (by reading) | the pass calls no edit/decide; V-2 fix only reads |
| 3g | 10 per pass | PASS | probe V-5: 25 labelled -> 10 created, 15 deferred |
| 3h | owner scope | PASS (by reading) | every new SQL (`loadAutoTaskConversations`, `loadLabelRows`) filters `owner_email = ANY($1)` |
| 4 | closed row | PASS (suite) | LAT-AC-3.32 / 3.33 |
| 5 | status never interpreted | PASS (by reading) | the fix adds no status read |
| 6 | back-fill dry run | PASS (by reading) | unchanged by the fix |
| 7 | regressions | PASS (suite-level) | all suites above green |

## F-3 decision: CAN the label pass run on two instances at once? YES -> FIX FIRST

Observations:
- The heartbeat is journey's pg_cron POSTing `/api/public/run-turn` every minute -> `runDueScheduledJobs` ->
  `runCorrespondenceIngest` -> `runActionsClassify` -> `runLabelAutoTaskPass`. The correspondence step is NOT one of
  the claimed scheduled jobs (`claimDueScheduledJobs`); it runs on every tick.
- `/api/public/graph-mail-notify` also pulls the scheduler forward, a second entry point.
- The only single-flight is per PROCESS: the module-level `classifying` promise and `lastClassifyMs`
  (actions.server.ts:167-176). A new instance starts with `lastClassifyMs = 0`, so its first tick runs a pass at once.
- The API is SWA managed functions (`deploy-swa.yml`: `api_location: ".output/server"`), i.e. Azure Functions, which
  scale out. The codebase already designs for that: `ingest.server.ts:33` "across instances the ledger's claim/lease
  makes concurrent passes safe (AC-3.9)", and the ledger claim uses `FOR UPDATE SKIP LOCKED` for exactly this.
- The label pass takes no cross-process lock. `withThreadLock` (`pg_advisory_xact_lock`, key `actions-thread:<itemKey>`)
  exists but only the classify propose path uses it.
- Probe L2-F3 / V-6b: two overlapping passes over the same two emails of one conversation (different titles) -> 2
  creates. Each pass builds its conversation map at pass start and the per-proposal lease only protects one email.

Interpretation (inference, confidence medium-high; not observed live): a second instance can overlap a pass on a
cold start or when graph-mail-notify and the cron land on different instances. Rare, but it produces exactly the
duplicate the owner's once-per-conversation rule forbids.

Smallest fix (NOT implemented):
- Make the whole label pass single-flight ACROSS instances: in `runLabelAutoTaskPass`, take
  `pg_try_advisory_lock(hashtextextended('actions-label-autotask', 0))` on one dedicated pooled connection before
  `loadLabelRows`; if not acquired, return null (the other instance is doing it); release in `finally`. Because the
  row load, the conversation map and every create all sit inside the lock, the second instance's next pass sees the
  first one's records.
- Why not `withThreadLock` around each check-and-create: the lock alone is not enough. The pass's conversation map is
  read at pass START, so the waiter would still create after the holder releases unless the sibling records are
  re-read inside the lock. It would also hold a connection across a journey create per email.
- Guard to add: a real-Postgres test with two overlapping `runLabelAutoTaskPass` calls on two emails of one
  thread_id, different titles -> createTask total 1.
