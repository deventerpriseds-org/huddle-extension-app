<!--
WHAT:       Loop-9 pass B independent verification of claims C5, C10, C4, C9 (handoff-confirm-flow) at e45abd80.
WHY:        Loops 7 and 8 did not reach these claims (verifiers killed by restarts); loop 9 splits into 4 parallel passes.
SUPERSEDES: nothing (sibling passes 9-A, 9-C18, 9-C27 cover the other claims).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:   commands and output inline below; branch claude_verify-handoff-confirm-flow-9-b.
-->
# VERIFY handoff-confirm-flow loop 9 pass B

Target HEAD: e45abd80 (origin/claude/modest-brown-2hdt5n). Started 05:26 UTC, budget 12 min.

## Blast radius
`git diff e45abd80~5..e45abd80 --stat`: .claude/actions.md, scripts/board-claims-f6.test.ts, scripts/handoff-lane-a.test.ts,
scripts/one-request-one-task.test.ts, src/features/huddle/lib/capabilities.ts, src/features/huddle/lib/tasks/board-claims.ts,
src/features/huddle/lib/tasks/create-task-core.ts. CONFIRMED: none of workability.ts, approach-gate.server.ts,
autowork.server.ts, confirm-ask.functions.ts, groom.ts changed. Challenge: create-task-core.ts did change; it is the task
create path, not the confirm/approach/not-ai paths of C4/C5/C9/C10, so the exclusion stands (inference, from file names + grep).

## C5 -- F3 live start
- `npm run -s test:handoff-lane-b`: 7 pass / 0 fail.
- Mutation `liveStartDecision`: `if (state.confirm_status !== "confirmed") ...` -> `if (false) ...` (autowork.server.ts:1323),
  test `F3 liveStartDecision table`: **FIRED (control EQUIVALENT)**. (A first run with pattern `FAIL AC-F3-6` reported
  UNDETERMINED because mutate.sh keys on the bun test name; re-run with the exact name fired.)
- Risk 2 (loop 4 NOT PROVEN): approach-gate.server.ts:264-275 races `advanceLiveConfirmedTask` against 8s. On timeout
  `liveStarted=false`, so `kickAutoWorkAfterApproval` runs `runScheduledAutoWork({force:true})` while the advance is still
  in flight. The pass pushes every ready DOING-slot task into `doingCandidates` (autowork.server.ts:1096-1097) and, if
  the task has no artifact, enqueues `autowork-${runId}-${task.id}` (1248-1260) -- an id disjoint from the advance's
  `live-work-${taskId}-${claimed}` (1423). No in-flight-turn check exists between them (grep for inFlight/pendingTurn: none).
  So YES, a SECOND work turn for the same task is reachable: if the advance's DOING write lands before the pass reads the
  board, both enqueue. If it lands after, the pass may also promote it from UP_NEXT (cap permitting). Verdict on risk 2:
  **REACHABLE by code reading, not executed** (offline, no timing harness). Note the same re-enqueue happens on every
  later scheduled pass for any DOING task without an artifact -- pre-existing retry design -- so the race adds an
  earlier duplicate, not a new class. Severity: possible duplicate research turn/artifact; not a gate bypass (both paths
  still require confirmed + approved).
- **C5 verdict: CONFIRMED** (gate FIRED); risk 2 = REACHABLE (inference, confidence medium-high), not a gate defect.

## C10 -- Not an AI task
- `npm run -s test:not-ai-task`: 6 pass / 0 fail.
- Code read (confirm-ask.functions.ts:667-708): ownership via `getOwnedTaskForConfirmAsk(data.taskId, email)` -> "Task not
  found" for a non-owner; `update_task` with `status:"BACKLOG", assigned_agent:"", tags: withMyTaskTag(existingTags, ...)`;
  `resetEngagementOnReassignment(taskId)` on success; `withMyTaskTag` (667-669) appends without dropping existing tags.
- Mutation `withMyTaskTag` body -> `return [tag];` (drops every existing tag; update_task REPLACES tags, so this would wipe
  e.g. `parking-lot`/`finance`), test `the action: Backlog, agent cleared, my-task ADDED to the existing tags`: **INERT**.
  Not behaviourally equivalent. The test only asserts the call-site string, so the "ADDED to the existing tags" property
  it is named for is UNGUARDED. Production code is correct today by reading.
- **C10 verdict: CONFIRMED (behaviour, by code read + string tests); guard gap: tag-preservation test INERT** -- a one-line
  behavioural test `expect(withMyTaskTag(["finance"],"my-task")).toEqual(["finance","my-task"])` would close it (observation
  of the gap; the fix wording is a suggestion, not a design).

