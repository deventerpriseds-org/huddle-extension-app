PROGRESS: 1/7

# VERIFY wip-e2e-pickup-fit -- loop 2

- WHAT: independent re-verification of C1-C7 after fix commit #144.
- WHY: loop 1 (VERIFY-wip-e2e-pickup-fit-1.md) REFUTED C3, C4, C6, C7.
- SUPERSEDES: nothing (loop 1 stays as the record of what was refuted).
- EVIDENCE: source read from origin/main 30d29be0 (fetched 2026-11-05 19:55 UTC) in a detached worktree; suites executed there.
- Scope: read-only. No database, no deployed system touched.

## Suite re-run (origin/main 30d29be0)

| command | result line |
|---|---|
| bun scripts/task-mode.test.mjs | 67/67 passed |
| bun scripts/confirm-ask-context.test.ts | 18/18 passed |
| bun scripts/start-on-approval.test.ts | 36/36 passed |
| bun scripts/directive-length.test.ts | 9/9 passed |
| bun scripts/approach-gate-tuning.test.ts | 13/13 passed |
| npm run -s test:ownership-judge | ALL PASS |
| npm run -s test:override-gate | ALL PASS |
| npm run -s test:assign-on-create | ALL PASS |
| bun test scripts/autowork-lane-starvation.test.ts | 26 pass, 0 fail, 77 expect() calls |

## C6 -- capUserText caps every client message at 4,000 and ignores `internal` -- CONFIRMED

Observation (executed `capUserText` imported from the real module, /tmp/claude-0/v2/c6.ts):
```
limits 4000 16000
4000 user ACCEPT
4001 user REJECT String must contain at most 4000 character(s)
4001 internal:true REJECT String must contain at most 4000 character(s)
16000 internal:true REJECT String must contain at most 4000 character(s)
```
- Entry points (huddle.functions.ts): `sendHuddleMessage` L7553 `capUserText(Input.parse(raw))`; `enqueueHuddleTurn` L8196 `capUserText(EnqueueTurnInput.parse(raw))`. `EnqueueTurnInput = Input.extend(...)` L7588.
- Drain path: `drainQueuedTurns`/run path L7966 `Input.parse(record.payload)` with `Input.text` `.max(INTERNAL_TEXT_MAX)` = 16000 (L232) -- server directives up to 16,000 still parse. directive-length suite: worst confirm ask 4814, worst work directive 7256, both under 16000.
- Every `internal: true` server enqueue (reminders.ts:271, grooming.server.ts:94, priority-check.server.ts:216, review-digest.server.ts:58, schedule-brief-run.server.ts:401, review-recheck.server.ts:50, standup.server.ts:155, autowork.server.ts:149/715, huddle.functions.ts:2012/2080/2168/7944) calls `enqueueTurn` from tasks/turns.server.ts directly -- none routes through `sendHuddleMessage`/`enqueueHuddleTurn`. ceremonies.server.ts:51 calls `runHuddleTurn` directly (server-side).
- Radius challenge (other client entry points not named in the brief):
  - `bargeCeremony` (L7561) -- `BargeInput.text` `.max(2000)`: tighter than 4,000. OK.
  - public route `routes/api/public/run-agent-turn.ts` -> `buildTurnInput` (cross-app/turn-gate.ts) rejects `text.length > TEXT_MAX` (4000) with `text_too_long`, and does not pass `internal` through. OK.
- Observation, not a defect of this fix: MeetingBar.tsx `fireStandupWorkTurn` (L607) wraps the user's spoken item in ~330 chars of directive and sends it through capped `enqueueHuddleTurn`; an utterance over ~3,670 chars would be rejected and the `.catch` swallows it silently. Same 4,000 limit existed before #144, so not a regression.
