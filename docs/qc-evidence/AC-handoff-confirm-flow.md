<!--
WHAT:          Acceptance criteria (written BEFORE code) for the 1:1 hand-off / confirm / start-now flow fixes F1-F8.
WHY:           Seven live failures read from chat.pending_turns + tasks tables on 2026-10-30: duplicate hand-off
               after Iris already orchestrated work; hand-offs with no task and no Confirm buttons; typed
               "Confirmed" binding to an older unrelated ask; confirmed tasks sitting in BACKLOG until the
               9/13/17 cadence; a fabricated "I marked X done"; 3 duplicate tasks from 2 identical messages;
               task-mode mis-classification in both directions (false REMIND, false PRODUCE).
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      Code read cold at origin/main 9983343 (sources listed below). Observations as given in the brief.
AUTHOR:        independent AC-writing subagent (no access to the implementer's plan).
-->

# Acceptance Criteria: 1:1 hand-off, confirm and start-now flow (Tier 1)

Task: make a 1:1 ask get done by whoever was asked when they can, hand off only when genuinely needed
(and then with a real task and Confirm buttons), start confirmed work immediately, bind a typed
confirmation to the ask it answers, never claim an unperformed board action, never create the same task
twice for one request, and judge task mode (produce / assist / remind) from the agent's real tools.

Tier: **1**. It gates the confirm-intent/DoD safety gate and WIP promotion, and it admits model output
into stored claims (a board-action claim, a proposed DoD).

## Sources read (this session, at 9983343)

- `src/features/huddle/lib/huddle.functions.ts`: `isPlainConfirmation` (650-659), pending-confirm capture
  block A (714-768), unblock block B (770-833), produce-confirm path and the only in-turn
  `runScheduledAutoWork` kick (1640-1722), `deliverOwnerFollowup` (1963-2021), `presentedReplies` (2214),
  reply assembly and `confirmAsk` derivation from `propose_task_intent` (6712-6835), 1:1 follow-up trigger
  (6858-6923).
- `src/features/huddle/lib/capabilities.ts`: `classifyTurnIntent` and the ACKNOWLEDGE/QUERY/STATUS/INFORM
  regexes (10-127), `classifyAsk` and `URGENCY_RE` (138-170).
- `src/features/huddle/lib/tasks/tasks.server.ts`: `getPendingConfirmForAgent` (1207-1244).
- `src/features/huddle/lib/tasks/confirm-ask.functions.ts`: `confirmTaskFromProposal` (39-127),
  `overrideEscalatedApproach` (181-243), button server fns (572-667).
- `src/features/huddle/lib/tasks/workability.ts` (whole file): `classifyTaskMode`, `modeProposalHint`,
  `REMINDER_TAG`.
- `src/features/huddle/lib/tasks/autowork.server.ts`: caps (48-50), `classifyTaskMode` caller (148), ready
  predicate (912-930), `runScheduledAutoWork` (695-1000).
- Further sources are appended per section below as they are read.

## Existing systems these fixes MUST extend (not duplicate)

| Need | Existing owner (extend it) | A parallel copy is an AC failure |
|---|---|---|
| "is this a confirmation" | `isPlainConfirmation` (huddle.functions.ts:650) | a second confirm regex elsewhere |
| "is this urgent / now" | `classifyAsk` / `URGENCY_RE` (capabilities.ts:147-156), built on `classifyTurnIntent` | a new "now" regex in huddle.functions.ts |
| "is this a perform request" | `classifyTurnIntent` (capabilities.ts:117) | a new intent classifier |
| hand-off delivery | `deliverOwnerFollowup` (huddle.functions.ts:1963) | a second enqueue path for hand-offs |
| Confirm/Backlog/Archive buttons | `reply.confirmAsk`, derived from a successful `propose_task_intent` toolUse (6713-6740), rendered by `ConfirmAskRow` (HuddleView.tsx:675) | a new button widget or a new reply field |
| confirm unlock | `confirmTaskFromProposal` (confirm-ask.functions.ts:39), the one server-authoritative unlock | a second confirm writer |
| approach override | `overrideEscalatedApproach` (confirm-ask.functions.ts:181) | none |
| WIP promotion | `runScheduledAutoWork` (autowork.server.ts:695) | a second promoter writing DOING outside it |
| reply honesty for writes | `presentedReplies()` / `presentNexusWriteTurn` (huddle.functions.ts:2214) | a separate per-agent honesty filter |
| task-create dedup | `screenRawJourneyCreate` + `createdTaskTitles` + `loadExistingOpenTitles` | a third dedup layer with a different key |
| task mode | `classifyTaskMode` (workability.ts), single caller autowork.server.ts:148 | a second mode classifier (for example in groom.ts) |

## Code facts that shape these ACs (observed, not inferred)

| # | Observation (file:line) | Consequence for the ACs |
|---|---|---|
| CF-1 | The 1:1 follow-up decision (huddle.functions.ts:6872-6922) runs AFTER the addressed agent's reply is assembled, with that agent's `r.toolUses` in scope, but reads only `data.text`. | F1 can and must decide from what the agent actually DID this turn (for example a successful `delegate_to_specialist`, recorded at 2402-2407). |
| CF-2 | `deliverOwnerFollowup`'s directive (1988-1994) says "ask them to confirm before you act … do not perform the work yet" and creates no task. | No `propose_task_intent` is possible for a task that does not exist, so `confirmAsk` cannot render (6720-6740). This is the mechanism behind observation 2. |
| CF-3 | `proposeTaskDod` (tasks.server.ts:1594-1617), the handler behind every live `propose_task_intent`, writes only `proposed_dod` / `proposed_reminder_at`. It never sets `confirm_status='asked'` or `confirm_last_sent_at`. | `getPendingConfirmForAgent` (1207-1244) filters `confirm_status='asked'` and orders by `confirm_last_sent_at`. A live ask can therefore never be "the pending ask", and a typed confirm binds to whatever older autowork ask exists. This is the mechanism behind observation 3. |
| CF-4 | `classifyAsk().urgency` (capabilities.ts:153-156) has NO consumer in `src/` (grep `.urgency`, `URGENCY_RE`). Its only caller, `bargeAckLine`, uses `.type` and is itself unreferenced. | "Do it now" is classified today and then ignored. F1/F3 must wire this existing classifier rather than add a new one. |
| CF-5 | `URGENCY_RE` currently returns `now` for "not now", "don't do it now", "now that you mention it", "right now is a bad time" (measured with bun against the real module, see the spelling table). | The classifier must be fixed before anything relies on it. |
| CF-6 | `confirmTaskFromProposal` (confirm-ask.functions.ts:39-127) confirms and writes the DoD. It kicks nothing. The only in-turn `runScheduledAutoWork` call is the produce path (huddle.functions.ts:1714-1718). | A button confirm runs no turn, so no `propose_approach` happens until the 9/13/17 approach re-drive (autowork.server.ts:940-990). This is the mechanism behind observation 4. |
| CF-7 | `runScheduledAutoWork` promotes BACKLOG to UP_NEXT only for the first `room = UP_NEXT_CAP - upNext.length` backlog items by rank (autowork.server.ts:792-795). Only those plus existing UP_NEXT can reach DOING (797-799, 925-931). | A confirmed task that is ranked low, or whose agent's UP_NEXT is full, NEVER reaches DOING, even with `force: true`. F3 must move the specific confirmed task, not rely on top-up. |
| CF-8 | `maybeDeferStatusChange` returns `{ok:true, deferred:true}` and the toolUse is recorded `ok=true` (huddle.functions.ts:4809-4817). A dedup-skipped create is also recorded `ok=true` (1663-1665, `describeRawCreateSkip`). | F6 must not treat `ok=true` as "performed". Deferred and skipped are not performed. |
| CF-9 | Open-title dedup is a once-per-turn snapshot of the eventually consistent Huddle mirror (huddle.functions.ts:1944-1951, create-task-core.ts:109-128), and the ledger `createdTaskTitles` is per turn. | Two concurrent turns (user turn, follow-up turn, worker turn) cannot see each other's creates. This is one plausible mechanism for observation 6, but see Gap G-6. |
| CF-10 | groom.ts:231 says "When in doubt, ADD the tag", and groom.ts:394-399 re-adds any `reminder` tag already present (CONTROL_TAGS), whatever the model returns. | The prompt's "keep it unless it is now plainly agent-doable" (233-234) cannot be honoured. A wrong `reminder` tag is permanent until a human removes it. |
| CF-11 | `classifyTaskMode` (workability.ts) measured on the live titles: "Obtain…", "Subscribe…", "Start…", "Fix…", "Apply…", "Order…", "Integrate…" all return `produce` (no verb list matches, so the default applies). "Prepare my office camera quality" returns `produce` ("prepare" is a produce verb). Any `reminder` tag returns `remind`. | Confirms the coordinator's F5 evidence in both directions. |
| CF-12 | Autowork turns run with `journey: {enabled:false}` (autowork.server.ts:103-108). The follow-up turn passes the user's `data.agents` through (huddle.functions.ts:2010). | Board writes from a follow-up depend on the caller's journey flag. Harness runs with journey off must create no board rows (F2-9). |

---

## F1: Skip the hand-off when the addressed agent already handled it, or the owner said "now"

Goal: whoever is asked does the work immediately when they can. A hand-off happens only when the
addressed agent genuinely should not do it.

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-F1-1 | Given a non-internal 1:1 message to agent A whose intent is `perform`, when A's reply in the SAME turn carries a successful work toolUse for the ask (`delegate_to_specialist` ok, `create_artifact` ok, or a task create that actually wrote a row), then NO follow-up turn is enqueued for any other agent. | happy-path | `chat.pending_turns` contains 0 rows with `id LIKE 'followup-dm-<A>-%'` and `created_at` at or after the user turn's `created_at`. Unit test drives the follow-up decision with injected `toolUses` and asserts `deliverOwnerFollowup` is not called. |
| AC-F1-2 | Given the user message classifies `urgency = "now"` (via the EXISTING `classifyAsk`, corrected per the spelling table) and no EXCLUSIVE capability (`capabilityOwnerFor`) belongs to another agent, when A replies, then no follow-up is enqueued, AND A's reply carries at least one successful work toolUse in that same turn (not only a promise). | happy-path | Same `pending_turns` query = 0; the reply's `toolUses` contains `delegate_to_specialist`, `tavily_web_search` or `create_artifact` with `ok=true`. |
| AC-F1-3 | Given a "now" ask whose capability IS exclusive to agent B (for example backlog grooming, owned by Terry), when A replies, then exactly ONE follow-up is enqueued to B, and B's turn starts the work in that turn (the "now" counts as the owner's live confirmation, per F3-3), rather than asking "confirm and I'll get started". | alternate | One `followup-dm-<A>-<B>-…` row. B's reply `toolUses` includes the exclusive tool (for example `groom_backlog`) with `ok=true`. B's reply text does not contain "confirm" followed by "get started" / "before I". |
| AC-F1-4 | Given the decision is "no hand-off", when A's reply text is presented, then it contains no deferral to a named teammate ("loop in <Name>", "passed this to <Name>", "<Name>'s better suited", "<Name> will reach out"). The directive and the follow-up must never disagree. | error | Harness regex over the persisted reply text for each AGENT first name other than A, combined with the deferral phrases. 0 matches. |
| AC-F1-5 | Given the decision is "hand off" (no work toolUse by A, owner B ≠ A, intent perform, not "now" or exclusive), when the turn ends, then exactly one follow-up is enqueued to B (unchanged behaviour), and it satisfies all of F2. | alternate | One `followup-…-<B>-…` row. Then F2-1..F2-4. |
| AC-F1-6 | Given A delegated to a worker (Iris's observed path, turn ids `worker-orch-…`), when the worker and integration complete, then the integration turn (`integrate-orch-…`, internal) does not enqueue any follow-up either. | regression | `pending_turns` has 0 `followup-%` rows created by the integration turn (internal turns never spawn follow-ups, huddle.functions.ts:6875). |
| AC-F1-7 | Given `data.internal === true` (autowork, groom, follow-up, worker, integration, reminder), then no follow-up is ever enqueued. | regression | Existing gate at 6875 still present. A mutation that removes `!data.internal` makes a unit test fail (mutate.sh FIRED). |
| AC-F1-8 | Given `scope === "group"`, then the 1:1 follow-up path never runs (group uses router re-queue and mentions). | regression | Group turn: 0 `followup-%` rows. `capability-ownership-test.mjs` group cases unchanged. |
| AC-F1-9 | Given an ask classified `acknowledge` / `query` / `status` / `inform`, then no follow-up is enqueued (unchanged). | regression | Unit test over the existing intent fixtures. |
| AC-F1-10 | Given the deep-ask produce offer is pending for A's reply and the decision is "no hand-off", when the turn ends, then the produce offer is appended as before (`ensureProduceOfferDelivered`, 7084-7099), and it is NOT appended when a hand-off was delivered. | regression | Reply text contains the offer line iff `followupDelivered.size === 0`. |
| AC-F1-11 | Urgency is decided by ONE classifier: `classifyAsk` in capabilities.ts. No second "now" regex exists anywhere. | extend-not-duplicate | `grep -rn "right away\|asap\|right now" src --include=*.ts` returns only capabilities.ts (plus prompt prose, which is not a matcher). |
| AC-F1-12 | Latency: the follow-up decision adds no blocking wait to the user's reply beyond the existing bounded LLM owner resolution (fire-and-forget, 6903-6920). | performance | Durable harness: time from enqueue to the first reply chunk is not worse than the pre-change baseline by more than 1s (median of 3 runs). |

---

## F2: A hand-off carries a real task and Confirm buttons

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-F2-1 | Given a follow-up IS delivered to owner B for ask Q, then exactly one OPEN board task for Q exists, assigned to B, before B's reply is persisted. It is a new row, or the existing open task with the same normalized title found by the shared dedup (no second row). | happy-path | journey `public.tasks` via Supabase MCP: `count(*) WHERE lower(title)=lower(<title>) AND status<>'DONE'` = 1, and `assigned_agent='<B>'` on the mirror `tasks.journey_tasks`. |
| AC-F2-2 | B's follow-up reply carries `confirmAsk` with `taskId` = that task's id and a non-empty `proposedDod`. In other words B called `propose_task_intent` successfully in that turn. | happy-path | `getTurnUpdates(dm-<B>)` gives `replies[0].confirmAsk.taskId === <id>`. The UI shows the Confirm / Revise / Backlog / Archive row (Playwright: `button:has-text("Confirm")` visible under that message). |
| AC-F2-3 | After B's reply, the task's engagement row has `proposed_dod` equal to the reply's `proposedDod`, `confirm_status='asked'`, and `confirm_last_sent_at` within 60s of the reply's persist time. | happy-path | `tasks.task_engagement_state` via `azure-pg-query.yml`. |
| AC-F2-4 | Given B's model omits `propose_task_intent` in the follow-up turn, then the hand-off is NOT silently button-less. Either the runtime obtains the proposal (re-prompt / retry inside the turn) and the buttons render, or a visible fallback is recorded on the reply ("confirm buttons unavailable"). A follow-up reply with neither is a failure. | error | Unit test with a stubbed model that skips the tool: the reply has `confirmAsk` OR `fallbackNotes` containing the marker. E2E: 100% of follow-up replies in the F8 run have `confirmAsk`. |
| AC-F2-5 | The follow-up directive no longer says "do not perform the work yet" without a task. It still says B was tapped / passed by A and is replying in B's OWN channel, uses no `@handle`, and asks the owner to confirm the proposed DoD via the buttons. | regression | Unit test on the directive string: contains "passed" or "tapped", contains "your own" / "YOUR OWN", contains no `@`. |
| AC-F2-6 | Each button works on a hand-off task exactly as on an autowork ask. Confirm returns `ok`, then `confirm_status='confirmed'` and `confirmed_dod` = the server's `proposed_dod`. Backlog sets status BACKLOG. Archive sets status BACKLOG with tag `parking-lot`. | happy-path | Button server fns called through the harness, then SQL on `task_engagement_state` and the mirror. |
| AC-F2-7 | Idempotency: re-running the same follow-up id (`followup-<huddle>-<owner>-<slug>`) creates no second task, no second propose, and no second push. | edge | Second `enqueueTurn` returns `fresh=false`. Task count stays 1. Exactly 1 `send_push` for that turn id in logs. |
| AC-F2-8 | With `agents[*].journey.enabled !== true` (harness), the follow-up creates NO board row, and B's reply does not claim one was created. | edge | 0 new `public.tasks` rows. The reply text matches neither "added … board" nor "created … task" (F6 presenter). |
| AC-F2-9 | Button-render rate: over the F8 run, the share of user-initiated hand-off replies carrying `confirmAsk` is 100% (baseline measured 0 of 46 in 30 days). | regression/metric | SQL on `chat.pending_turns` for `id LIKE 'followup-%'` in the run window, checking `replies->0->'confirmAsk'` is not null. |
| AC-F2-10 | Task creation for a hand-off goes through the SAME create path and dedup as `create_huddle_task` / `screenRawJourneyCreate` (the `Test-` prefix and `journey:{enabled:false}` rules still apply). No new journey write path exists. | extend-not-duplicate | Code review: the hand-off create calls the shared core in create-task-core.ts. `grep -n "quick_create_task" src/features/huddle/lib/huddle.functions.ts` shows no new raw call outside the existing dispatch, produce path and dedup. |

---

## F3: Confirming from a live conversation starts the work now

Definition used below. A **LIVE confirmation** is exactly one of:
(a) the owner taps Confirm (`confirmTaskFromButtonFn`) or confirms by voice (`confirmTaskFromProposal`);
(b) a typed confirmation in a non-internal turn that F4 binds to a task;
(c) an explicit "now" ask (F1-2/F1-3) that creates or claims a task.
A model calling `confirm_task_intent` inside an internal turn (autowork, groom, follow-up, worker) is
**never** a live confirmation.

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-F3-1 | Given a task with a recorded `proposed_dod`, when the owner LIVE-confirms it, then within 120s, without any further owner action and regardless of the 9/13/17 cadence, the assignee's approach is proposed AND graded: `approach_status` leaves `pending` (becomes `approved`, or `escalated` after the cap). | happy-path | Poll `tasks.task_engagement_state.approach_status` every 10s for 120s after `confirmed_at`. A `pending_turns` row for `dm-<assignee>` with `created_at > confirmed_at` exists. |
| AC-F3-2 | Given approach `approved` for a LIVE-confirmed task, then within 120s of approval the task's status is `DOING` in journey `public.tasks` and in the mirror, and a work turn for that task is enqueued. | happy-path | Supabase `status::text='DOING'`, mirror row `status='DOING'`, `pending_turns` row for the work turn. |
| AC-F3-3 | OPTION A cap bypass: given the assignee already has 1 task in DOING, when a task is LIVE-confirmed and approved, then it ALSO moves to DOING (the agent now has 2 in DOING). | happy-path | SQL: `count(*) WHERE assigned_agent=<a> AND status='DOING'` = 2 after the run. |
| AC-F3-4 | Background caps unchanged: given NO live confirmation, a cadence / `promoteOnly` / `armOnly` / `force` autowork pass never leaves an agent with more than 3 UP_NEXT, never promotes into DOING while that agent has at least 1 DOING (live-started ones included), and never starts intake while IN_REVIEW is at least 2. | regression | `scripts/autowork-lane-starvation.test.ts` and the existing autowork tests still pass. New unit test: an agent with 1 live-started DOING plus 3 ready UP_NEXT, run one cadence pass, gives 0 new DOING promotions. |
| AC-F3-5 | The bypass is keyed on a durable, server-written marker set ONLY by the three live paths above. A task without the marker gets the caps (fail closed). A model's `confirm_task_intent` call never sets it. | error | Unit test: `confirm_task_intent` from an internal-turn tool call, then a pass, gives no bypass. Mutation: make the promoter treat every confirmed task as live, and the AC-F3-4 test FAILS (mutate.sh FIRED). |
| AC-F3-6 | FAIL-CLOSED gate preserved on the live path: no task reaches DOING or IN_REVIEW unless `confirm_status='confirmed'` AND (`approach_status='approved'` OR structured workflow is explicitly not required). A config-read throw counts as REQUIRED. | regression | Unit tests: (i) live marker but `approach_status='pending'` gives no DOING; (ii) `isStructuredWorkflowRequired` throws, then required; (iii) `confirm_status='asked'` plus live marker gives no DOING. Mutation on each predicate FIRES. |
| AC-F3-7 | The live start moves the SPECIFIC confirmed task, whatever its rank and however full that agent's UP_NEXT is (CF-7). It does not depend on that task being inside the BACKLOG top-up window. | edge | Unit test: an agent with 3 UP_NEXT plus a confirmed task ranked 10th in BACKLOG, LIVE-confirmed and approved, gives that task DOING. |
| AC-F3-8 | The live start writes ONLY that task's status. If the implementation reuses `runScheduledAutoWork`, every OTHER promotion it makes in that call obeys the background caps exactly (no collateral promotions beyond a normal pass, no extra confirm asks fired). | edge | Unit test: diff of statuses before and after a live start; only the target task plus at most what a normal pass would do. 0 confirm-ask sends from the live start itself. |
| AC-F3-9 | ONE kick point: the button, voice and typed confirm all reach the start-now step through `confirmTaskFromProposal` (or one function it calls). There is no second confirm writer and no second promoter. | extend-not-duplicate | Code review: `grep -n "status: \"DOING\""` shows no new DOING writer outside autowork.server.ts / its helper. |
| AC-F3-10 | REMIND-mode confirm unchanged: confirming a `reminder`-tagged task with `proposed_reminder_at` schedules the reminder (`taskremind-<id>-<sec>`), sets BACKLOG, and starts NO work turn. | regression | `chat` reminders row exists. Status is BACKLOG. 0 work turns enqueued. |
| AC-F3-11 | Idempotency: a double-tap or a retry of Confirm (`alreadyDone`) enqueues no second approach turn and no second work turn. | edge | Two calls; `pending_turns` approach / work rows for that task = 1 each. |
| AC-F3-12 | The approach step runs with the CONFIRMED DoD in the grader prompt (`state.confirmed_dod` non-empty at grading time, approach-gate.server.ts:164-176). It never grades with "No Definition of Done was confirmed". | error | Unit test captures the grader prompt; it contains the confirmed DoD text. |
| AC-F3-13 | Simple research tasks are not escalated by the approach gate: for three canonical `Test-` research tasks ("Test-Research dog chew treats for a 40lb dog", "Test-Find three boutique consulting firms in Atlanta", "Test-Compare two budgeting apps"), the approach is approved in at most `caps.approach` attempts in 3 of 3 runs. | performance/quality | `approach_status='approved'`, `approach_revision_count < caps.approach`, per task. |
| AC-F3-14 | If the approach escalates, the owner sees the "Approve anyway" row on that agent's reply in the SAME thread, and tapping it (`overrideApproachFromButtonFn`) then starts the work under F3-2 (still a live path). | alternate | Reply has `overrideAsk.taskId`. After the tap, `approach_status='approved'`, and DOING within 120s. |
| AC-F3-15 | The Confirm button returns to the UI in under 3s. The approach and start are asynchronous (fire-and-forget plus the durable runner), so the button never waits on model calls. | performance | Harness times `confirmTaskFromButtonFn`: p95 under 3s over 5 calls. |
| AC-F3-16 | Honesty tie-in (see F6): an agent reply that says it is "proceeding", "starting now" or "working on it" for task T is presented only if, at present time, T is DOING or a work / delegate toolUse for T succeeded in that turn. Otherwise the claim is withheld or corrected. | error | F6 presenter unit test with the observed text "I'm proceeding with the research". |

---

## F4: A typed confirmation binds to the ask the owner is replying to

Binding rule under test: the deterministic capture (block A, huddle.functions.ts:714-768) may confirm
task T only when T's confirm ask is carried by the **most recent agent message in this huddle**.
Otherwise it confirms nothing deterministically.

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-F4-1 | Observed-failure replay: agent E has an older outstanding ask on task X (`confirm_last_sent_at = t0`), then a hand-off reply at t1 > t0 carrying `confirmAsk` for task Y. The owner types "Confirmed". Then Y gets `confirm_status='confirmed'`, and X stays `confirm_status='asked'` with `confirmed_at IS NULL`. | happy-path | `task_engagement_state` for X and Y (`Test-` tasks). |
| AC-F4-2 | Given the most recent agent message in `dm-<E>` carries NO confirm ask (ordinary chat, a status update, an answer), when the owner types "ok great" or "Confirmed", then the deterministic capture confirms NOTHING (no `confirmed_at` changes during that turn). | error | SQL: `count(*) WHERE confirmed_at >= <turn start>` = 0 for that user. |
| AC-F4-3 | Every live `propose_task_intent` stamps the ask as sent (`confirm_status='asked'`, `confirm_last_sent_at=now()`), so a live ask outranks an older autowork ask in `getPendingConfirmForAgent` (fixes CF-3). | happy-path | Unit test on the propose handler, then SQL row. |
| AC-F4-4 | Stamping a live ask does not trigger an extra autowork send: no `autowork-confirm` / `autowork-reask` turn fires for Y inside the re-ask floor (`CONFIRM_REASK_MIN_HOURS_DEFAULT`, 24h) after the live ask. | regression | `confirm-reask-rotation.test.ts` and `confirm-spacing.test.ts` pass. New case: live-stamped row, then `planConfirmArming` within 24h arms nothing. |
| AC-F4-5 | Confirmation verdicts come from ONE matcher, `isPlainConfirmation` (extended in place), and match the spelling table rows S-C1..S-C16. | spelling | Table-driven unit test importing the real function (exported for test). |
| AC-F4-6 | A typed confirm in `dm-A` never confirms a task assigned to agent B (the existing `assigned_agent` filter is preserved). | regression | Unit / SQL test: pending ask for B, typed "yes" in `dm-A`, B's row unchanged. |
| AC-F4-7 | Negation, a question, or text over 40 chars never deterministically confirms (unchanged): "no", "not yet", "wait", "don't", "yes?", "can you change the DoD first". | regression | Table rows S-C9..S-C12. |
| AC-F4-8 | The binding is computed server-side from durable data (`chat.pending_turns` replies' `confirmAsk` for that huddle, and/or `task_engagement_state.confirm_last_sent_at`), never from client-supplied ids or text. | error | Code review: no new Input field drives which task is confirmed. A forged id in the payload changes nothing. |
| AC-F4-9 | A typed "Do it now" while the latest agent message carries an ask confirms that ask (affirmative), AND F3 treats it as a live confirmation (the work starts). | alternate | Y confirmed; DOING under F3-1/F3-2. |
| AC-F4-10 | After a typed confirm binds to Y, the agent's reply names Y's title, not another task's title (the directive given to the model carries Y). | happy-path | Harness: the reply text contains a distinctive token from Y's `Test-` title and none from X's. |
| AC-F4-11 | A typed confirm is a LIVE confirmation and must reach the same start-now path as the button (F3-9). | regression | Same observations as AC-F3-1/F3-2 for a typed confirm. |

---

## F5: Capability-aware task-mode judgement (PENDING: the owner has not yet picked the fallback default)

> **STATUS: PENDING.** Scope replaced 2026-10-31 by the coordinator. This section supersedes the earlier
> "grooming rule only" framing of F5. Every AC below except F5-8a / F5-8b applies whichever default the
> owner picks. F5-8a (DEFAULT-ASSIST) and F5-8b (DEFAULT-REMIND) are alternatives: exactly one of them
> ships.

Evidence (CF-10, CF-11 plus the coordinator's live read). The mode decision fails in both directions.
False REMIND: grooming's "when in doubt, ADD reminder" parked 11 of 18 producible tasks.
False PRODUCE: a first-word verb match with a `produce` default invented deliverables ("transcript-acquisition
brief", "subscription brief", "launch plan", "camera brief", an "evidence-based" case study with no
evidence source, a "submission-ready checklist").
Nothing in either path reads the assigned agent's tools.

Sources added for this section: `src/features/huddle/lib/tasks/groom.ts` (222-244 prompt, 394-399
CONTROL_TAGS), the per-turn tool assembly `mergedTools` (huddle.functions.ts:3713-3760),
`src/features/huddle/lib/artifacts/artifact-tool.ts` (formats `md|docx|pptx|html|mermaid|svg`), and
autowork `turnPayload` (autowork.server.ts:87-112, `webSearch: true`).

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-F5-1 | ONE judgement. Mode (produce / assist / remind) is decided by the EXISTING `classifyTaskMode` (workability.ts), extended in place, reached through its single caller path (`confirmIntentDirective`, autowork.server.ts:148). No second mode classifier exists. | extend-not-duplicate | `grep -rn "TaskMode\|classifyTaskMode" src` shows the definition in workability.ts and callers only (autowork, groom). No regex verb lists or mode prompt elsewhere. |
| AC-F5-2 | Inputs are the task (title, category, tags, description if present) AND the assigned agent's REAL tool list. The tool list comes from the same source the agent's turn uses: the `mergedTools` assembly plus the config gates (web search, Graph email / calendar `graphEmailConfigured()`, Nexus read / write configured). It is never a hand-maintained per-agent list. | happy-path | Unit test: with Nexus write unconfigured, the tool list passed to the judge contains no Nexus write tool. With Graph unconfigured, it contains no email-send / draft tool. Code review: one exported function produces the list and the turn and the judge both call it. |
| AC-F5-3 | The judgement records a one-line reason (at most 160 chars) naming what the agent can and cannot do, persisted durably per task and queryable. | happy-path | SQL returns a non-empty reason for each judged `Test-` task. The reason for "Test-Order running shoes" mentions payment or purchase being the user's act. |
| AC-F5-4 | For each spelling-table row S-M1..S-M14, the judged mode is inside the row's EXPECTED set and never the row's FORBIDDEN verdict. | spelling | Table-driven test over `Test-` copies with a recorded judge, plus one live run with the real judge (3 of 3 runs). |
| AC-F5-5 | When produce is chosen, the proposed DoD names ONLY outputs the agent's tools can create. Every deliverable in the DoD maps to a tool in that agent's list (`create_artifact` with a listed format, `create_email_draft`, `schedule_reminder`, `build_checklist`, Nexus write…). A DoD output with no mapping is rejected before `propose_task_intent` records it. | error | Unit test: a candidate DoD "a transcript-acquisition brief delivered to the registrar" is rejected (the agent cannot deliver to a registrar). "A pptx deck saved as an artifact" is accepted for an agent with `create_artifact`. |
| AC-F5-6 | A produce DoD may not cite evidence or data that no tool supplies. "Evidence-based" / "using client data" / "from your records" is allowed only if a tool in the list can read that source (web search for public sources, memory / RAG, Nexus read, calendar / email read). Otherwise the DoD states the source it WILL use (for example "public web sources") or asks the owner for the input. | error | Unit test with the Trinnex case-study title: the accepted DoD either names public web sources only, or the mode is assist with "you supply the engagement facts". It never claims internal evidence. |
| AC-F5-7 | Grooming's `reminder` tag is DERIVED from the same judgement: tag present if and only if the judged mode is `remind`. groom.ts no longer contains its own reminder rule ("When in doubt, ADD the tag" is gone, and the model is no longer asked to decide the tag). | happy-path | `grep -n "When in doubt" src/features/huddle/lib/tasks/groom.ts` returns 0. Unit test: groom writeback tags for a task judged produce contain no `reminder`. |
| AC-F5-8a | **DEFAULT-ASSIST (alternative A).** When the judge throws, times out (5s bound) or is unavailable (no key), the mode is `assist`. The DoD follows the template "I'll do the part I can, <X>; you do <Y>", where X is one tool-backed output. The reason records `judge unavailable: <error class>`. A visible fallback event is recorded. | error | Unit test with the judge stubbed to throw: mode `assist`, the DoD matches `/I'll do the part I can, .+; you do .+/`, reason prefix `judge unavailable`, `recordFallback` called once. |
| AC-F5-8b | **DEFAULT-REMIND (alternative B).** When the judge throws, times out or is unavailable, the mode is `remind`. The DoD is a reminder at a specific proposed day and time (`proposed_reminder_at` set and in the future). The reason records `judge unavailable: <error class>`. A visible fallback event is recorded. | error | Unit test with the judge stubbed to throw: mode `remind`, `proposed_reminder_at` is a future ISO time, reason prefix `judge unavailable`. |
| AC-F5-9 | Under EITHER default, a judge failure NEVER yields `produce` (the expensive direction), and never blocks the confirm ask from being sent. | error | Unit test: judge throws, mode is not `produce`, and the `propose_task_intent` directive is still produced. |
| AC-F5-10 | A user-set tag is respected. If the OWNER added `reminder` (UI or "remind me" to an agent), the judge result does not remove it. If the owner REMOVED a groom-derived `reminder`, grooming does not re-add it unless the judgement changes. Requires tag provenance (see Gap G-5). | regression | Unit test with provenance fixtures. The owner-removal case passes over 2 consecutive groom passes. |
| AC-F5-11 | Recovery of the 11 parked producible tasks, proved on `Test-` CLONES only (never the owner's real tasks): clones of "Research …", "Create …", "Build …", "Find sample boutique firms" carrying `reminder`, after one groom pass, no longer carry `reminder` and judge `produce`. | regression | SQL on the `Test-` clone ids. Cleanup removes them after the run. |
| AC-F5-12 | REMIND mode behaviour unchanged once chosen: `modeProposalHint("remind")` text, the reminder scheduling on confirm (F3-10), and exclusion from automation inside the reminder window (`taskIdsInReminderWindow`). | regression | Existing reminder tests (`reminder-intent.test.mjs`, reminder-checks) pass. |
| AC-F5-13 | Performance: the judge is bounded (5s per task, concurrent within groom chunks). A groom pass over 25 tasks completes within the existing groom `withTimeout`. A judgement is cached per (task id, assigned agent, title hash) so a re-ask does not re-judge. | performance | Timed groom run on `Test-` tasks. A second `confirmIntentDirective` for the same task makes 0 judge calls (spy). |

---

## F6: An agent never claims a board action it did not perform

Extend the existing turn-level honesty presenter (`presentedReplies()` → `presentNexusWriteTurn`,
huddle.functions.ts:2214, nexus-write-shared.ts:261-288). It already runs at every exit point (stream,
chunk save, final result, the prior shown to later agents, memory). Board writes get the same treatment.
No second, per-agent filter.

"Performed" means a toolUse in THIS turn (or an earlier chunk of it) with `ok=true` that actually wrote.
A result of `deferred: true` (CF-8), a dedup skip (`describeRawCreateSkip`), an in-flight call, or
`ok=false` is NOT performed.

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-F6-1 | Given a reply claims a completed board action in past or present-perfect tense ("I marked X done", "I've moved it to review", "I added X to your board", "I archived X", "set X to Up Next") and the turn has no performed write for that task, when the reply is presented, then the claim does not reach the owner. It is replaced or annotated by a code-built line ("Nothing was changed on the board for X"). | happy-path | Presenter unit test. E2E: the persisted `pending_turns.replies[].text` does not contain the claim. |
| AC-F6-2 | Observed-failure replay: task X has been DONE since an earlier date, and the agent says "I marked 'X' done" with no `update_task` call. The presented text does not say "I marked", and states that X was already done. | happy-path | Unit test with a `Test-` DONE task. Presented text contains "already" and not "I marked". |
| AC-F6-3 | Given the claim matches a performed write (`update_task` ok, args `task_id`=X, `status`=DONE, not deferred), then the reply is untouched. | regression | Unit test: presented text equals the raw text. |
| AC-F6-4 | A deferred status change (`maybeDeferStatusChange`, toolUse ok=true, detail "deferred — task assigned to …") is NOT performed. "I moved it to review" is withheld and the reply says it was passed to the assignee. | error | Unit test using the exact deferred detail string from huddle.functions.ts:4814. |
| AC-F6-5 | A dedup-skipped create is NOT a new card. "I've added X to your board" becomes "X is already on your board". | error | Unit test using a `describeRawCreateSkip` detail. |
| AC-F6-6 | A failed write (`ok=false`) or a write still in flight when the reply is persisted counts as not performed (mirrors Nexus D11 "unknown"). | error | Unit tests for both cases. |
| AC-F6-7 | Offers, future tense and conditionals are NOT claims and stay untouched: "I'll mark it done", "Want me to move it to review?", "I can add that to your board". | over-match negative | Spelling rows S-B5..S-B7. |
| AC-F6-8 | Non-board claims are out of scope and untouched: "marked as read" (email), "I marked the date in my notes", "I've noted that". | over-match negative | Spelling rows S-B8..S-B10. |
| AC-F6-9 | "Started work" claims ("I'm proceeding with the research", "I've started on X", "working on it now") are presented only if X is DOING at present time, or a delegate / work toolUse for X succeeded this turn (ties to F3-16). | error | Unit test with a DB stub reporting X is BACKLOG: the claim is withheld. |
| AC-F6-10 | The presenter is pure (same input gives the same output) and applied at the SAME call sites as today's `presentedReplies()` (2214, 5041, 6929, 7030, 7125, 7182, 7333, 7343). No exit point emits the raw reply. | regression | Code review grep. Unit test: applying it twice gives the same result. |
| AC-F6-11 | Nexus write honesty is unchanged (its existing tests pass byte-for-byte). | regression | Existing nexus-write tests. |
| AC-F6-12 | Claim detection uses the task title / id actually named. A reply that claims an action on task A, with a performed write only on task B, is still corrected for A. | edge | Unit test with two tasks. |

---

## F7: One request never creates the same task twice

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-F7-1 | Observed-failure replay: two identical owner messages two minutes apart in the same DM, each leading to a create of "Test-Obtain official transcript", produce exactly ONE open task with that normalized title. | happy-path | Supabase: `count(*) WHERE lower(title)='test-obtain official transcript' AND status::text<>'DONE'` = 1, and the same count on the mirror. |
| AC-F7-2 | Concurrent turns for one request (user turn + follow-up turn + worker / integration turn, each attempting the create within 5s) produce exactly ONE task. Dedup is shared ACROSS turns, not only a per-turn snapshot (CF-9). | edge | Test that fires the creates in parallel (`Promise.all`) through the real create path. Count = 1. |
| AC-F7-3 | Cross-agent: Elle and Iris each attempting the same title for the same user produce 1 task (per-user dedup, AC-61, which currently fails in production). | regression | Count = 1. `assigned_agent` is the first creator, or the ownership judge's pick. |
| AC-F7-4 | Mirror lag: a create at t and a duplicate create at t+2s (before the pg_net sync lands, ~1-3s) produce 1 task. The second check consults something that already reflects the first write (journey canonical, or a shared write-ahead claim), not only the mirror. | edge | Test with the sync delayed or stubbed. Count = 1. |
| AC-F7-5 | Distinct titles are NOT merged: "Test-buy studio camera bag" and "Test-buy studio camera" give 2 tasks (AC-62). | regression | Count = 2. |
| AC-F7-6 | A DONE task never blocks a re-create (AC-63). | regression | DONE row plus a new create gives 2 rows, 1 open. |
| AC-F7-7 | When the dedup read fails, the create proceeds AND a visible "dedup unavailable" fallback is recorded (AC-64). | regression | Unit test: the read throws, then `recordFallback` and the create both happen. |
| AC-F7-8 | When a create is skipped as a duplicate, the agent's presented reply says the task is already on the board (F6-5), and the reply's chip / `suggestedTasks` does not show a second card. | error | Persisted reply text plus a `suggestedTasks` length check. |
| AC-F7-9 | The cross-turn guarantee lives in the SAME dedup core (create-task-core.ts `screenRawJourneyCreate` / `loadOpenTaskTitles` and the `createdTaskTitles` ledger contract). No third dedup layer with a different key or normalizer (`normalizeTaskTitle` stays the one normalizer). | extend-not-duplicate | Code review grep for `normalizeTaskTitle` definitions = 1. |
| AC-F7-10 | Performance: the cross-turn check adds at most 300ms p95 to a create. | performance | Timed harness creates. |

---

## Spelling table (Tier 1 free-text matchers: F1 urgency, F4 confirmation, F5 mode, F6 board claims)

**Documentation basis.** None of these matchers parses a formal grammar with tool documentation of its own
(no `git help`, no RFC). The authority for each verdict is (a) the existing matcher's own documented
contract in its code comments, cited per row, and (b) the owner's stated intent in the brief. The
"Current" column was **MEASURED** on 2026-10-31 by importing the real modules with bun at 9983343
(`capabilities.ts` `classifyTurnIntent` / `classifyAsk`, `workability.ts` `classifyTaskMode`;
`isPlainConfirmation` is unexported, so it was copied verbatim from huddle.functions.ts:650-659).
Probe script: `/tmp/claude-0/-home-user/afbd1aea-b7b8-5cd6-a1d2-2d6fc4738016/scratchpad/probe.ts`.
A row whose Current ≠ Expected is a **live defect today**.

Context codes for confirmations: **L** = the most recent agent message in this huddle carries a confirm
ask. **N** = it does not (F4 binding rule).

### Confirmations: `isPlainConfirmation` (huddle.functions.ts:650-659), binding per F4

| # | Input | Ctx | Documented by | Expected | Current (measured) | Wrong answer would be |
|---|---|---|---|---|---|---|
| S-C1 | `confirm` | L | 656 list `confirm(ed)?` | CONFIRM | true | FALSE REFUSAL |
| S-C2 | `Confirmed` | L | 656 | CONFIRM the L ask | true, but bound to an OLDER ask (CF-3) | FALSE PASS (wrong task) |
| S-C2n | `Confirmed` | N | F4 binding rule | NO deterministic confirm | true, binds to the oldest outstanding ask | FALSE PASS |
| S-C3 | `yes` | L | 656 | CONFIRM | true | FALSE REFUSAL |
| S-C4 | `yes do it` | L | 656 `do it` | CONFIRM | true | FALSE REFUSAL |
| S-C5 | `go ahead` | L | 656 | CONFIRM | true | FALSE REFUSAL |
| S-C6 | `ok` | L | 656 `ok` | CONFIRM | true | FALSE REFUSAL |
| S-C7 | `ok great` (latest agent message was a status update) | N | F4 binding rule; over-match negative | NO confirm | true and binds | FALSE PASS |
| S-C8 | `👍` | L | 656 lists `👍`, but `\b` cannot match next to a non-word char | CONFIRM | **false** | FALSE REFUSAL (live defect) |
| S-C9 | `no` | L | 654 negation list | NO | false | FALSE PASS |
| S-C10 | `not yet` | L | 654 | NO | false | FALSE PASS |
| S-C11 | `yes?` | L | 653 question guard | NO | false | FALSE PASS |
| S-C12 | `can you change the DoD first` | L | 654 `change` | NO | false | FALSE PASS |
| S-C13 | `great job on the last one` | L | over-match negative (praise about other work) | NO | **true** | FALSE PASS (live defect) |
| S-C14 | `Do it now` | L | 656 `do it`; capabilities.ts:148 | CONFIRM + urgency NOW | true (urgency unconsumed, CF-4) | FALSE REFUSAL |
| S-C14n | `Do it now` | N | F1 | not a confirm; F1 urgency path | true (binds an older ask if any) | FALSE PASS |
| S-C15 | `that's right` | L | 656 `right` | CONFIRM | true | FALSE REFUSAL |
| S-C16 | `yes, but make it a 2-page brief` | L | 647-649 contract: "a real refinement returns false and is left to the model" | NO deterministic confirm (the model folds the refinement into the DoD) | **true** | FALSE PASS (live defect: the refinement is dropped) |
| S-C17 | `sounds good, thanks` | L | 656 | CONFIRM | true | FALSE REFUSAL |

### Urgency: `classifyAsk().urgency` / `URGENCY_RE` (capabilities.ts:147-156)

| # | Input | Documented by | Expected | Current (measured) | Wrong answer would be |
|---|---|---|---|---|---|
| S-U1 | `Do it now` | 148 `do it now` | NOW | now | FALSE REFUSAL |
| S-U2 | `now please` | 148 | NOW | now | FALSE REFUSAL |
| S-U3 | `asap` | 148 | NOW | now | FALSE REFUSAL |
| S-U4 | `right away` | 148 | NOW | now | FALSE REFUSAL |
| S-U5 | `immediately` | 148 | NOW | now | FALSE REFUSAL |
| S-U6 | `i need an ai agent on the team to go and research chew treats. Do it now` (the observed message) | 148-149 | NOW | now | FALSE REFUSAL |
| S-U7 | `Now, research chew treats` | 150 leading `now,` | NOW | now | FALSE REFUSAL |
| S-U8 | `can you do it now?` | QUERY_RE comment (capabilities.ts:31-33): polite delegation is perform | NOW | now | FALSE REFUSAL |
| S-U9 | `do it today` | owner intent: "explicit now ask" only (see Gap G-2) | DEFAULT | default | FALSE PASS |
| S-U10 | `not now` | over-match negative (negation) | DEFAULT | **now** | FALSE PASS (live defect) |
| S-U11 | `don't do it now` | over-match negative | DEFAULT | **now** | FALSE PASS (live defect) |
| S-U12 | `now that you mention it, what's on my calendar` | over-match negative (discourse "now that") | DEFAULT | **now** | FALSE PASS (live defect) |
| S-U13 | `right now is a bad time` | over-match negative | DEFAULT | **now** | FALSE PASS (live defect) |
| S-U14 | `no rush, whenever` | negative | DEFAULT | default | FALSE PASS |

### Task mode: the extended `classifyTaskMode` judge (workability.ts), F5 PENDING

"Current" is today's verb-list result (no tags). Expected is a SET; the row fails only on the FORBIDDEN
verdict or on a verdict outside the set. Tool references: `tavily_web_search`, `create_artifact` formats
`md|docx|pptx|html|mermaid|svg` (artifact-tool.ts:36), `schedule_reminder`, `create_email_draft`.

| # | Task title | Documented by | Expected set | Forbidden | Current (measured) | Wrong answer would be |
|---|---|---|---|---|---|---|
| S-M1 | `Obtain official transcript` | no verb list matches (workability.ts), so the `produce` default applies | assist, remind | produce | produce | FALSE PASS (invented "transcript-acquisition brief") |
| S-M2 | `Subscribe to Aha!` | same | assist (find the plan and price; user pays) | produce | produce | FALSE PASS |
| S-M3 | `Start AI certification course` | same | assist, remind | produce | produce | FALSE PASS ("launch plan") |
| S-M4 | `Fix the brakes` | same; physical act | assist, remind | produce | produce | FALSE PASS |
| S-M5 | `Apply for the low-interest card` | same; the user submits | assist | produce | produce | FALSE PASS ("submission-ready checklist" as done-when) |
| S-M6 | `Prepare my office camera quality` (physical) | PRODUCE_VERBS includes `prepare` | assist | produce | produce | FALSE PASS ("camera brief") |
| S-M7 | `Prepare board deck for Q4` (document) | `create_artifact` format `pptx` | produce | remind | produce | FALSE REFUSAL if remind |
| S-M8 | `Research chew treats` | `tavily_web_search` + `create_artifact` | produce | remind | produce (remind if tagged) | FALSE REFUSAL (the 11 parked tasks) |
| S-M9 | `Find sample boutique firms` | same | produce | remind | produce (remind if tagged, observed) | FALSE REFUSAL |
| S-M10 | `Order Nike Pegasus Premium` | no verb list matches | assist, remind | produce | produce | FALSE PASS |
| S-M11 | `Sign up for the 10k` | ASSIST_VERBS `sign` | assist, remind | produce | assist | FALSE PASS if produce |
| S-M12 | `Integrate Stripe with the app` | no code or repo tool in the agent's list | assist (agent writes the steps; the owner or a dev integrates) | produce with a done-when of "integrated" | produce | FALSE PASS |
| S-M13 | `Create Trinnex DevSecMLOps and AI governance case study` | PRODUCE_VERBS `create`; no internal-evidence tool | produce (public-source DoD only) or assist (owner supplies facts) | produce citing internal evidence (F5-6) | produce | FALSE PASS |
| S-M14 | `Go to church` | ASSIST_VERBS `go` | assist, remind | produce | assist | FALSE PASS if produce (regression) |
| S-M15 | `Research chew treats` tagged `reminder` by the OWNER (provenance: user) | F5-10 | remind | produce | remind | FALSE PASS (overrides the owner) |

### Board-action claims: the F6 presenter (extends `presentNexusWriteTurn`, nexus-write-shared.ts:261)

| # | Reply text | Turn's toolUses | Documented by | Expected | Wrong answer would be |
|---|---|---|---|---|---|
| S-B1 | `I marked 'Order Nike Pegasus Premium' done` | none (task already DONE) | observation 5 | WITHHOLD; say it was already done | FALSE PASS |
| S-B2 | `I've moved it to review` | none | F6-1 | WITHHOLD | FALSE PASS |
| S-B3 | `I marked it done` | `update_task` ok, `status:DONE`, same task_id | F6-3 | PASS unchanged | FALSE REFUSAL |
| S-B4 | `I've moved it to review` | `update_task` ok=true, detail `deferred — task assigned to …` (huddle.functions.ts:4814) | CF-8 | WITHHOLD; say passed to the assignee | FALSE PASS |
| S-B5 | `I'll mark it done` | none | future tense, not a claim | PASS | FALSE REFUSAL |
| S-B6 | `Want me to move it to review?` | none | offer | PASS | FALSE REFUSAL |
| S-B7 | `I can add that to your board` | none | capability statement | PASS | FALSE REFUSAL |
| S-B8 | `I marked that email as read` | none | out of scope (not a board action) | PASS (scope); see Gap G-7 | FALSE REFUSAL |
| S-B9 | `I marked the date in my notes` | none | not a board object | PASS | FALSE REFUSAL |
| S-B10 | `I've noted that` | none | not a board action | PASS | FALSE REFUSAL |
| S-B11 | `Done — I've added 'X' to your board` | create ok, detail `skipped duplicate — …` (create-task-core.ts:238) | CF-8 | REWRITE to "already on your board" | FALSE PASS |
| S-B12 | `I'm proceeding with the research` | none; task status BACKLOG | observation 4, F6-9 | WITHHOLD | FALSE PASS |
| S-B13 | `You asked me to "mark it done", so here's what's left first` | none | quoted user text, not a claim | PASS | FALSE REFUSAL |
| S-B14 | `Marked as done ✅` (no pronoun) | none | F6-1 (subjectless claim) | WITHHOLD | FALSE PASS |
| S-B15 | `I marked 'A' done` | `update_task` ok, DONE, for task B only | F6-12 | WITHHOLD for A | FALSE PASS |

---

## F8: End-to-end proof scenario (runnable via the existing durable harness)

**Vehicle:** `.claude/skills/test-agent-serverfn/scripts/durable-harness.mjs` pattern (`enqueueHuddleTurn`
then poll `getTurnUpdates`, i.e. the REAL durable chat path), plus the button server fns
(`confirmTaskFromButtonFn`, `overrideApproachFromButtonFn`) called the same way. Ground truth is read with
Supabase MCP (journey `public.tasks`, project `wwxgajrtmslzklnyplah`, cast `status::text`) and
`azure-pg-query.yml` (`tasks.task_engagement_state`, `tasks.journey_tasks`, `chat.pending_turns`). The SWA
is usually not reachable from the session, so run the script on a GH runner (`verify-uat.yml` /
`qa-confirm-reply.yml` style, `npm run build` first for fresh server-fn ids).

**Safety rules (mandatory, from this repo's CLAUDE.md):**
- Every message starts with `Test-<MARK>` (`MARK = e2e-hcf-<6 hex>`), and every task title the run can
  create starts with `Test-`. Use `journey:{enabled:false}` for every step that does not NEED a board
  write (E2E-1, E2E-5).
- Never touch the owner's real tasks. Every seeded row is a `Test-` row created by the script.
- **Seroval decoder:** `durable-harness.mjs`'s `CONST` map is the stale one (CLAUDE.md: real indices are
  `0=null 1=undefined 2=true 3=false`). Any assertion on a boolean (`ok`, `alreadyDone`) must use the
  corrected map, as `mirror-verify.mjs` does, or it reads `true` as `null`.
- **Eventual consistency:** journey to mirror is ~1-3s through pg_net. Every DB assertion polls (every
  5s, up to 60s) before it fails.
- **Auto-cleanup, without asking (standing instruction 2026-08-11):** at the end, and also on any
  failure (`finally`), delete: journey `public.tasks WHERE title ILIKE 'test%<MARK>%' OR (title ILIKE
  'test%' AND created_at >= <run start>)` (loose match, because agents may strip hyphens; review the
  row list before deleting anything that lacks `<MARK>`); `tasks.task_engagement_state` and
  `tasks.task_blockers` for those ids; `chat.pending_turns WHERE payload->>'text' ILIKE '%<MARK>%' OR
  (id LIKE 'followup-%' AND created_at >= <run start> AND huddle_id IN (<run huddles>))`; `public.rag_chunks WHERE content ILIKE '%<MARK>%'`; artifacts whose name contains
  `<MARK>` (`delete-artifacts.mjs`); reminders with `text ILIKE 'test%'` created in the window. Then
  re-query and REPORT `0 remaining` for each table.

| Step | Drives | Action | Pass condition (all must hold) |
|---|---|---|---|
| E2E-1 | F1 | `dm-iris-chase`, journey off, web search on: `Test-<MARK> i need an ai agent on the team to go and research Test-dog chew treats for a 40lb dog and give me a short brief. Do it now` | Iris's reply has `delegate_to_specialist` ok (or `tavily_web_search` + `create_artifact` ok). `worker-orch-…` rows exist. **0** `followup-dm-iris-chase-%` rows from this turn. The integration turn completes. 1 artifact with `<MARK>` or the dog-treat title exists. Iris's text has no deferral to a named teammate (F1-4). |
| E2E-2 | F1-5, F2 | `dm-tess-sutton`, journey ON: `Test-<MARK> build a monthly household budget spreadsheet` (finance lane, so not Tess's) | Exactly 1 `followup-dm-tess-sutton-finn-reid-…` row. Exactly 1 open journey task with a `Test-` title for this ask, assigned to `finn-reid`. Finn's reply has `confirmAsk.taskId` = that id with a non-empty `proposedDod`. The engagement row has `confirm_status='asked'` and a fresh `confirm_last_sent_at`. |
| E2E-3 | F4 | Seed `Test-<MARK> older ask` assigned to `finn-reid`, `confirm_status='asked'`, `confirm_last_sent_at = now()-1h`, `proposed_dod` set, BEFORE E2E-2. After E2E-2, type `Confirmed` in `dm-finn-reid`. | The E2E-2 task is `confirmed`. The older seeded task stays `asked` with `confirmed_at IS NULL`. Finn's reply names the budget task, not the seeded one. |
| E2E-4 | F3 incl. Option A | Before E2E-3, seed a `Test-<MARK> placeholder` task for finn in `DOING`. After E2E-3's typed confirm: | Within 120s `approach_status ≠ 'pending'`. If `approved`, within a further 120s the budget task is `DOING`, so finn has **2** DOING tasks (cap bypass). One work turn is enqueued. No other finn task changed status. If `escalated`, the reply has `overrideAsk`, and after `overrideApproachFromButtonFn` the DOING condition holds within 120s. |
| E2E-5 | F3-4 regression | Immediately after E2E-4, call `runScheduledAutoWork` for the test caller (or wait for the `run-autowork.yml` dispatch). | No new DOING promotion for finn (it already has at least 1). No agent ends with UP_NEXT > 3. |
| E2E-6 | F2-6 button path | In `dm-finn-reid`, journey ON: `Test-<MARK> draft a 3-line product one-pager for a dog-treat subscription` (product lane, so it hands off from Finn to Tess). Tap Confirm via `confirmTaskFromButtonFn` on Tess's `confirmAsk`. | Button returns `ok` in under 3s. Then F3-1/F3-2 timings hold for the Tess task. |
| E2E-7 | F7 | `dm-elle-rowan`, journey ON: `Test-<MARK> add Test-Obtain official transcript to my board`, sent twice 120s apart. Concurrently with the second send, the same text in `dm-iris-chase`. | Exactly **1** open journey task `Test-Obtain official transcript`, and 1 mirror row. Every reply after the first says it is already on the board (F6-5). |
| E2E-8 | F6 | Seed `Test-<MARK> Order running shoes` with status `DONE`, assigned to `ezra-miles`. In `dm-ezra-miles`: `Test-<MARK> is Test-Order running shoes done? mark it done if not` | The persisted reply does not contain "I marked" unless the turn's toolUses include a performed `update_task` for that id. If no write, the reply says it was already done. Plus a sweep: across ALL replies of the run, every board-claim match (S-B regex set) has a matching performed toolUse. |
| E2E-9 | F5 (PENDING) | Do NOT run a real groom pass (it re-tags the owner's real backlog). Call the judge directly from a script over `Test-` clones of S-M1..S-M15 with each row's assigned agent. | Every row inside its expected set. A forced judge failure yields DEFAULT-ASSIST or DEFAULT-REMIND per the owner's pick, never produce. |
| E2E-10 | cleanup | `finally` block. | `0 remaining` reported for each table listed above. |

---

## Goal → AC coverage

| User goal | ACs |
|---|---|
| G1 Whoever is asked does it immediately when they can (no duplicate work) | F1-1, F1-2, F1-4, F1-6, F1-11, E2E-1 |
| G2 A hand-off happens only when it should, and then carries a real task + buttons | F1-3, F1-5, F2-1..F2-10, E2E-2, E2E-6 |
| G3 Confirming starts the work now (Option A cap bypass, live only) | F3-1..F3-15, F4-9, F4-11, E2E-4, E2E-5, E2E-6 |
| G4 A typed confirmation hits the task being replied to | F4-1..F4-10, S-C rows, E2E-3 |
| G5 Agents never claim board actions they did not perform | F6-1..F6-12, F3-16, F7-8, S-B rows, E2E-8 |
| G6 One request, one task | F7-1..F7-10, F2-1, F2-7, E2E-7 |
| G7 Task mode reflects what the agent can really do (PENDING) | F5-1..F5-13, S-M rows, E2E-9 |
| Safety: the confirm gate stays fail-closed | F3-5, F3-6, F4-2, F4-8, F5-9 |
| Regression: group scope, internal turns, autowork caps, remind mode, Nexus honesty | F1-6..F1-10, F3-4, F3-10, F4-4, F4-6, F5-12, F6-11, F7-5..F7-7 |

No goal is without an AC. No AC lacks a goal. F1-12, F3-15, F5-13 and F7-10 are performance guards
attached to G1, G3, G7 and G6.

---

## Places the code CONTRADICTS (or cannot confirm) the brief's observations

1. **Observation 3's mechanism is worse than described.** The brief implies the shortcut picked the wrong
   one of several asks. In fact a live `propose_task_intent` can NEVER be the pending ask: `proposeTaskDod`
   never sets `confirm_status='asked'` / `confirm_last_sent_at` (CF-3). So any typed confirm in a live
   conversation binds to the newest AUTOWORK-sent ask, whatever the owner was looking at. And
   observation 2 (no task on hand-offs) meant there was no live ask at all, so the brakes task was the
   only candidate.
2. **Observation 4 has a second, structural cause.** Even at the 9/13/17 cadence, a confirmed task only
   reaches DOING if it sits inside the BACKLOG top-up window (CF-7). A low-ranked confirmed task, or one
   whose agent already has 3 UP_NEXT, never starts. `force: true` does not change that.
3. **"Do it now" is already classified and simply ignored.** `classifyAsk().urgency` has zero consumers
   (CF-4), and it also flags "not now" / "now that you mention it" as urgent (CF-5). The fix is to wire and
   correct the existing classifier, not to add one.
4. **The grooming prompt's "keep it unless now plainly agent-doable" cannot be honoured.** CONTROL_TAGS
   re-adds any existing `reminder` tag whatever the model returns (CF-10). Once wrong, it stays wrong.
5. **`isPlainConfirmation` defects beyond the brief:** "👍" is listed in the regex but can never match
   (`\b`). "great job on the last one" and "yes, but make it a 2-page brief" both count as confirmations,
   the second contradicting the function's own comment that refinements are left to the model.
6. **Observation 6 (duplicate "Obtain official transcript") is NOT explained by the code alone.** Within
   one turn the ledger dedups. Across turns, the mirror read is fresh at each turn start, so a message two
   minutes later should see the first task unless (a) the mirror sync failed or lagged, (b) the titles
   differed after `normalizeTaskTitle`, or (c) the creates came from CONCURRENT turns (user turn +
   follow-up / worker) with stale snapshots (CF-9). Settling it needs the three rows' exact titles,
   `created_at`, and the creating turn ids (Gap G-6). F7's ACs cover all three mechanisms.
7. **Observation 5:** the `update_task` deferral and the dedup skip both record `ok=true` (CF-8), so any
   honesty check keyed on `ok` alone would pass fabricated claims. F6 accounts for this.

---

## Gaps / open questions for the owner

- **G-1 (F5 default, PENDING).** DEFAULT-ASSIST vs DEFAULT-REMIND when the judge fails. Both AC sets are
  written (F5-8a / F5-8b).
- **G-2 (F1/F3 urgency scope).** Is "do it today" / "today please" a live-start trigger? The ACs assume
  NO (S-U9), so it is a reversible default.
- **G-3 (F3 Option A breadth).** Option A names the DOING cap only. Does a live confirm also bypass the
  REVIEW freeze (agent already has 2 IN_REVIEW)? The ACs assert the DOING bypass and are silent on
  REVIEW. Proposed default: bypass both for the one live task, since "starts immediately" was the stated
  intent.
- **G-4 (F4 stale buttons).** After a TYPED confirm, the original message's Confirm row stays clickable on
  reload (`resolveConfirmAsk` is client-only, on button tap). A tap then returns `alreadyDone`, which is
  harmless. Not in scope; noted only.
- **G-5 (F5-10 provenance).** Tags carry no author today, so "owner-added `reminder`" cannot be told from
  "groom-added". F5-10 needs a provenance record. Without it, F5-7 and F5-10 conflict.
- **G-6 (F7 evidence).** Pull the three "Obtain official transcript" rows (`title`, `created_at`,
  `assigned_agent`, journey `source` / creating turn id) to confirm which F7 mechanism fired.
- **G-7 (F6 scope).** "marked as read" about email is left alone (S-B8). If no mark-as-read tool exists,
  that claim is also unbacked, but it is outside "board actions". Flagged, not covered.
- **G-8 (F2-4 design).** When the owner agent's model skips `propose_task_intent`, should the runtime retry
  in-turn, or only flag it? The AC accepts either, as long as it is never silent.
- **Performance defaults proposed (confirm or adjust):** 120s confirm-to-approach, 120s approval-to-DOING,
  under 3s button response, 5s judge bound, under 300ms p95 cross-turn dedup.

