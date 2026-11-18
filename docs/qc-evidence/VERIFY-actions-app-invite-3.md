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

## Chunk 2 - loop-2 real-SQL probe re-run at 04242df2 (unchanged probe; deps = real classifyDepsFor, so real withThreadLock)

8 passed, 0 failed. Rows (after the simulated version bump, the re-judge runs with the new wording):

| scenario | act | wording | before re-judge | re-judge calls/open | proposal after | proposals on item | after re-judge |
|---|---|---|---|---|---|---|---|
| dsame/dsim/ddiff | dismissed | same/sim/diff | ABSENT | 0/0 | same id | dismissed (1) | ABSENT |
| csame/cdiff | completed | same/diff | ABSENT | 0/0 | same id | completed (1) | ABSENT |
| wsame | Wrong? | same | NOT_CHECKED_YET | 1/1 | same id, not null | proposed (1) | CORRECTED |
| **wsim (B3)** | Wrong? | similar | NOT_CHECKED_YET | 1/1 | same id, not null, onBoard false | proposed (1) | **CORRECTED** (loop 2: lost link) |
| **wdiff (B4)** | Wrong? | very different | NOT_CHECKED_YET | 1/1 | same id | proposed (1) | **CORRECTED** (loop 2: MAIN_LIST, 2nd proposal) |
| nsame | untouched | same | NOT_CHECKED_YET | 1/1 | same id | proposed (1) | MAIN_LIST |
| **nsim (B-open-sim)** | untouched | similar | NOT_CHECKED_YET | 1/1 | same id, onBoard false | proposed (1) | **MAIN_LIST** (loop 2: vanished) |
| ndiff | untouched | very different | NOT_CHECKED_YET | 1/1 | same id | proposed (1) | MAIN_LIST |

The propose hook was never entered on any re-judge (its debug log is empty for all 11 scenarios): exactly one proposal
per item. B3 and B4 now HOLD.

## Chunk 3 - adversarial probes (new real-SQL probe, same scaffold, synthetic data; not committed) and mutations

| # | question | observed | verdict |
|---|---|---|---|
| C1 | stale verdict `none` (no proposalId) re-judged open | propose called 1x, new proposal, verdict open iv=3, MAIN_LIST, title = new to-do | PASS |
| C2 | stale open verdict whose proposal ROW was deleted | propose NOT called (dangling id kept), item shows under NOT_CHECKED_YET ("open with no backing row") and stays there until a new message arrives; pre-fix it would have proposed afresh | OBSERVATION (no code path deletes `chat.task_proposals` rows: grep of src/features/huddle/lib for a delete/purge of that table finds none; reachable only by a manual DB delete) |
| C3 | untouched item re-judged with very different wording | propose 0x, 1 proposal, MAIN_LIST; title shown = the OLD proposal's title (`p?.title` wins in buildCandidates), quote/reason from the new verdict | PASS; acceptable: same item version (same message), the old title is grounded in that same message and carries any owner edit |
| C4 | stale open (with proposal) re-judged `none` | propose 0x, verdict none (no proposalId), item ABSENT; old proposal row stays `proposed` | PASS for this fix (keep logic only fires on open). Pre-existing, outside this fix's radius: the orphaned `proposed` row is unchanged from before 04242df2 |
| C5 | new message (different item key) on a thread with a stale open verdict | propose 1x, 2nd proposal created, MAIN_LIST with the new title | PASS (matches RK-2 intent; old proposal remains `proposed`, pre-existing) |
| no-lock | `lockThread` absent (offline tests, report save OFF via `inMemoryWrites`) | code read: `prior` only set inside `if (tx)`, so keepId is always null -> pre-fix behaviour; report-saves-verdicts RL-2 still PASS | PASS |
| live | heartbeat passes lockThread | `runActionsClassify` -> `classifyDepsFor` -> `lockThread: (u, fn) => withThreadLock(owners, u, fn)`; the probe uses that same `classifyDepsFor` | PASS |

Mutations (`mutate.sh`, anchor `if (v.status === "open" && keepId) {` -> `... && keepId && false) {`):
- `bun scripts/report-saves-verdicts.test.ts`, must-fail `RK-1 GUARD`: **FIRED (control EQUIVALENT)**, exit 0.
- loop-2 real-SQL probe, must-fail `B4 Wrong?`: **FIRED** (run with `--no-control`, so uncontrolled; the probe
  executes the code against PostgreSQL rather than hashing the file). Restored to HEAD both times, tree clean.

Re-checked at reduced depth: claims 1-9, A6 (the share-note carve-out text present in action-classify.ts at the three
instruction blocks; AI-15 PASS with the added step-2-only phrase), B1, B2 and the dismissed/completed set-aside (probe
rows: 0 calls on re-judge, stay ABSENT) - all PASS via the suites and the probe.

## Verdict

SHIP. B3/B4 fixed and proven against real SQL; the fix's mutation is caught by both RK-1 and the real-SQL probe.
Non-blocking notes for the owner/builder: C2 (a manually deleted proposal row now leaves the item in "Not checked yet"
instead of re-proposing) and C4/C5 (an orphaned `proposed` row when the verdict flips or the message changes;
pre-existing, not introduced here).
