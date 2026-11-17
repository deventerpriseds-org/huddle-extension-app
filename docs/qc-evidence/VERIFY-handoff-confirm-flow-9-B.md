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

## C4 -- confirm-ask buttons / 'asked' stamp
- Code read: `proposeTaskDod` (tasks.server.ts:1674-1719) INSERTs `confirm_status='asked'`, `confirm_ask_at = confirm_last_sent_at
  = now()`, count 1; ON CONFLICT never downgrades a `confirmed` row. Callers: huddle.functions.ts:4371-4372 and 5887-5888
  (both propose_task_intent dispatch paths).
- **CHALLENGE to the claim's causal wording.** The buttons do NOT appear because of the 'asked' stamp. They render from
  `m.confirmAsk` (HuddleView.tsx:924, 1463), which is derived per reply from the agent's own successful
  `propose_task_intent` tool use JSON detail (huddle.functions.ts:7256-7276, 7356) -- no DB read. What the 'asked' stamp
  does is make the ask THE pending one for a typed "yes": `getPendingConfirmForAgent` filters `es.confirm_status='asked'`
  ORDER BY `confirm_last_sent_at DESC` (tasks.server.ts:1242-1245). Button press reads the owned row and is a no-op only on
  `confirmed` (confirm-ask.functions.ts:54).
- DB test (local throwaway PG 16 via scripts/local-pg-up.sh, never Azure): `bun scripts/handoff-lane-b-db.test.ts` ALL PASS,
  incl. `AC-F4-3 fresh live proposal -> asked, last_sent set, ask_at == last_sent, count 1`.
- Mutation INSERT `'asked'` -> `'pending'`: mutate.sh returned UNDETERMINED (it cannot read this non-bun-test harness's
  `FAIL <name>` format), so it was applied by an exact-once python replace, run, then `git checkout` and asserted
  `git diff --quiet HEAD` (RESTORED-MATCHES-HEAD). Result: `FAIL AC-F4-3 fresh live proposal ... "confirm_status":"pending"`
  -- **FIRED** (no comment-only control run; the failure detail names the mutated field, so it is behavioural).
- **C4 verdict: CONFIRMED** that propose_task_intent stamps 'asked' and the buttons appear on that reply; the stated
  mechanism ("buttons appear BECAUSE of the stamp") is **imprecise** -- the stamp drives typed-yes binding, the reply
  derivation drives the buttons.

## C9 -- assist default + row 9 harness test-only threads
- `npm run -s test:mode`: 70/70 passed. workability.ts:133-138: the final fall-through of `classifyTaskMode` is
  `return "assist"` (PRODUCE_VERBS still route research/drafting to produce). Default-assist: **CONFIRMED** (code + suite;
  no mutation run -- budget).
- Harness qa-plan-and-answer-first.mjs: `journey:{enabled:false}` on every agent (l.45); every message `Test- <MARK>`;
  thread ids `test-dm-iris-chase-<MARK>` / `test-group-<MARK>` (l.120-121); cleanup SQL deletes pending_turns by
  `dur-<MARK>-%` id or payload text, and rag_chunks by MARK, then dispatches azure-pg-query.yml (l.205-224). CONFIRMED as written.
- **CHALLENGE (REFUTES "test-only threads" in full, by code reading, not executed):** case 5 ("1:1 BIG LANE WORK: still
  handed off by name", ctx ONE) is a 1:1 perform-intent message. huddle.functions.ts:7407-7424 then calls
  `deliverOwnerFollowup`, which enqueues a REAL durable turn in `dm-${ownerId}` (2094, 2120-2123) -- the owner's real
  1:1 thread, not a test- thread -- and that path fires the away-notification push. There is no `test-` huddle guard
  anywhere in src/features/huddle/lib (grep `startsWith("test-")`: none). The row is probably caught by the MARK cleanup
  (directive embeds `cleanAsk`, first 240 chars, which starts with `Test- <MARK>`), but the push to the phone and the
  visible reply in the real DM happen before cleanup. Concrete input: case 5's text in ONE (`test-dm-iris-chase-<MARK>`)
  -> follow-up in e.g. `dm-finn-reid` if the lane resolver picks a non-Iris owner. NOT executed (offline only).
- **C9 verdict: CONFIRMED (assist default); harness "test-only thread ids" = REFUTED by code reading for the 1:1
  hand-off case (UNSAFE: real-thread write + phone push), confidence medium -- depends on the lane resolver picking an
  owner != iris-chase for case 5, which is that case's stated purpose.**

## Summary
| Claim | Verdict | Evidence |
|---|---|---|
| Blast radius | CONFIRMED excluded | last-5 diff touches none of the 5 files |
| C5 | CONFIRMED; risk 2 REACHABLE (inference) | lane-b 7/0; confirm guard mutation FIRED (control EQUIVALENT); 8s race -> pass enqueues autowork-<run>-<id> beside live-work-<id> |
| C10 | CONFIRMED; tag-preservation test INERT | not-ai-task 6/0; withMyTaskTag->[tag] mutation INERT |
| C4 | CONFIRMED; causal wording imprecise | lane-b-db ALL PASS on local PG; 'asked'->'pending' FIRED; buttons come from reply derivation, not the stamp |
| C9 | default CONFIRMED; harness test-only threads REFUTED (code reading, UNSAFE) | mode 70/70; case 5 -> deliverOwnerFollowup -> real dm-<owner> + push |

Budget overrun: work finished at ~05:55 UTC against a 05:38 budget (clock jump observed between 05:32 and 05:54 during a
single grep call). Full suite re-run (tsc + all 7 suites) NOT REACHED; only lane-b, not-ai-task, mode, lane-b-db run.

LOOP-9-B-COMPLETE
