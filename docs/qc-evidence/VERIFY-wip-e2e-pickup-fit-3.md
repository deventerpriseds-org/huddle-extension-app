PROGRESS: 7/7

# VERIFY — wip-e2e-pickup-fit — loop 3

<!--
WHAT:       Independent verifier verdict, loop 3, for the WIP end-to-end pickup-fit work (C1–C7).
WHY:        Loop 2 refuted C4 (isCoursework over-matched 14 everyday titles) and found the approach gate
            failing OPEN on a settings-read error. b06e614f claims to fix both; this loop re-derives them.
SUPERSEDES: docs/qc-evidence/VERIFY-wip-e2e-pickup-fit-2.md (loop 2 verdict).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:   origin/main b06e614f; suite output and probe scripts quoted below.
-->

**Code under test:** `origin/main` = `b06e614f` ("Fix verifier loop-2 findings: strict coursework rule;
approach gate fails closed (#145)"), fetched 2026-11-05 ~20:01 UTC. This branch was brought up to that commit
by merging `origin/main`; `git diff --stat origin/main HEAD` showed only the loop-2 evidence docs differ, so
every suite and probe below ran against b06e614f's source exactly.

Read-only: no DB, no deployed system, nothing under `.claude/` touched.

## Suite re-run (covers every claim)

| command | result line | rc |
|---|---|---|
| `bun scripts/task-mode.test.mjs` | `67/67 passed` | 0 |
| `bun scripts/confirm-ask-context.test.ts` | `18/18 passed` | 0 |
| `bun scripts/start-on-approval.test.ts` | `50/50 passed` | 0 |
| `bun scripts/directive-length.test.ts` | `9/9 passed` | 0 |
| `bun scripts/approach-gate-tuning.test.ts` | `13/13 passed` | 0 |
| `npm run -s test:ownership-judge` | `ALL PASS` (18 PASS lines) | 0 |
| `npm run -s test:override-gate` | `ALL PASS` (298 PASS lines; the one "FAIL" grep hit is the heading `EVERY OTHER FAILURE PATH REFUSES`, not a failure) | 0 |
| `npm run -s test:assign-on-create` | `ALL PASS` (53 PASS lines) | 0 |
| `bun test scripts/autowork-lane-starvation.test.ts` | `26 pass / 0 fail, 77 expect() calls` | 0 |

## C1 — researchDirective carries agreedBrief — CONFIRMED (reduced depth)
Observed `src/features/huddle/lib/tasks/autowork.server.ts:64-85` on b06e614f: `agreedBrief()` emits
`WHAT THE USER CONFIRMED … Definition of Done: … Your approved approach: …` (DoD capped 1500, approach 2500),
and `researchDirective()` begins `agreedBrief(agreed) + "You've been assigned this task…"`. Suites green.

## C2 — confirm ask names the task with links + summary — CONFIRMED (reduced depth)
`confirm-ask-context.test.ts` 18/18, including `first ask: names the task in plain words`,
`first ask: always includes real links`, `re-ask: …` both, and `the work directive requires links + a short summary`.

## C3 — approval note depends on the kick's boolean; kick never throws — CONFIRMED (reduced depth)
Observed `approach-gate.server.ts:157-168`: `kickAutoWorkAfterApproval` wraps `run()` in try/catch and an 8s
race, returns `false` on throw/timeout. `:261` `const kicked = await kickAutoWorkAfterApproval(opts.email);`
and `:268` `kicked ? "…being started now…" : "…didn't go through, so the next automatic pass…"`.
start-on-approval tests `kick never throws when the pass fails` and `the note depends on whether the start
actually ran` PASS. b06e614f changed only line 181 of this file; C3's lines are untouched.

## C5 — hybrid wording — CONFIRMED (reduced depth)
`start-on-approval.test.ts` PASS `the work directive delivers the hybrid too` (and the rest of its 50).

## C6 — capUserText caps every client message at 4,000, ignores `internal` — CONFIRMED (reduced depth)
Observed `huddle.functions.ts:218-229`: `USER_TEXT_MAX = 4000`; `capUserText` checks only `d.text.length`,
never reads `internal`. Both client entry points use it: `:7553 .inputValidator((raw) => capUserText(Input.parse(raw)))`
and `:8196 … capUserText(EnqueueTurnInput.parse(raw))`. directive-length 9/9.

## C7 — approachVerdict plain-string blocking = revise; recordProposedApproach upserts — CONFIRMED (reduced depth)
Observed `approach-gate.server.ts:60-72`: `list()` maps a plain string to `[v]`, `verdict: blocking.length ? "revise" : "pass"`.
`tasks.server.ts:~1379-1383`: `INSERT INTO tasks.task_engagement_state … ON CONFLICT (task_id) DO UPDATE SET proposed_approach = EXCLUDED.proposed_approach`.
approach-gate-tuning 13/13 (`every submitted plan is saved`).

## C4 — isCoursework strict rule — CONFIRMED as stated, with findings (FULL re-derivation)

**Rule on b06e614f** (`workability.ts:52-60`): `t.startsWith("📚") || (COURSE_CODE.test(t) && ACADEMIC_WORD.test(t))`,
`COURSE_CODE = /\b[A-Z]{3,5}-?\d{3}\b/` (case-SENSITIVE), `ACADEMIC_WORD = /\b(module|seminar|syllabus|residency|lecture|checkpoint|university|course|assignment|homework|midterm|capstone|semester|professor)\b/i`.
Consumers (unchanged, still wired, asserted by start-on-approval regexes): `groom.ts:162` (`return ""` = unassigned),
`autowork.server.ts:563` (confirm-ask filter), `:769` (auto-work candidates), `assign-on-create.ts:136-137`.
The 14 loop-2 false positives and the 12 loop-1 negatives all PASS in start-on-approval (50/50).

**Not a strict subset of the loop-2 rule.** The diff drops the 40-char proximity window and the bracket rule,
drops `paper|class|discussion|quiz|exam|materials|case study|research paper`, and ADDS `university|semester|professor`.
So it is narrower in some places and wider in others. Probes (scratch scripts `c4probe.ts`, `c4compare.ts`;
the loop-2 rule copied verbatim from the `-` lines of `git show b06e614f`):

| corpus | loop-2 rule true | loop-3 rule true | meaning |
|---|---|---|---|
| 25–26 everyday titles ENGINEERED to hold a 3–5-letter code AND an academic word | 20/25 | **26/26** (25/25 on the shared set) | every one wrongly coursework |
| 36 NATURAL everyday titles (codes or academic-ish words as they occur in life, not forced together) | 6/36 | **1/36** | materially lower |
| 25 realistic coursework titles | 16/25 | **7/25** | recall roughly halved |

**Wrongly true now (engineered, all new titles):** "Book a course for the CPR-101 team", "University parking permit ABC-123",
"Lecture hall rental REF-555", "Golf course tee time, booking ref TEE-482", "Update the payments module for JIRA-204",
"Fix login module bug ENG-311", "Seat assignment for flight UAL-123", "Security checkpoint at gate C, flight DAL-456",
"Install new HVAC module model HVAC-300", "Sales seminar registration code SALES-250", "Pick up kid from university, parking lot PKG-101",
"Shift assignment schedule for ops team OPS-100", "Course correction on Q3 plan per PLAN-404", "Reply to professor emeritus re: donation DON-500",
"Homework help app subscription renewal APP-123", "Semester break family trip, confirmation TRV-789", "Midterm elections volunteer shift VOTE-100",
"Capstone project kickoff with client ACME-300 (work)", "Order solar module SPR-400 for roof", "Book seminar room for board meeting BRD-210",
"Training course for new hire, ticket HRS-555", "Of course follow up with Dave on INV-778", "Write residency documentation for visa USCIS-130",
"Pay university tuition invoice for nephew INV-302", "Assignment of lease to new tenant, contract LSE-201".
Five of these the loop-2 rule REJECTED and the loop-3 rule ACCEPTS (the three added words + no proximity):
the two "university" titles, "professor emeritus", "Semester break family trip", "university tuition invoice".
**Natural-corpus survivor:** "Review AWS-200 certification course outline" (true under both rules).

**Coursework the strict rule now MISSES** (loop-2 caught the ones marked ●):
"MGT-702 Paper draft" ●, "MGT-702 discussion post week 5" ●, "MGT-702 exam prep" ●, "MGT-702 quiz 3" ●, "MGT-702 case study" ●,
"MGT 702 Module 3" ● (space), "mgt-702 module 3 reading" ● (lowercase code), "CS-101 homework 4" ● (2-letter code),
"BUS-5001 module 2" ● (4 digits), "Read Chapter 4 for MGT-702", "MGT-702 final project", "Submit MGT-702 reflection journal",
"MGT-702 group presentation", "MGT-702 essay", "Complete MGT-702A assignment" (suffix letter breaks `\b`), and the
**plural forms** "MGT-702 Assignments 3 and 4", "Watch MGT-782 lectures", "Finish MGT-782 modules 2-3" —
`\bassignment\b` does not match "Assignments". Every title the owner's own examples use (`📚 …`, "Obtain MGT-782 Module 3 materials",
"Upload MGT-782 Assignment 2", "Prep MGT-702 seminar slides", "Checkpoint 2 details (MGT-702)") is still caught.

**Judgement (observation vs interpretation).**
- Observed: on titles as they naturally occur, false positives fell 6/36 → 1/36. That is materially lower than loop 2,
  and every loop-2 FP is fixed. On the claim as stated, C4 holds.
- Observed: whenever a code and one of the 14 words co-occur ANYWHERE in a title, the rule fires — 26/26 of my
  constructed everyday titles. The residual FP rate is therefore set by how often real board titles carry a ticket/
  booking/model code next to "course/module/assignment/checkpoint/university". Interpretation (confidence medium):
  rare for this owner, but not zero — "module" + a ticket code is a common engineering title shape.
- Observed: recall fell 16/25 → 7/25. The cheapest losses are mechanical, not trade-offs: plural academic words,
  lowercase/spaced codes, and 2-letter/4-digit codes.
- The code comment's premise — "a false negative costs one check-in the user can decline" — holds only when the
  confirm-intent gate is ON for the user. UNVERIFIED this loop (read-only, no DB): whether `identity.agent_workflow_config.default_required`
  is true for the owner. If it is off, a missed coursework title can be researched/produced by an agent without a confirm step.
- Radius note: `src/features/huddle/data/agents.ts:226-283` holds a second, richer coursework vocabulary (Nexus coursework
  capability: "syllabi", "deliverable", "coursework", "emba", "professor", …) used for ask routing. isCoursework does
  not share it — "MGT-702 coursework due" is false. Not a claim failure; an extend-don't-duplicate observation.

## Out-of-claim fix — runApproachGate fails CLOSED — CONFIRMED (behavioural)

Line changed: `approach-gate.server.ts:181` `isStructuredWorkflowRequired(...).catch(() => true)` (was `() => false`).

Behavioural probe (`bun test` with `mock.module` stubbing agent-workflow-config / tasks.server / openai-responses;
scratch file `failclosed.test.ts`), 2 pass / 0 fail:
```
throwing:     {"gated":true,"approved":false,"escalated":false,"note":"revise — missing source list",...}  calls: isRequired,recordProposed,GRADER,increment
not-required: {"gated":false,"approved":true,"escalated":false,"note":""}                                    calls: isRequired
```
A throwing `isStructuredWorkflowRequired` now reaches the grader and a blocking verdict is NOT auto-approved
(`approveApproach` never called). Control: `required=false` still short-circuits with no grader call.

Callers: only `huddle.functions.ts:4273` and `:5773` call `runApproachGate`; both read `gate.approved / escalated / note`
only (the `gate.gated` reads at `:3905/:5421` belong to the review gate, a different object). No caller depends on the
old fail-open value. Test stubs (`autowork-lane-starvation`, `confirm-reask-rotation`) stub the function directly and are unaffected.

**Calibration:** the real `isStructuredWorkflowRequired` (`agent-workflow-config.server.ts:277-289`) already catches
every config-read error internally and returns `true`. So the old `.catch(() => false)` was unreachable in current code
and loop 2's "a settings-read error read as gate off" was a LATENT path, not a live leak. The change is correct
hardening (it keeps the call site safe if that function is ever refactored to throw); it changes no behaviour today.
The start-on-approval guard for it is a source-text regex; the probe above is the behavioural complement.

**Radius observation (pre-existing, not in this loop's diff):** `approach-gate.server.ts:335` — when the GRADER call
itself errors on a fresh approach, the gate still returns `approved:true` ("fail open in the return, never in stored
state"). That is documented, deliberate design, but it is the remaining place this gate admits an unseen plan for one
turn; CLAUDE.md says the gate "MUST fail CLOSED". Raising for the owner's awareness, not refuting.

## Verdict

| claim | result |
|---|---|
| C1 researchDirective carries agreedBrief | CONFIRMED |
| C2 confirm ask names task, links, summary | CONFIRMED |
| C3 approval note keyed on kick boolean; kick never throws | CONFIRMED |
| C4 strict isCoursework | CONFIRMED as stated (natural FP 6/36 → 1/36); findings: recall 16/25 → 7/25, plural words missed, 5 new FP shapes from "university/semester/professor" + no proximity |
| C5 hybrid wording | CONFIRMED |
| C6 capUserText 4,000 cap, ignores `internal` | CONFIRMED |
| C7 plain-string blocking = revise; upsert | CONFIRMED |
| fail-closed approach gate | CONFIRMED (behaviourally; latent-path hardening, no live behaviour change) |

VERDICT: CONFIRMED
