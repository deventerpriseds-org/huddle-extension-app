<!--
WHAT:          Running build log for Lane A (F1, F2, F6) of the 1:1 hand-off / confirm / honesty fix: per-AC
               status, the offline test that pins it, and the mutation verdict for each new guard.
WHY:           Seven live failures on 2026-10-30 (see AC-handoff-confirm-flow.md WHY). Lane A owns: skip the
               hand-off when the addressed agent handled it or the owner said "now" (F1); a hand-off carries a
               real task + Confirm buttons (F2); never claim an unperformed board action (F6).
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      Spec: origin/claude_ac-handoff-confirm:docs/qc-evidence/AC-handoff-confirm-flow.md.
               Tests: scripts/handoff-lane-a.test.ts (`npm run test:handoff-lane-a`). Branch: claude_handoff-lane-a,
               REBASED 2026-11-04 onto origin/main d5c465e (was 9983343).
-->

# BUILD: hand-off Lane A (F1, F2, F6)

Scope: F1, F2, F6 only. Lane B owns tasks.server.ts, autowork.server.ts, turns.server.ts, create-task-core,
confirm-ask.functions.ts and the confirm-intent Block A region of huddle.functions.ts; none of those are edited here.

## Step 0 (2026-11-04, resumed after two container restarts): rebase onto main d5c465e

- Read first: #131 c0e8c40 (BUILD-plan-and-answer-first: PLANNING_SYSTEM_HINT, focus_on only on explicit
  start / priority-check reply, 1:1 answer-first via `lane-handoff.ts`), #132 4a4fbff (status answers), #133
  1ddd9ec (BUILD-context-and-confirm: `isPlainConfirmation` removed, Block A read-only, stream context,
  reminder tools).
- The local `claude_handoff-lane-a` ref is held by a dead agent's worktree, so the rebase ran on this worktree's
  branch and was pushed as `HEAD:claude_handoff-lane-a` (`--force-with-lease=claude_handoff-lane-a:9ce6b83`):
  9ce6b83 -> b531918.
- One conflict, the import block of huddle.functions.ts: kept BOTH #131's `lane-handoff` import and Lane A's
  `handoff-followup` import. The laneDirective region auto-merged: Lane A's `doItNowHere` branch sits first and
  #131's `laneAnswerFirstDirective` is the else branch (main's behaviour kept for every non-"now" ask).
- Nothing Lane A needed was fully covered by #131/#133, so nothing was dropped. Overlaps, and how they were
  reconciled:
  - #131 made the 1:1 agent ANSWER an out-of-lane question first and still says the owner will follow up. The
    owner's follow-up now receives the addressed agent's reply (`addressedReply`) and is told not to repeat,
    re-answer or paraphrase it (F1: no duplicate work). `stripTeammateDeferral` also strips #131's own wording
    ("<Name> knows this area best — I'm looping them in") when the runtime decided not to hand off.
  - #133 removed the pre-model "ok" confirm; Lane A never touched it (Lane B / F4 territory).
  - `test:plan-and-answer-first` W4 pinned the old 3-argument `deliverOwnerFollowup(ownerId, winner.name,
    data.text)` literal. Lane A adds arguments, so W4 now matches the call's prefix; removing the call still
    fails it.
- After the rebase: `tsc --noEmit` rc=0, Lane A suite 41/0 (pre-change), pushed.

## F1: skip the hand-off when handled or "now"

Code:
- `capabilities.ts` `classifyAsk` urgency: `NOT_URGENT_RE` guards (negated now, "bad time" now, "now that") on
  top of the existing `URGENCY_RE`. Still the ONE urgency classifier (AC-F1-11).
- `capabilities.ts` `laneHandoffSuppression` ("handled" from the agent's own toolUses via
  `tasks/board-claims.ts` `agentPerformedWork`, else "now"), `stripTeammateDeferral` (F1-4).
- `huddle.functions.ts`: pre-reply `oneToOneNowKeeps` replaces the defer-to-teammate `laneDirective` with a
  do-it-now directive; the follow-up block suppresses ONLY the semantic (LLM) lane hand-off on
  `laneSuppressed` and strips deferral sentences from the reply just pushed. Exclusive-capability and
  deterministic prime-holder hand-offs are tool-gated and still fire; with "now" they are delivered in
  `now` mode (`handoff-followup.ts`), which starts the work instead of asking to confirm (F1-3).

| AC | Status | Offline evidence |
|---|---|---|
| F1-1 | implemented (unit + wiring) | `laneHandoffSuppression` / `agentPerformedWork` tests; wiring source assertions |
| F1-2 | implemented; "A carries a work toolUse" is model behaviour driven by the do-it-now directive, live-only | urgency table + `oneToOneNowKeeps` wiring assertion |
| F1-3 | implemented (directive); B actually running the exclusive tool is live-only | `buildFollowupDirective` now-mode test |
| F1-4 | implemented for the synchronous (handled / now) skip | `stripTeammateDeferral` tests + wiring assertion |
| F1-5 | unchanged behaviour (+ F2) | suppression returns null test |
| F1-6, F1-7, F1-8 | unchanged gate `!data.internal`, `scope !== "group"` | wiring assertion + mutation (below) |
| F1-9 | unchanged (intent gate) | existing ask-classification suite passes |
| F1-10 | unchanged: suppressed hand-off delivers nothing, so `followupDelivered.size === 0` and the offer still appends | code read |
| F1-11 | one classifier | source assertion |
| F1-12 | no new await on the reply path (all new decisions synchronous) | code read; latency is live-only |
| S-U1..S-U14 | all rows pass | urgency spelling-table tests |
| F1 x #131 | follow-up carries A's reply + "do not repeat" clause; #131 wording stripped on no-hand-off | 7 tests in "F1 x #131" block |

Group 1 test run (2026-11-04): `test:handoff-lane-a` 48/0; `tsc` rc=0; plan-and-answer-first 35/0,
context-and-confirm ALL PASS, reminder-tools 83/0, status-answers 23/0, inbox-read 68/0, router 39/0, ask-shape,
ownership-judge, assign-on-create, override-gate, green-light, turn-identity, board-delete ALL PASS, cross-app
92/0, voice-tools 36/0, priority-check 43/0, nexus-write 115/0, nexus-tools 190/0, mode 22/22.

## F2: a hand-off carries a real task + Confirm buttons (2026-11-04)

Code:
- `handoff-followup.ts`: the CONFIRM-mode directive now tells the owner, in order, to (1) create ONE task for
  the ask through `create_huddle_task` with `ownerId` = itself (the shared create path and its dedup: AC-F2-10,
  no new write path; an existing open task with the title is reused), (2) call `propose_task_intent` on that
  task id, (3) send one warm message stating the proposed DoD and asking for the Confirm tap. Hand-off framing
  (tapped/passed, YOUR OWN channel, no at-sign) is kept (F2-5). "now" mode is unchanged (no create/propose).
- `create_huddle_task` result gains `task_id` = the canonical journey id (additive). Before this the model only
  saw the client card id `task-…`, so it could not chain `propose_task_intent` to the real row.
- `Input.handoff` (zod-declared: mode, fromName, ownerId, ask) rides the follow-up payload, so the owner's turn
  knows it is a hand-off without parsing the directive.
- `runHandoffAware` (huddle.functions.ts, the 1:1/primary run): if a confirm hand-off reply has no usable
  `propose_task_intent` (same test as the confirmAsk derivation, `proposedThisTurn`), re-run the owner ONCE in
  the same turn with `buildHandoffConfirmRetry`; both attempts' toolUses are merged, so a create in attempt 1
  and a propose in attempt 2 still render the buttons. Still missing -> a FallbackEvent + the visible note
  `confirm buttons unavailable — the hand-off task was not proposed` on the reply (AC-F2-4: never silent).

| AC | Status | Offline evidence |
|---|---|---|
| F2-1 | implemented via directive + shared create path; the task EXISTING is model behaviour, live-only | directive tests; `task_id` source assertion |
| F2-2 | implemented: directive + retry make `confirmAsk` the expected outcome; live-only | retry decision tests; wiring assertions |
| F2-3 | NOT Lane A: `proposeTaskDod` never sets `confirm_status='asked'` (CF-3) and lives in tasks.server.ts (Lane B) | n/a |
| F2-4 | implemented (retry once in-turn, then flag) | `needsHandoffConfirmRetry` / `handoffRetryOutcome` / marker tests; `runHandoffAware` source assertions |
| F2-5 | implemented | directive tests |
| F2-6 | unchanged button server fns (confirm-ask.functions.ts, Lane B) | n/a |
| F2-7 | unchanged: idempotent follow-up id; create dedup is the shared ledger + open-title snapshot | code read |
| F2-8 | directive says never claim an unsaved create; F6 presenter withholds an unbacked "added to your board" | F6 tests |
| F2-9 | live metric only | n/a |
| F2-10 | no new journey write path (`create_huddle_task` reused) | code read |

Known limit (recorded, not built): when `create_huddle_task` dedups against an EXISTING open task, it returns no
id (`loadOpenTaskTitles` returns titles only, create-task-core.ts = Lane B). The directive tells the owner to find
the id with its task tools; if it cannot, the retry runs and the reply is flagged rather than silent.
Known cosmetic: during the retry the 1:1 stream may briefly show the retry's partial text; the persisted reply is
the first attempt's.

Group 2 test run: `test:handoff-lane-a` 65/0; `tsc` rc=0; every suite in the group 1 list re-run, all rc=0.

Mutations: see the table at the bottom.
