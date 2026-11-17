# VERIFY: report-saves-verdicts, loop 2

WHAT:          Independent re-verification of branch `claude_report-saves-verdicts` @ a3b55799 against origin/main @ 23c04496.
WHY:           Loop 1 (VERIFY-report-saves-verdicts-1.md, branch claude_verify-report-saves-verdicts-a5d3) returned FIX FIRST
               on AC4 + AC8 + three out-of-list findings; this pass re-derives those and re-confirms the rest.
SUPERSEDES:    VERIFY-report-saves-verdicts-1.md (for head a3b55799). SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file, written per claim as each lands; adversarial files alongside (`*.txt`, synthetic data only).

PUBLIC REPO: counts only. No names, addresses, ids or message content.

## Suites (re-run by this pass, worktree @ a3b55799)

| command | result |
|---|---|
| `bun scripts/report-saves-verdicts.test.ts` | 29 passed, 0 failed, exit 0 |
| `bun scripts/actions-accuracy.test.ts` | 60 passed, 0 failed, exit 0 |
| `bun scripts/actions-view.test.ts` | 96 passed, 0 failed, exit 0 |
| `bun scripts/actions-view-server.test.ts` (throwaway local PostgreSQL 16) | 29 passed, 0 failed, exit 0 |
| loop-1 adversarial file, RETARGETED to this head (see note) | 22 passed, 0 failed, exit 0 |
| `npx tsc --noEmit` | (pending) |

Note on the loop-1 adversarial file: it hard-codes the loop-1 worktree path (`agent-a5d3...`), so run unchanged it
tests the OLD code (543df6af) -- and it hung there on V5-4 (the NaN case), which is the loop-1 bug, not this head.
Retargeted to this worktree, plus `sortingOn: true` on its 10 `runReportClassify` calls (a new required input; without
it every call takes the sorting-off path). Result 22/0, and `INFO V5-4 maxCalls=NaN -> done calls=0`.

## Results per claim

### AC8 -- concurrency (full re-derivation): CONFIRMED

Code read: `pipeline.ts` `runClassify` -> `finish(tx)` re-reads the thread's stored verdict via `tx.current()` INSIDE
`deps.lockThread`; `actions.server.ts` `withThreadLock` = one pooled connection, `BEGIN`, `pg_advisory_xact_lock(
hashtextextended('actions-thread:'||itemKey, 0))`, `current()`/`store()` on that connection, `COMMIT`; a process-wide
semaphore caps holders at `THREAD_LOCK_HOLDERS_MAX = SHARED_POOL_MAX - 3 = 8 - 3 = 5`.

Adversarial test (`VERIFY-report-saves-verdicts-2.ac8-stress.test.ts.txt` = the builder's real-PG suite + my block
`...ac8-block.ts.txt`; real attempt record, real proposeFromSource + proposal store, real verdict store, real lock;
model faked). 12 fresh unjudged Teams threads, THREE passes at once, concurrency 5 each, every pass words every to-do
differently, and the 15 first-wave model answers are RELEASED TOGETHER (worst case for the pool):

| check | result |
|---|---|
| V2-AC8-1 completes; 36 calls, 12 stored open, 24 adopted, 0 failures | PASS (53 ms) |
| V2-AC8-2 exactly one proposal per thread (12/12 count 1) | PASS |
| V2-AC8-3 every stored verdict points at its thread's proposal | PASS (12) |
| V2-AC8-4 pool never above 8 | PASS (peak total 8, peak waiting 7, peak holders inside lock 5) |
| V2-AC8-5 a 4th pass with a STALE judged set (did not see the store): 12 calls, 0 open, 0 new proposals | PASS |
| whole file | 34 passed, 0 failed |

Attacks, one by one:
- **Pool deadlock (lock holder waiting for a second connection).** The holder cap is load-bearing, and the evidence is
  the mutation. With `THREAD_LOCK_HOLDERS_MAX = 100`, the gated test's mutated run printed `FAIL V2-AC8-1 ... got
  "TIMEOUT"`, `[task-dedup] open-title read failed ... timeout exceeded when trying to connect` x5, and `FAIL V2-AC8-5
  got [12,0,9]` (9 extra proposals created once the pool timed out). With the cap at 5 it passes. Caveat: `mutate.sh`
  returned exit 4 UNDETERMINED for this mutation, not FIRED. The failure shows in the per-run captured output
  (`tee` per PID). I do not know why the tool missed the marker; treat this as observed by hand, not tool-certified. Without the
  gate (random 0-30 ms model delays) the same mutation was INERT. The deadlock needs the pool to fill all at once.
  In production one process runs at most one report pass at concurrency 5 (the heartbeat passes no `concurrency`, so 1). A
  process would need more than 5 simultaneous holders to reach this, and the semaphore queues the 6th.
- **Lock skipped on any write path.** The only verdict writers are `storeVerdict` (used by `runClassify` ONLY when
  `deps.lockThread` is absent) and `tx.store`. `classifyDepsFor` always sets `lockThread`. It is the deps of BOTH the
  heartbeat (`actions.server.ts:172`) and the report with saving on (`:301`). `inMemoryWrites` drops `lockThread`, but
  its propose/store/meeting deps write nothing real (save off). No unlocked real write path found.
- **Lock removed** (mutate.sh, anchor = the `pg_advisory_xact_lock` line): `FIRED (control EQUIVALENT)` on the builder's
  `AC8-S1 GUARD (real SQL)`. On my stress file it also fails: `V2-AC8-1 got [36,22,14,0]` (22 stored open, not 12).
- **Stored-verdict re-check removed** (anchor = `if (cur && verdictIsCurrent(...)) return "adopted";` in pipeline.ts):
  `FIRED (control EQUIVALENT)` on `AC8-S1`.
- **Lock key collisions.** Key = `actions-thread:` + itemKey, and itemKey = `teams:<chat>|<last id>` or
  `<conversation key>|<last id>`. It names the same last message as `storeAt`, so lock and stored row correspond 1:1.
  The key has no owner, so two owners with one itemKey would serialise (harmless). `current()`/`store()` filter by owner.
  A 64-bit hash collision can only add waiting, never a wrong write. No other `pg_advisory*` use exists in `src/`.
- **Two passes on the same thread -> two proposals.** Not reproduced: builder AC8-S1 (2 passes) and my V2-AC8-1/-5 (3+1 passes, 12
  threads) all end with one proposal per thread.

Residual, NOT a regression (observation): the proposal is written by `proposeFromSource` on its OWN pooled connection
and transaction (`proposals-store.server.ts` `inTx`), not on the lock's connection. The brief says "proposal + verdict
writes now run in a transaction", but the lock SERIALISES them; it does not make them one transaction. If the proposal
commits and `tx.store` then fails, the verdict rolls back, the proposal stays, and a later pass with different wording
could add a second one. That needs a DB error between two statements, and the same was true before this branch.
