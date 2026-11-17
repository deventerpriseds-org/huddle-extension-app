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

