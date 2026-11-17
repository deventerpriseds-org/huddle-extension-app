<!--
WHAT:       Loop-4 independent verification of the handoff-confirm-flow work (C1-C10), offline only.
WHY:        Loops 1-3 were killed by container restarts; C2 refuted 3x; C5/C7/C8/C10 never verified.
SUPERSEDES: VERIFY-handoff-confirm-flow-3.md (origin/claude_verify-handoff-confirm-flow-3) -- incomplete.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:   commands + outputs inline below; base origin/claude/modest-brown-2hdt5n.
-->
# VERIFY handoff-confirm-flow — loop 4

Offline only (no live app, no real DB). Started 01:58 UTC, budget 45 min.

## Baseline suite (re-run by verifier)
`npx tsc --noEmit` EXIT=0; all 11 suites EXIT=0 (lane-a 118 tests, lane-b 7, board-claims 20, not-ai-task 5,
one-request-one-task 9, mode 70/70, context-and-confirm ALL PASS, plan-and-answer-first 35/0, router 39/0,
reminder-tools 83/0, timeout-no-rerun 12). node_modules symlinked from the main checkout (bun install 403'd).
Diff scope vs merge-base 4abde5af: 13 src files, +1109/-36. **autowork.server.ts diff is ONLY the F3 block**
(no change to the background pass's candidate selection) -- relevant to C10.

Mutation harness note: mutate.sh does not read bun's `(fail) <name>` format (returns UNDETERMINED, exit 4);
wrapped with `buntap.sh` = `bun test "$@" 2>&1 | sed 's/^(fail) /not ok - /'; exit ${PIPESTATUS[0]}`.

## C5 F3 live start -- CONFIRMED (with 2 NOT PROVEN edge risks)
Observed (read autowork.server.ts:1304-1461, tasks.server.ts:1626-1664, approach-gate.server.ts:259-292,
confirm-ask.functions.ts:116-128, huddle.functions.ts:2317-2357):
- liveStartDecision is fail-closed: no marker / already started / confirm_status!=='confirmed' / unassigned or
  unknown agent / DOING|IN_REVIEW|DONE / parking-lot / reminder tag or reminder window / clarify open / approach
  not approved while required (required = verdict !== false; a throwing read -> true) => no start.
- Two DB-level guards back it: markLiveConfirm `WHERE confirm_status='confirmed'`; claimLiveStart CAS
  `live_start_at IS NOT NULL AND live_started_at IS NULL AND confirm_status='confirmed'`. reset clears all 3 cols.
- Only THAT task's status is written (update_task task_id=taskId status DOING), work turn id `live-work-<id>-<claim>`.
- Background pass: autowork diff contains no reads of live_* columns -> caps unchanged for everything else.
- Live sources: button + voice (confirmTaskFromProposal, via button|voice, skipped for REMIND), typed
  (recordLiveTypedConfirm, `if (data.internal) return`). Every system turn payload checked carries internal:true
  (autowork.server.ts:150/794, groom, standup, reminders, follow-up huddle.functions.ts:2137/2207/2295, ...).
- approach-gate: advanceLiveConfirmedTask raced at 8s FIRST, then kickAutoWorkAfterApproval only if not started.
  Note text: "in Doing" only when started===true (set after a successful DOING write) -> truthful.
Mutations (mutate.sh, test 'F3 liveStartDecision table'):
- `confirm_status !== "confirmed"` guard -> `if (false)` : FIRED (control EQUIVALENT), exit 0
- `if (required && approach_status !== "approved")` -> `if (false && ...)` : FIRED (control EQUIVALENT), exit 0
NOT PROVEN risks (inference, not executed):
1. Latency: approval path is now up to 8s (live race) + 8s (general kick) = 16s inside an agent turn (was 8s).
2. If the live advance exceeds 8s it keeps running while kickAutoWorkAfterApproval runs a full pass; whether the
   pass can enqueue a second work turn (different id) for the task the live path just moved to DOING was not
   exercised offline.

## C7 F6 board-claim honesty -- REFUTED (false rewrites of performed actions)
Summary strings the predicates key on DO match what dispatch records (read huddle.functions.ts):
`journey-voice · ok` (5232/6918), `deferred — task assigned to X, not Y` (5193), `“T” → Huddle board + journey`
(3320), `created N/M → Huddle board + journey` (3547), `... — skipped duplicate` (3185/3203), `Huddle-only` (3591).
Wiring: presentedReplies = presentBoardClaims(presentNexusWriteTurn(...), toolUses) at huddle.functions.ts:2384;
toolUses is turn-level and resumed across chunks (`resume ? [...resume.toolUses]`, :1040).
Mutation: agent scoping `toolUses.filter(u => u.agentId === r.agentId)` -> `toolUses`:
FIRED (control EQUIVALENT) on 'another agent's write never backs this agent's claim'.

Probe (docs/qc-evidence/verify-handoff-confirm-flow-4-c7-probe.ts, `bun` it) -- 13/19 MISS:
FALSE REWRITES of TRUE statements (the agent DID the thing; the owner is told it did nothing):
| reply | the agent's toolUse | presented as |
|---|---|---|
| "I moved the task to Thursday." | move_task_to_day, journey-voice · ok | "Nothing was changed on the board for that." |
| "I moved that task to 3pm tomorrow." | reschedule_task, journey-voice · ok | "Nothing was changed on the board for that." |
| "I set a reminder for that task at 3pm." | schedule_reminder ok | "Nothing was changed on the board for that." |
| "I created a research brief for the task." | create_artifact ok, /artifacts/abc | "Nothing was added to the board for that." |
| "I completed the research for that task — the brief is attached." | create_artifact ok | "Nothing was changed on the board for that." |
Cause: STATUS_TOOLS = {update_task, batch_update_tasks} only; journey's catalog
(journey-voice supabase/functions/_shared/tool-definitions.ts:97/112/127/320) also exposes reschedule_task,
schedule_task, unschedule_task, move_task_to_day, and STATUS_CLAIM_RE fires on any "I set/moved/completed" next to
the word "task". OFF_BOARD_RE excludes email/notes but not reminders, calendars, documents, briefs.
(Inference, not executed: that journey's catalog fed to huddle via ensureJourneyTools is this tool-definitions.ts.)
UNDER-MATCH (false claims passed unchanged): "All set — it's marked as complete.", "Task moved to Done.",
"✅ Marked done.", "I've gone ahead and marked it done.", "I went ahead and moved it to Done.",
"I've now added it to your board.", "It's been added to your board.", "We marked it done."
The S-B reference cases pass ("I marked 'Order Nike Pegasus Premium' done." rewritten; "I'm proceeding with the
research." rewritten; deferred update -> "passed to the task's owner").

## C10 "Not an AI task" button -- CONFIRMED (1 residual risk)
Observed: notAiTaskFromButtonFn (confirm-ask.functions.ts:671-698): resolveCallerEmail -> getOwnedTaskForConfirmAsk
(ownership guard) -> idempotent short-circuit when already BACKLOG + my-task + unassigned -> update_task
{status BACKLOG, assigned_agent "", tags: withMyTaskTag(existing)} (full tag set; update_task replaces tags).
journey side (local /home/user/journey-voice checkout, execute-tool/index.ts ~991-994; NOT fetched from origin):
`if (args.assigned_agent !== undefined) updateData.assigned_agent = args.assigned_agent ? String(...) : null` -> "" clears.
Autowork never picks it up because every automation reader requires an assignee: getDueConfirmAsks
`jt.assigned_agent IS NOT NULL` (tasks.server.ts:1190), liveStartDecision `!task.assigned_agent` -> no start,
getOpenAssignedTasks. autowork.server.ts itself has NO my-task check (diff is F3-only); groom.ts:252-255 excludes
my-task from the groomable set (so groom never re-assigns), keeps it in groomTags, and feeds <=20 titles as examples.
Only other assignment writer: assign-on-create.ts:162 (create time only).
Button: HuddleView.tsx:1004-1018 on the ConfirmAskRow, disabled while busy.
Mutations (test 'grooming never re-assigns a my-task task and feeds its title in as an example'):
- drop `!(t.tags ?? []).includes(MY_TASK_TAG)` from the groom filter: FIRED (control EQUIVALENT)
- same drop but the dropped text left in a trailing `//` comment: FIRED (control EQUIVALENT) -> the source-text test
  is comment-proof.
Residual risk (inference): the action does not touch tasks.task_engagement_state, so confirm_status / live_start_at
survive. If the owner later re-assigns the task to an agent, a stale live marker would let the next approach
approval live-start it past the caps without a fresh live confirm.

## C8 row 7 one-request-one-task -- REFUTED on over-match (distinct tasks silently dropped)
Wiring CONFIRMED on all 4 create paths: create_huddle_task (huddle.functions.ts:3198), create_huddle_tasks (:3473),
raw journey creates via create-task-core.ts:215 (guardRawJourneyCreate), voice (realtime-tools.server.ts:759).
Key and open set both normalizeTaskTitle (huddle.functions.ts:2044 `const normTitle = normalizeTaskTitle`).
Mutation: word floor `>= 3` -> `>= 1`: FIRED (control EQUIVALENT) on '"Call mom about Sunday dinner" -> false'.
Probe (docs/qc-evidence/verify-handoff-confirm-flow-4-c8-probe.ts, real normalizer) -- every one of these is a
DIFFERENT task the owner asked for, and each is blocked as "an open task with this title already exists":
| open on board | new request | matchesOpenTitle |
|---|---|---|
| Draft blog post | Draft blog post on onboarding | true (blocked) |
| Buy birthday gift | Buy birthday gift for Sarah | true (blocked) |
| Research AI tools | Research AI tools for legal contract review | true (blocked) |
| Book flight to Denver | Book flight to Denver for the June wedding | true (blocked) |
| Pay the bill | Pay the bill for the dentist | true (blocked) |
| Email John Smith | Email John Smith the signed lease | true (blocked) |
| Schedule a meeting | Schedule a meeting with the landlord | true (blocked) |
| Write a review | Write a review of Q3 sales numbers | true (blocked) |
Any >=3-word generic open title swallows every more specific request that starts with it. The cross-turn skip
returns `{ok, deduped, task:{title}}` with NO existing task_id (huddle.functions.ts:3206), so the agent cannot even
point at which open task it matched. Under-match (minor): the reverse case (new title shorter than the open long
one, e.g. open "Transcribe the call recording and send it directly to um-flint", new "Transcribe the call
recording") is NOT a dup. Whether a prefix rule is an acceptable trade is an owner call; as an implementation of
"one request makes one task" without dropping distinct requests, it fails.

