<!--
WHAT:       the fix for verifier loop-2 finding F-3 on actions-label-autotask (cross-instance single-flight label pass).
WHY:        VERIFY-actions-label-autotask-2.md F-3: two overlapping label passes on two instances over two emails of
            one conversation (different titles) created 2 tasks; the only single-flight was per process.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; scripts/actions-view-server.test.ts LAT-PG-F3* guards. All data synthetic.
-->

# FIX: verifier loop 2, F-3 (actions-label-autotask)

Base: `origin/claude_actions-label-autotask` @ 88c88863.

## Log (appended as I go)

- Read F-3 in `VERIFY-actions-label-autotask-2.md` and the pass in `actions.server.ts` (`runLabelAutoTaskPass`, ~line 332).
  Existing cross-process lock: `withThreadLock` (`pg_advisory_xact_lock` on a `getSharedPool().connect()` client,
  key `hashtextextended(<key>, 0)`). The fix follows that pattern: same pool, same `connect()`/`release()`, same key hash,
  but a SESSION-level `pg_try_advisory_lock` (non-blocking) because the pass must hold it across many statements on
  other pooled connections (the proposal store and saveRecord use the pool, not this client) and must skip, not wait.

## What changed (commit 166eb816)

- `actions.server.ts`: new `withLabelAutoTaskLock(fn, pool = getSharedPool())`. One `connect()`ed client runs
  `SELECT pg_try_advisory_lock(hashtextextended('actions-label-autotask', 0))`. Not granted -> returns null, `fn` never
  runs. The query throws -> the throw propagates before `fn` runs (the heartbeat's existing `.catch` logs the error
  name), so nothing is created without the lock. `fn` runs inside `try`; `finally` runs `pg_advisory_unlock` on the SAME
  client; if that unlock fails the client is released with `release(true)` (destroyed) so a held session lock never
  returns to the pool; then the client is released.
- `runLabelAutoTaskPass`: the label-row load, `attachThreads`, `loadAutoTaskConversations` and the whole
  `runLabelAutoTask` (every create) now run inside `withLabelAutoTaskLock`. The `autoTaskLabels` empty check stays
  outside (no DB). The deadline is unchanged (`deadlineMs: startMs + LABEL_AUTOTASK_BUDGET_MS`, `nowMs: Date.now`).
- Test seam: an optional last parameter `overrides { deps?: openTasks/createTask/metaGuard, lockPool? }`. The
  heartbeat call site passes nothing, so production behaviour uses the real journey deps and the shared pool.
- Not done on purpose: no second lock mechanism; withThreadLock is untouched.

## Guards (scripts/actions-view-server.test.ts, real PostgreSQL, synthetic data)

| id | what | result |
|---|---|---|
| LAT-PG-F3 GUARD | two OVERLAPPING `runLabelAutoTaskPass` calls (pass 1 parked inside its first create, still holding the real lock; pass 2 starts), two emails sharing `thread_id` `lat-conv-f3`, different titles -> createTask total 1, pass 2 returns null, both emails on one proposal | PASS |
| LAT-PG-F3b | a later pass creates nothing more | PASS |
| LAT-PG-F3L GUARD | injected lock pool whose lock query throws -> pass throws, 0 creates, no autotask record written | PASS |
| LAT-PG-F3H | the real lock held by ANOTHER session -> null, 0 creates; after unlock the same pass creates 1; no granted advisory lock left in `pg_locks` | PASS |

## Mutations (mutate.sh, anchors in the session scratchpad label-V2/)

| # | defect reinstated | must fail | result |
|---|---|---|---|
| M-F3 | lock ignored: `if (false && r.rows[0]?.got !== true) return null;` | LAT-PG-F3 GUARD | FIRED (control EQUIVALENT), exit 0, restored to HEAD |
| M-F3L | lock failure fails OPEN: lock query `.catch(() => ({ rows: [{ got: true }] }))` | LAT-PG-F3L GUARD | FIRED (control EQUIVALENT), exit 0, restored to HEAD |

## Suites (head 166eb816)

| suite | result |
|---|---|
| actions-view | 347 passed, 0 failed |
| actions-view-server | 63 passed, 0 failed (59 before + 4 new) |
| correspondence-ingest | 196 passed, 0 failed |
| correspondence-ledger-sql | 87 passed, 0 failed |
| task-proposals | 199 passed, 0 failed |
| actions-accuracy | 103 passed, 0 failed |
| report-saves-verdicts | 39 passed, 0 failed |
| `npx tsc --noEmit` | rc 0 |
| `npm run build` | rc 0 |

Not observed live: the cross-instance overlap itself (two SWA instances) was not reproduced in production; the guard
reproduces it with two real Postgres sessions in one process.
