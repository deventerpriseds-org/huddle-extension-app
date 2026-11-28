# VERIFY loop 3: actions-label-autotask (PR #303)

- WHAT: the independent verifier's loop-3 verdict on the Outlook-label auto-task, focused on the F-3 fix (cross-instance lock).
- WHY: loop 2 refuted F-3 (two server instances could both create a task for one conversation). Fixed in 166eb816.
- SUPERSEDES: VERIFY-actions-label-autotask-2.md (its F-3 FIX FIRST is now re-derived below).
- SUPERSEDED-BY: nothing (current).
- EVIDENCE: branch `claude_actions-label-autotask` head e78bd580, checked out detached. Every number below was observed in this loop.

## Suite re-run (all at e78bd580)

| suite | result |
|---|---|
| actions-view | 347 passed, 0 failed, exit 0 |
| actions-view-server (real PostgreSQL) | 63 passed, 0 failed, exit 0 |
| correspondence-ingest | 196 passed, 0 failed, exit 0 |
| correspondence-ledger-sql | 87 passed, 0 failed, exit 0 |
| task-proposals | 199 passed, 0 failed, exit 0 |
| actions-accuracy | 103 passed, 0 failed, exit 0 |
| report-saves-verdicts | 39 passed, 0 failed, exit 0 |
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | exit 0 (nitro prebuilt line printed) |

## Mutations (scripts/mutate.sh, each controlled, file restored to HEAD)

| id | mutation | guard | outcome |
|---|---|---|---|
| M-V1 (re-run) | `if (false && ck && convTasked.has(ck))` in label-autotask.ts | LAT-V1 GUARD | FIRED (control EQUIVALENT), exit 0 |
| M-DL (re-run) | `const pastDeadline = () => false;` | LAT-DL GUARD | FIRED (control EQUIVALENT), exit 0 |
| M-F3 (re-derived) | lock ignored: `if (false && r.rows[0]?.got !== true) return null;` | LAT-PG-F3 GUARD | FIRED (control EQUIVALENT), exit 0 |
| M-F3L (re-derived) | lock query failure fails OPEN: `.catch(() => ({ rows: [{ got: true }] }))` on the lock query | LAT-PG-F3L GUARD | FIRED (control EQUIVALENT), exit 0 |
| M-F3U (new, this loop) | the unlock query never sent (replaced with `Promise.resolve(...)`), so the session lock leaks into the pool | LAT-PG-F3H | FIRED (control EQUIVALENT), exit 0 |

M-F3U is new: it proves the "no advisory lock left held" assertion in LAT-PG-F3H really detects a leaked lock.

## F-3 full re-derivation

Read `withLabelAutoTaskLock` and `runLabelAutoTaskPass` (actions.server.ts lines 331-399).

Observed, with a fake-pool probe (a throwaway script, deleted after the run) calling the real `withLabelAutoTaskLock`:

| case | fn ran | outcome | connection calls |
|---|---|---|---|
| fn throws mid-pass | yes | throws | lock, unlock, release(false) |
| unlock throws | yes | returns the value | lock, unlock, release(true) (connection destroyed) |
| fn throws AND unlock throws | yes | throws | lock, unlock, release(true) |
| lock query throws | no | throws | lock, release(false) |
| lock held elsewhere (`got:false`) | no | null | lock, release(false) |
| `got` is a truthy non-boolean (`"t"`) | no | null (strict `=== true` fails closed) | lock, release(false) |

Risks asked about:

- **A leaked lock if the pass throws mid-way.** Not leaked. The inner `finally` unlocks on the same connection (probe row 1). If the unlock fails, the connection is destroyed (rows 2 and 3). The real-PG LAT-PG-F3H assertion that no lock is left held is now mutation-proven (M-F3U).
- **Pool exhaustion.** Pool max is 8 (`SHARED_POOL_MAX`). The label pass holds 1 lock connection, and the proposal store's `inTx` takes 1 more and runs its whole transaction on that client. The classify pass and its `withThreadLock` holders run AFTER the label pass in the same heartbeat, not alongside it. The only concurrent holder is the report path, capped at 5 lock holders. Worst case: 5 + 1 + 1 = 7 held, 1 free. Every other demand is a single query that finishes, so the pool keeps moving. This is an inference from reading the code; no load test was run.
- **A session-level lock leaking through a pooled connection.** Covered by the unlock-in-finally plus destroy-on-unlock-failure path (probe rows 1-3, M-F3U).
  - Residual, inference only: if the lock query fails AFTER the server granted the lock (for example a dropped connection while the reply is in flight), the connection goes back with `release(false)`.
  - pg drops a client whose connection errored, and the shared pool sets no `query_timeout`. A client-side timeout is the one case that could hand back a live connection still holding the lock, and none is configured.
  - Not tested.
- **The heartbeat when the lock query throws.** `runLabelAutoTaskPass(...).catch(log)` at actions.server.ts line 193. A lock throw is logged, and the classify pass still runs. Nothing is created (probe row 4, and LAT-PG-F3L with M-F3L).
- **Could `overrides` be reached from a request?** No. A grep of `src/` finds one call site, `runActionsClassify` at line 193, and it passes 5 arguments, so `startMs` and `overrides` take their defaults. No route, server function or `.functions.ts` file references `runLabelAutoTaskPass` or `LabelAutoTaskPassOverrides`.

F-3 verdict: **PASS.**

## Prior claims re-checked at reduced depth

These claims were CONFIRMED in loop 2. This loop re-checked them with the suite line above plus the mutations listed.

| claim | evidence this loop | result |
|---|---|---|
| V-1 (once per conversation within a pass) | actions-view 347/0; M-V1 FIRED | PASS |
| V-2 (after label removal / purge, thread_id key) | actions-view-server 63/0 (real-PG V-2 guard); `loadAutoTaskConversations` still keys on `thread_id` with no purge or label filter (read, lines 295-303) | PASS |
| F-6 deadline | M-DL FIRED; `deadlineMs: startMs + LABEL_AUTOTASK_BUDGET_MS` is now computed inside the lock (line 390) | PASS |
| claims 1, 2, 3a, 3c-3h, 4-7 | all 7 suites green, tsc 0, build 0 | PASS (suite-level only) |

## The blast radius

The claims touching the fix are 3a, 3d, 3e and F-3. One addition to the radius: F-6.

`startMs` defaults to `Date.now()` at call time, so the deadline clock starts BEFORE the lock round trip. The lock query's latency therefore comes out of the 8 s label budget. That is harmless (it is less time, never more) and matches the F-6 intent ("never on top of the classify share"). M-DL confirms the deadline guard still bites.

## Not checked

- Two real server instances against the live database. The cross-instance behaviour is shown only by the local real-PostgreSQL test. It runs two overlapping passes in one process, on one shared pool, using two separate pooled connections (two PostgreSQL sessions). That is equivalent to two instances as far as an advisory lock is concerned.
- Load or pool-saturation behaviour. The pool reasoning above is inference.
- The lock-granted-but-reply-lost edge case.
