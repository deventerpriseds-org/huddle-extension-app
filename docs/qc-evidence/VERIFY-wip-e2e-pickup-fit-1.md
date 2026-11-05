PROGRESS: 6/7

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

## C4 (#140) coursework never assigned / excluded from auto-work and confirm-asks — CONFIRMED as coded, with REAL FALSE POSITIVES

Code:
- `isCoursework` workability.ts:46-50: `t.startsWith("📚") || /\b[A-Z]{2,4}-\d{3}\b/.test(t)` (case-sensitive, 2-4 caps, hyphen, exactly 3 digits).
- `groomOwner` groom.ts:160-162 returns "" first for coursework; sole call site groom.ts:356 passes `t.title`. The owner judge that runs after (:366-383) returns early on `!a.assigned_agent`, so it cannot re-assign the "".
- Auto-work candidates: autowork.server.ts:768-770 filter `!isCoursework(t.title)` on `assigned` — upstream of lanes, promotion, DOING and arming.
- Confirm-ask FIRE path: autowork.server.ts:563 filter `!isCoursework(r.title)` (covers asks armed before #140 too).

Probe (`bun .../scratchpad/course.ts`, real functions):

| title | isCoursework | correct? |
|---|---|---|
| 📚 Research Paper / "📚 Checkpoint 2 ... (MGT-702)" / "Obtain MGT-782 Module 3 materials" / "  📚 leading space" | true | yes |
| SOC-2 audit prep | false | yes |
| ISO-27001 checklist | false | yes |
| COVID-19 booster / Buy Sony WH-1000XM5 / Research the F-150 | false | yes |
| **Fix the ABC-123 bug** | **true** | FALSE POSITIVE |
| **Review PR-139 diff** | **true** | FALSE POSITIVE |
| **Book UA-123 flight to Denver** | **true** | FALSE POSITIVE (flight numbers) |
| **Complete DS-160 visa form** | **true** | FALSE POSITIVE (US visa form) |
| **Read RFC-822** / **Order SKU-500 replacement** / **Close JIRA-101** / **Look at HUD-204 ticket** | **true** | FALSE POSITIVES (ticket/issue/part ids) |
| mgt-702 paper / MGT 702 paper / MGT702 paper / BUSAD-500 essay / "Finish (MGT-7020) draft" / "Read chapter 📚" | false | false NEGATIVES (would still be assigned) |

`groomOwner("cole-blake","cole-blake","Fix the ABC-123 bug")` -> `""` — a real engineering/travel task is UNASSIGNED by the groom and silently dropped from auto-work and confirm-asks. Effect is quiet: no error, the card just stops getting worked.

Other assignment path NOT covered (outside the claim's named function, reported for completeness): `assign-on-create.ts` (`pickCreatedTaskAssignee` / `assignCreatedJourneyTasks`) assigns a task created in a 1:1 to that agent with no coursework check. Such a task is still excluded from auto-work/asks by the two filters above and cleared at the next groom, so "never worked" holds; "never assigned" holds only for the groom path.

## C5 (#140) hybrid rule in hints and work directive — CONFIRMED (as prompt text)

- Hints: `modeProposalHint` workability.ts:128-136 builds a shared `finishIt` block appended to ALL three modes (remind :148, assist :162, produce :171): "deliver it as "Here's what I was able to do", followed by "Here are my questions to fully satisfy what you may want" (short, specific questions). Only if you could not produce anything credible without those facts, ask for them first." `confirmIntentDirective` includes the hint (autowork.server.ts:198).
- Work directive: `researchDirective` autowork.server.ts:95-97 — "deliver what you could do with reasonable confidence under "Here's what I was able to do", then "Here are my questions to fully satisfy what you may want"", and :110-113 "Only if you genuinely cannot advance this task on your own ... call flag_blocker".
- start-on-approval.test.ts asserts these per mode (21/21). Same limitation as C2: model instruction, not enforced output.

## C6 (#141) user text capped at 4,000; internal up to 16,000 — REFUTED IN PART (client-controlled exemption)

What holds:
- huddle.functions.ts:220-226 `capUserText` throws when `!d.internal && d.text.length > 4000`; `Input.text` is now `.max(INTERNAL_TEXT_MAX)` = 16,000.
- Both client entry points wrap it: `sendHuddleMessage` :7547 `capUserText(Input.parse(raw))`; `enqueueHuddleTurn` :8190 `capUserText(EnqueueTurnInput.parse(raw))` (EnqueueTurnInput = `Input.extend`, :7582).
- Drain path :7960 `Input.parse(record.payload)` — now max 16,000, so internal directives >4,000 parse.
- Every auto-work payload is internal: confirm ask :598-602, approach re-drive :1017-1021, research :1105 all go through `turnPayload` (`internal: true`, :149); blocked digest :715 `internal: true`.
- Other parse sites swept (`grep Input.parse|Input.extend|inputValidator`): `bargeCeremony` uses its own `BargeInput` (text max 2000); voice `transcribe`/`tts` use their own local `Input`; the public cross-app route `run-agent-turn.ts` -> `buildTurnInput` (cross-app/turn-gate.ts:360-378) enforces its own `TEXT_MAX = 4000` and never sets `internal`. `ceremonies.server.ts:51` calls `runHuddleTurn` directly with server text (no parse; pre-existing). No other user-text entry point found.

Probe (`bun .../scratchpad/len.ts`, real `capUserText` import): user 4001 -> REJECTED "String must contain at most 4000 character(s)"; user 4000 -> ACCEPTED; **`{ text: 15000 chars, internal: true }` -> ACCEPTED**.

THE DEFECT: `internal` is a client-settable field of `Input` (:266 `internal: z.boolean().optional()`), and `capUserText` trusts it. Any POST to `sendHuddleMessage` / `enqueueHuddleTurn` that adds `"internal": true` sends up to 16,000 chars of user text. Before #141 this was impossible (schema max 4000 applied to everyone), so #141 introduced the bypass. The shipped UI never sets `internal` (no hit in components/hooks), so honest clients stay capped; a crafted request does not. Side effect of the same flag: it also switches off the 1:1 pass-along/deferral machinery for that turn (pre-existing). Severity: low (length/cost, authenticated caller), but the property "user text stays capped at 4,000 at both client entry points" is not true against a crafted request. Fix direction (not prescribed): the client entry points should ignore/strip `internal` from the raw body, since only server code enqueues internal turns.

Length measurements (same probe; 300-char titles, categories LIFE/VENTURES/null, first ask + re-ask):

| mode (classified) | first ask | re-ask |
|---|---|---|
| remind | 4,755 | 4,793 |
| assist | 4,790 | **4,828** (worst) |
| produce | 4,445 | 4,483 |

- Worst `confirmIntentDirective` = 4,828 <= 16,000. Note directive-length.test.ts reports "worst 4483" because its long title classifies as produce only — the test under-measures the true worst by 345 chars (still far under the limit).
- `researchDirective` with 20k-char DoD + 20k-char approach: 7,256 (300-char title); 8,956 with a 2,000-char title. Both <= 16,000 thanks to the 1,500/2,500 slices. Title is unbounded in the directive (appears 1x in research, 2x in confirm), so a pathological ~5,500+ char title would push confirm asks past 16,000 — titles that long are not expected; noted only.
