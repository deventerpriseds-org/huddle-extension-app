<!--
WHAT:          Build log for Lane B of the 1:1 hand-off / confirm / start-now fix: F3 (a live confirm starts the
               task now), F4 (a typed confirm reaches the ask on screen), F7 (one request, one task). One row
               per AC id: status / test / mutation verdict.
WHY:           Live failures read 2026-10-30 (AC file, observations 3, 4, 6): a typed "Confirmed" confirmed an
               older unrelated ask; confirmed tasks sat in BACKLOG until the 9/13/17 cadence; two identical
               messages produced 3 "Obtain official transcript" tasks.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      Spec: docs/qc-evidence/AC-handoff-confirm-flow.md on branch claude_ac-handoff-confirm (not copied
               here). Tests: scripts/handoff-lane-b-db.test.ts (local throwaway Postgres only),
               scripts/confirm-reask-db.test.ts, scripts/handoff-lane-b.test.ts. Branch claude_handoff-lane-b.
-->

# BUILD: hand-off lane B (F3, F4, F7)

Scope fence: Lane A owns `deliverOwnerFollowup` and its trigger, `capabilities.ts`, `handoff-followup.ts`,
`tasks/board-claims.ts` and the reply honesty presenter. F5 (workability / groom) waits on the owner. None of
those were touched here.

## Step log
- 2026-10-31: first two agents built a WIP on old main 9983343 (commit 9fed75e); both were killed by container
  restarts.
- 2026-11-04: re-based onto origin/main d5c465e. main had moved with #133 (1ddd9ec, owner-approved 2026-11-04),
  which REMOVED the pre-model `isPlainConfirmation` short-circuit that the WIP had rewritten. Per #133 and the
  brief, that short-circuit is NOT reinstated. Dropped from the WIP: the `isPlainConfirmation` rewrite, the
  `decideTypedConfirmBinding` + latest-reply binding in block A (`getLatestAgentReplyTurn`,
  `confirmAskTaskIdOfLatestReply` in turns.server.ts), and `scripts/handoff-confirm-binding.test.ts` (its only
  subject was the removed matcher). Kept: AC-F4-3/F4-4 stamping in `proposeTaskDod`.
- Read before touching code: #133 BUILD-context-and-confirm.md, #131 BUILD-plan-and-answer-first.md, #132
  BUILD-status-answers.md.

## F4 after #133: a typed confirmation reaches the ask the owner is replying to

How it works now (#133): block A is read-only; it hands the responding agent `getPendingConfirmForAgent`'s
row (newest `confirm_last_sent_at` = "last asked") as `confirmReplyDirective`, which carries the proposed DoD
and says a short affirmative confirms THAT task. The model's `confirm_task_intent` call is the writer.

The live failure that remained: `proposeTaskDod` (the handler behind every in-chat `propose_task_intent`) never
stamped `confirm_status='asked'` / `confirm_last_sent_at`, so a live ask (a hand-off, an in-chat proposal) could
never be "last asked". The directive therefore still named an older autowork ask, and the model was told to
confirm THAT task. Fixed by AC-F4-3 below.

| AC | Status after #133 | Where | Test |
|---|---|---|---|
| AC-F4-1 | STILL NEEDED -> done by F4-3: the live ask is now the last-asked row, so the directive names Y, not X | tasks.server.ts `proposeTaskDod` | confirm-reask-db "AC-F4-3 ... outranks an older autowork ask" |
| AC-F4-2 | COVERED by #133: there is no deterministic capture any more, so "ok great" after a status update writes nothing before the model reads it; the directive says "unless the rest of the conversation shows it answers something else", and #133's stream context shows the model what the latest message was | #133 block A | #133 context-and-confirm m1 |
| AC-F4-3 | DONE: `proposeTaskDod` stamps `confirm_status='asked'`, `confirm_last_sent_at=now`, `confirm_ask_at=now`, `confirm_ask_count>=1`; a confirmed row is never downgraded | tasks.server.ts | handoff-lane-b-db "AC-F4-3 fresh ...", "never downgrades"; confirm-reask-db "AC-F4-3 ..." |
| AC-F4-4 | DONE: `confirm_ask_at` = the same instant, so the row is not armed-unsent (no second autowork send); count only raised to 1, never incremented (autowork's `claimConfirmAskSend` CAS key) | tasks.server.ts | handoff-lane-b-db "AC-F4-4 future-armed ... NOT still due"; confirm-reask-db "AC-F4-4 ..."; confirm-reask-rotation + confirm-spacing suites |
| AC-F4-5 | OBSOLETE: `isPlainConfirmation` no longer exists (#133); the model judges the reply | -- | -- |
| AC-F4-6 | COVERED: `getPendingConfirmForAgent` filters `assigned_agent = dmAgent` (unchanged) | tasks.server.ts | confirm-reask-db AC-27 |
| AC-F4-7 | OBSOLETE as a deterministic rule (#133: model decides); the directive still says "if they declined or are still deciding, don't call the tools" | #133 | -- |
| AC-F4-8 | COVERED by #133: no client input picks a task; the directive's task comes from the durable store | #133 | -- |
| AC-F4-9 | confirm half COVERED by #133 (model confirms on "do it now"); start-now half is F3 (typed confirm in a non-internal turn is a live confirm) | F3 | see F3 |
| AC-F4-10 | DONE via F4-3 (the directive carries the last-asked task, which is now the live ask) | -- | E2E only |
| AC-F4-11 | see F3 (typed confirm reaches the same start-now step as the button) | F3 | see F3 |

Superseded test premise (deliberate): `confirm-reask-db.test.ts` AC-27 used `proposeTaskDod` as the "unrelated
write that bumps updated_at". Since AC-F4-3 a proposal IS a send, so the fixture bumps `updated_at` directly, and
a new check asserts the F4 behaviour. Its source check "the deterministic 'yes' path confirms exactly
getPendingConfirmForAgent's task" still asserted the pre-#133 `confirmTaskIntent(pc.taskId, ...)` text, so it was
failing on main after #133; it now asserts #133's read-only shape (directive from `getPendingConfirmForAgent`, no
`isPlainConfirmation(` call) and the unchanged voice path.

## F3: a confirm from a live conversation starts THAT task now (owner Option A)

Live confirmation = the Confirm button or voice (both via `confirmTaskFromProposal`), or the agent's
`confirm_task_intent` call in a NON-internal turn (the #133 typed path). A model confirm inside an internal turn
(autowork, groom, follow-up, worker, reminder) is never live.

Shape (extends, no new promoter, no second confirm writer):
- `tasks.server.ts`: three columns on `task_engagement_state` (`live_start_at`, `live_start_via`, `live_started_at`);
  `markLiveConfirm` (WHERE `confirm_status='confirmed'` -- fail closed), `claimLiveStart` (CAS), `releaseLiveStart`;
  `resetEngagementOnReassignment` clears them.
- `autowork.server.ts` (the promoter file): pure `liveStartDecision`; `advanceLiveConfirmedTask` (targeted DOING write of
  that ONE task + work turn `live-work-<id>-<ms>`, or the approach turn `live-approach-<id>-<ms>`); `kickLiveConfirm`
  = THE kick point (mark, then advance). Owner defaults: bypasses the DOING cap AND the REVIEW freeze, for that task only.
- Callers: `confirmTaskFromProposal` (button, voice `via:"voice"`; not REMIND mode; marker awaited, advance in background);
  `confirm_task_intent` handler, both paths (`recordLiveTypedConfirm`, returns at once when `data.internal`); every turn exit
  (`advanceLiveConfirmedTasks`: start, or enqueue the approach step if the agent skipped `propose_approach`);
  `runApproachGate` on a PASS (shared by both text paths); `overrideEscalatedApproach` after an applied override.
- `runScheduledAutoWork` is unchanged: it never reads the marker, and a live-started DOING task fills that agent's slot.

| AC | Status | Test |
|---|---|---|
| AC-F3-1 | DONE: button/voice enqueue the approach turn at confirm; typed path proposes in the same turn, safety net at turn end | handoff-lane-b "AC-F3-1 ..." (2) |
| AC-F3-2 | DONE: approval (grader pass, or override) -> targeted DOING + work turn | "AC-F3-2 ..." (2) |
| AC-F3-3 | DONE (DOING cap bypass; REVIEW freeze bypass per owner default) | "AC-F3-3/F3-7 ... DOING=1, REVIEW=2 and rank 10" |
| AC-F3-4 | DONE (pass unchanged) | "AC-F3-4 ..." (3) + control (free slot IS promoted); lane-starvation 26/0 |
| AC-F3-5 | DONE: marker server-written by live paths only; no marker = caps | "AC-F3-5 ..." (3), DB "claimLiveStart refuses ..." |
| AC-F3-6 | DONE: fail closed on marker / confirm / approach / requirement throw | "AC-F3-6 ..." (7 unit + 3 DB) |
| AC-F3-7 | DONE | "AC-F3-3/F3-7 ..." |
| AC-F3-8 | DONE: one `update_task` for that id; no confirm ask sent | "AC-F3-8 ..." (2) |
| AC-F3-9 | DONE: one kick (`kickLiveConfirm`), one confirm writer per surface, DOING written only in autowork.server.ts | "AC-F3-9 ..." (2) |
| AC-F3-10 | DONE: REMIND confirm marks nothing, starts nothing | "AC-F3-10 ..." (3) |
| AC-F3-11 | DONE: alreadyDone re-marks nothing; CAS claim; deterministic turn ids | "AC-F3-11 ..." (4 unit + 2 DB incl. 3-way race) |
| AC-F3-12 | COVERED by ordering: the approach turn runs after `confirmTaskIntent` wrote `confirmed_dod`, which `runApproachGate` reads | -- (no new code) |
| AC-F3-13 | NOT OFFLINE-TESTABLE (live grader quality) | E2E only |
| AC-F3-14 | DONE | "AC-F3-14 an owner override starts a live task" (source) |
| AC-F3-15 | DONE: the button awaits one UPDATE; advance runs in the background | design; "AC-F3-1 a button confirm ..." waits 20ms for the background advance |
| AC-F3-16 | OUT OF LANE (honesty presenter is Lane A's) | -- |
