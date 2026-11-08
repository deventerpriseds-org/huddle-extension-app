# VERIFY handoff-confirm-flow, loop 1

<!--
WHAT:          Independent verification of the handoff-confirm-flow Tier-1 change (rows 1-5: F1, urgency, F2, F4, F3)
               on branch claude/modest-brown-2hdt5n, from code, offline tests and mutation proofs only.
WHY:           Tier-1 path (it decides when a task reaches DOING and who is handed a user's ask). The implementing
               session's own tests are not independent evidence.
SUPERSEDES:    nothing (no earlier pass branch `claude_verify-handoff-rows1-5` exists on origin; checked 16:20 UTC).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      spec `origin/claude_ac-handoff-confirm:docs/qc-evidence/AC-handoff-confirm-flow.md`;
               diff `origin/main...origin/claude/modest-brown-2hdt5n` at 8d80fc74; probe scripts under
               `docs/qc-evidence/verify-handoff-confirm-flow-1/`.
-->

Base under test: `origin/claude/modest-brown-2hdt5n` @ `8d80fc74`. Offline only (no live app, no database).
F5 / F6 / F7 are NOT built and are recorded as OUT OF SCOPE.

## Baseline runs (2026-11-08 ~16:25 UTC)

| suite | result |
|---|---|
| test:handoff-lane-a | 65 tests, 0 fail |
| test:handoff-lane-b | 7 tests, 0 fail |
| test:context-and-confirm | ALL PASS |
| test:plan-and-answer-first | 35 passed, 0 failed |
| test:mode | 67/67 |
| test:router | 39 passed, 0 failed |
| test:reminder-tools | 83 passed, 0 failed |
| test:timeout-no-rerun | 12 tests, 0 fail |
| npx tsc --noEmit | (pending) |

## Claims

(filled in per claim below)
