PROGRESS: 3/7

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

## C2 (#139) confirmIntentDirective names the task + real links + summary — CONFIRMED (as prompt text)

- First ask (autowork.server.ts:187-192): "open with a brief, natural greeting that NAMES THE TASK in plain words in the first sentence ... — never "this" or "this task"".
- Re-ask (:180-186): "circling back ... BY NAMING THE TASK in plain words (e.g. "Circling back on the Verva research —"), never "this one"".
- Both (:199-203): "ALWAYS include ... the most relevant link(s) you can find right now with your web search ... and, for any product, service, tool or provider, a one-to-two sentence summary of what it is ... Only real links you actually found; never invent a URL."
- Limitation: this is an instruction to a model, not a code check — nothing post-validates the agent's message for a "this" opener or a link. "Requires" holds at the prompt level only.

## C3 (#140) approval kicks one bounded auto-work pass, never throws, note says starting now — CONFIRMED with one defect-grade caveat

- approach-gate.server.ts:251-256: on `verdict === "pass"`, `approveApproach(...)` is awaited, then `kickAutoWorkAfterApproval(opts.email)`; default `run` = `runScheduledAutoWork({ entra_email: email }, { force: true })` (:154-158). Ordering matters and is right: the row is `approved` before the pass reads `isReady` (autowork :955-960 requires `approach_status === "approved"`).
- Bounded/never-throws, measured with my own probe (`bun .../scratchpad/kick.ts`, injecting `run`): resolve -> `true`; async reject -> `false`; SYNCHRONOUS throw -> `false`; slow run that rejects at 9s -> returns `false` at 8001 ms, and the late rejection produced NO unhandledRejection (process stayed clean to 9504 ms).
- Note (:261-266): "The work is being started now: it moves to Doing immediately unless you already have a task in Doing (one at a time), in which case it is next. Tell the user exactly that — never that they need to authorize the start ...".
- CAVEAT (truthfulness): the note is emitted UNCONDITIONALLY — the boolean `kickAutoWorkAfterApproval` returns is discarded (:256). On a timeout/failure the agent still tells the user the work "is being started now", while it actually waits for the next scheduled pass. Also the 8s bound is a wait bound only: the pass keeps running after the race resolves (not cancelled), and the 8s is spent inside the agent's tool dispatch, i.e. inside the turn's chunk budget.
- The grader-error fail-open path (:326) returns approved:true WITHOUT kicking — consistent with "never record an approval no grader produced".
