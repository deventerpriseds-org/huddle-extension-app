# VERIFY actions-app-invite loop 3

WHAT:       Independent verification, loop 3, of PR #277 (branch claude_actions-app-invite) at head 04242df2.
WHY:        Loop 2 verdict FIX FIRST (B3/B4: a re-judge after a classifier-version bump lost the item's proposal link).
SUPERSEDES: VERIFY-actions-app-invite-2.md (its B3/B4 rows are re-run here).  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   commands and outputs below; real-SQL probe re-run against a throwaway local PostgreSQL, synthetic data only.

## Chunk 1 - suites at 04242df2 (detached checkout)

| suite | expected | observed |
|---|---|---|
| bun scripts/actions-view.test.ts | 144/0 | 144 passed, 0 failed |
| bun scripts/actions-accuracy.test.ts | 60/0 | 60 passed, 0 failed |
| bun scripts/report-saves-verdicts.test.ts | 31/0 | 31 passed, 0 failed (RK-1, RK-2 PASS) |
| bun scripts/actions-view-server.test.ts (local PG 16/17) | 32/0 | 32 passed, 0 failed |
| npx tsc --noEmit | exit 0 | exit 0, empty output |
| npm run build | exit 0 | exit 0 (nitro "You can preview this build") |

AI-15 now asserts four booleans including the step-2-only phrase; observed PASS.

## Code read of the fix (pipeline.ts runClassify -> finish)

- `prior` is set ONLY when `tx` is present (lock path). If `prior` is current (same key, current version) the pass returns
  "adopted" before any keep logic, so keepId only applies to an OLDER-version verdict of the SAME item key.
- keepId requires `prior.key === u.itemKey` and a non-empty string `prior.proposalId`. A prior `none` / `not_checked`
  verdict carries no proposalId (propose is only called for open) so it proposes normally.
- Heartbeat: `runActionsClassify` passes `classifyDepsFor(...)`, whose deps include
  `lockThread: (u, fn) => withThreadLock(owners, u, fn)` -> the fix runs live. Report with save ON uses the same deps.
  Report with save OFF: `inMemoryWrites` sets `lockThread: undefined` -> prior null -> unchanged pre-fix behaviour (its
  propose stub returns id null; in-memory only).
- `withThreadLock.current()` reads `result_ids->'action'` for the thread's storeAt row inside the advisory-locked txn.
