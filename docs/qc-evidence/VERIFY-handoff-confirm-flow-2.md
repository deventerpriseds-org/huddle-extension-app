# VERIFY handoff-confirm-flow, loop 2

<!--
WHAT:          Independent verification (loop 2) of the handoff-confirm-flow Tier-1 change: C1..C6 (F1, urgency, F2,
               F4, F3, regression) on branch claude/modest-brown-2hdt5n @ 96060f39, from code, offline suites, a
               throwaway local Postgres and mutation proofs only.
WHY:           Loop 1 (VERIFY-handoff-confirm-flow-1.md) was killed by a container restart after C2 (REFUTED) and C4
               (CONFIRMED). Fix 96060f39 targets loop 1's C2 refutation; C1/C3/C5/C6 were never reached.
SUPERSEDES:    docs/qc-evidence/VERIFY-handoff-confirm-flow-1.md (on origin/eds-wip/claude_verify-handoff-confirm-flow-1
               only; never landed on a branch). Its C2 verdict is superseded by this file's C2; its C4 is re-checked here.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      spec `origin/claude_ac-handoff-confirm:docs/qc-evidence/AC-handoff-confirm-flow.md`; diff
               `origin/main...96060f39`; probes under docs/qc-evidence/verify-handoff-confirm-flow-2/ (and loop 1's
               copied to docs/qc-evidence/verify-handoff-confirm-flow-1/); local PG via scripts/local-pg-up.sh.
-->

Base under test: `origin/claude/modest-brown-2hdt5n` @ `96060f39`. Offline only. F5/F6/F7 OUT OF SCOPE (not built).
Started 2026-11-11 05:44 UTC; budget 45 min.

## Baseline (2026-11-11 ~05:47 UTC, all on 96060f39)

| suite | result |
|---|---|
| npx tsc --noEmit | rc=0 |
| test:handoff-lane-a | 72 pass, 0 fail |
| test:handoff-lane-b | 7 pass, 0 fail |
| test:context-and-confirm | ALL PASS |
| test:plan-and-answer-first | 35 passed, 0 failed |
| test:mode | 67/67 |
| test:router | 39 passed, 0 failed |
| test:reminder-tools | 83 passed, 0 failed |
| test:timeout-no-rerun | 12 pass, 0 fail |

## C2 Urgency -- REFUTED (the class survives the fix; every enumerated row now passes)

Loop 1 probe re-run (`verify-handoff-confirm-flow-1/urgency-probe.ts`, S-U1..S-U14 + 22 verifier rows + V-23..25):
**38 passed, 0 failed**. The 5 loop-1 failures ("don't do it right away", "don't do it immediately", "not immediately",
"not asap", "no rush, asap is fine whenever") now classify `default`. So the fix does exactly what its commit says.

Loop 2 probe (`verify-handoff-confirm-flow-2/urgency-probe-2.ts`, 30 new rows): **18 passed, 12 failed**.

Caller-named rows, decided:

| input | got | decision |
|---|---|---|
| not now, but asap tomorrow | default | correct |
| I can't do it right away, can you? | now | acceptable (it is a request to the agent) |
| never mind, do it right away | now | correct (comma breaks the negation window) |
| don't forget, do it now | now | correct |

**Unsafe failures (classify `now`, a reader would say "not now"; `now` skips the confirm step):**

| id | input | got |
|---|---|---|
| N-5 | it doesn't need to be done right away | now |
| N-6 | no need for it right now | now |
| N-7 | I wouldn't start it right away | now |
| N-8 | you shouldn't do it immediately | now |
| N-9 | this isn't urgent, it doesn't have to happen immediately | now |
| N-10 | there's no hurry to do it right now | now |
| N-16 | can't do it now | now |
| N-17 | I won't need it right away | now |
| N-19 | later is fine, rather than right now | now |

Mechanism (read, capabilities.ts:165): the negator alternation is a closed list `not|don'?t|don’t|do not|never|no
need to`. `doesn't`, `isn't`, `can't`, `won't`, `wouldn't`, `shouldn't`, `no need for`, `no hurry`, `rather than` are
absent, and only `no rush` (not `no hurry`) is a global veto. Same defect class loop 1 refuted, different spellings.

Safe-direction misses (classify `default`, user wanted now; cost = one extra confirm): N-20 "why not do it now?",
N-21 "no rush on the deck, but research treats now" (the `no rush` veto is global, not scoped), N-30 "don't wait do it
now" (no comma, so `don't` governs `now`).

Impact (consumers, see C1 below for the read): `now` makes `laneHandoffSuppression` return "now" (skips the 1:1 lane
hand-off) and the 1:1 lane directive tells the agent not to ask for confirmation first.
