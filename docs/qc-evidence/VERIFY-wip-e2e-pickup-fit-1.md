PROGRESS: 1/7

# VERIFY wip-e2e-pickup-fit loop 1

Verifier: independent subagent, origin/main 298466ef. Started 2026-11-05T19:44Z.
Scope: #139 (3c7e7bcd), #140 (004d7722), #141 (a233b827), #143 (ce22b461). Read-only; no DB / deployed system touched.

## Test suites (run ~19:46Z on origin/main 298466ef, node_modules symlinked from main checkout)

| command | result |
|---|---|
| bun scripts/task-mode.test.mjs | 67/67 passed, exit 0 |
| bun scripts/confirm-ask-context.test.ts | 18/18 passed, exit 0 |
| bun scripts/start-on-approval.test.ts | 21/21 passed, exit 0 |
| bun scripts/directive-length.test.ts | 9/9 passed, exit 0 (reports worst confirm ask 4483, work directive 7256) |
| bun scripts/approach-gate-tuning.test.ts | 11/11 passed, exit 0 |
| npm run -s test:ownership-judge | ALL PASS, exit 0 |
| npm run -s test:override-gate | ALL PASS, exit 0 |
| bun test scripts/autowork-lane-starvation.test.ts | 26 pass / 0 fail, exit 0 |

Observation: several suites assert on SOURCE TEXT (e.g. "the gate's verdict goes through approachVerdict"), so green suites are necessary but not sufficient; each claim below was also read in code.

## C1 (#139) researchDirective carries confirmed DoD + approach — CONFIRMED

- `agreedBrief()` autowork.server.ts:64-76 emits "WHAT THE USER CONFIRMED ... Definition of Done: ... Your approved approach: ..."; `researchDirective(task, agreed)` prepends it (:78-84).
- Call site :1103-1105: `agreed = { dod: eng?.confirmed_dod ?? task.definition_of_done ?? null, approach: eng?.proposed_approach ?? null }` from `engagementByTaskId` (= `getTaskEngagementStates(gateIds)`, :949; ENGAGEMENT_COLS tasks.server.ts:922-927 includes `confirmed_dod` and `proposed_approach`). Every research candidate is in gateIds (doingCandidates come from doingSlotCandidates / lanes, both in gateIds :842-844, :962-970).
- Before #139 (`git show 3c7e7bcd^`): `researchDirective(task)` — title only; turnPayload still has `history: []`, so the brief is the only carrier of the user's specifics.
- Caveats (observations, not refutations): (a) DoD silently truncated at 1,500 chars and approach at 2,500 (:66-67) — a long brief loses its tail with no marker; (b) the field used is `proposed_approach` = the LAST SUBMITTED plan, which equals the approved one only if nothing is submitted after approval (see C7).
