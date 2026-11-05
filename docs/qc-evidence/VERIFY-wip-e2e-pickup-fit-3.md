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
