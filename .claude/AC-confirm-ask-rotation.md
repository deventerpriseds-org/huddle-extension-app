<!--
WHAT:          Acceptance criteria (Given/When/Then, numbered, binary) for the confirm-ask LANE ROTATION +
               RE-ASK fix and the task-creation DEDUP holes in Huddle auto-work.
WHY:           Owner policy (verbatim): "keep re-asking, but in a loop moving to the next item in the lane...
               i believe there are ~3 at a time but it gets stuck on the first." Measured: only
               upNextAfterTopUp[0] per agent is ever a DOING candidate (autowork.server.ts:596-598), so an
               unanswered top ask starves the lane; no re-ask path exists (markConfirmAsked is one-way,
               getDueConfirmAsks selects 'awaiting' only); ~40 asks unanswered since August (caller-reported).
SUPERSEDES:    nothing. Builds on .claude/AC-confirm-ask-fixes.md (2026-08-26), whose "Fix B" (re-ask) was
               never written. Its B-blocker and the owner's 24h re-ask choice are carried forward here.
               That file is NOT superseded -- its Fix A / Fix C scope stands.
SUPERSEDED-BY: nothing -- current
EVIDENCE:      scripts/autowork-lane-starvation.test.ts (case A = starvation, case B = control), run this pass;
               source reads listed under "Sources read". Live DB counts are CALLER-REPORTED, not re-queried
               here (Azure_pg_mcp unauthenticated; TCP 5432 blocked from CCR).
-->

# Acceptance Criteria — Confirm-ask lane rotation, re-ask loop, and task-create dedup

**STATUS: COMPLETE (2026-10-27) — independent AC pass. 67 ACs (AC-1..AC-67), 8 open questions (OQ-1..OQ-8) each with a
recommended default, and 9 implementer gaps. Nothing implemented. Needs owner sign-off on the OQs first.**

Task: make an agent's unanswered confirm-ask stop blocking its whole Up Next lane. The agent keeps
re-asking, rotating through the items in its lane, and any confirmed + approved item can start. Also close
the duplicate-task holes in task creation.

---

## FINDINGS (verified from source this pass — observation, then interpretation)

### F1. Lane starvation — CONFIRMED by reading the code
- **Observation:** `autowork.server.ts:596-598`: `if (bucket.doing.length < DOING_CAP && upNextAfterTopUp.length)
  doingSlotCandidates.push({ agent, task: upNextAfterTopUp[0], freshPromotion: true })`. Exactly ONE UP_NEXT
  item per agent (index 0) is ever evaluated for DOING. At `:688-710`, a candidate with `confirm_status='asked'`
  falls through every branch ("nothing to do this pass").
- **Interpretation:** the comment at `:569-571` claims "a pending (asked-but-unconfirmed) task occupies its
  UP_NEXT slot but never competes for the DOING slot, so one unanswered ask can't starve the rest of the lane".
  **The code does the opposite.** The comment states the spec (`docs/plan-wip-confirm-review-gate.md` req #6);
  the code violates it. Note also that items 2..3 of the lane never get `needsAskAt` arming on the full pass.
  Only the `promoteOnly` path (`:636-668`) arms every staged item, so items 2..3 are asked only if a groom ran.

### F2. No re-ask path — CONFIRMED
- `markConfirmAsked` (`tasks.server.ts:974-982`): `UPDATE ... SET confirm_status='asked' WHERE confirm_status='awaiting'`.
  One-way, no attempt counter, no `last_asked_at`.
- `getDueConfirmAsks` (`tasks.server.ts:999-1017`): `WHERE es.confirm_status = 'awaiting'`. An `asked` row can never be re-selected.
- `reArmConfirmAskAt` (`:960-968`) and `getLatestPendingConfirmAskAt` (`:913-928`) are both scoped to
  `confirm_status='awaiting'`. So the spacing floor does NOT see asked rows, and nothing can re-arm one.
- Schema (`tasks.server.ts:148-215`): no column records when an ask was last SENT. `confirm_ask_at` is the
  *scheduled* instant and `updated_at` is any write. **A re-ask needs a sent-at / attempt record that does not exist yet.**

### F3. B-blocker (carried from AC-confirm-ask-fixes.md) — CONFIRMED still present
- `fireDueConfirmAsks` enqueues with id `` `autowork-confirm-${row.task_id}` `` (`autowork.server.ts:386`), with
  no run id and no attempt number. `enqueueTurn` is `ON CONFLICT (id) DO NOTHING`. The call site ignores the
  boolean and does `fired++` (`:391`). **So a second ask for the same task through this path inserts NOTHING
  and still counts as sent.** The cadence-path site (`:742`) uses `autowork-confirm-${runId}-${task.id}` (unique
  per pass). The two sites differ.

### F4. Reply-binding hazard (NEW — not in the brief)
- `getPendingConfirmForAgent` (`tasks.server.ts:1026-1063`) returns ONE task per agent:
  `confirm_status='asked' ... ORDER BY es.updated_at DESC LIMIT 1`. The turn engine uses it to bind the user's
  DM reply to a task and record `confirm_task_intent` deterministically (`huddle.functions.ts`, per prior AC F12).
- **Interpretation (inference, high confidence):** today each agent has at most ~1 asked item at a time,
  because only item [0] is asked on the full pass. Rotation creates SEVERAL `asked` items per agent DM. The
  "most recent `updated_at`" heuristic then binds "yes, do that" to whichever row was last written for ANY
  reason (e.g. a `proposeTaskDod` write, a reassignment). That can be a different item from the one the agent
  just asked about. **A rotation fix that ignores this confirms the WRONG task.** That is a gate leak:
  a task reaches `confirmed` without the user ever confirming it.

### F5. getDueConfirmAsks does not check lane/stage/blocker/reminder (observation)
- Its WHERE clause excludes DONE and parking-lot only. It does NOT require `status='UP_NEXT'`, does NOT exclude
  `task_blockers` rows, and does NOT exclude reminder-window tasks (which `runScheduledAutoWork` excludes at
  `:533-537`). So a task can be asked about after leaving Up Next.
- `AND NOT ('parking-lot' = ANY(jt.tags))`: if `jt.tags` is SQL NULL, the predicate is NULL and the row is
  **excluded**. Whether tags can be NULL in the mirror is NOT verified here. Flagged as a possible silent
  non-fire, to check at implementation.

### F6. Existing test reproduces F1 — see "Test run" below.

### Test run (this pass)
`bun test scripts/autowork-lane-starvation.test.ts` -> **2 pass / 0 fail**.
`A result: {"promoted":0,"enqueued":0,"promotions":[]}`. `B result: {"promoted":1,"enqueued":1,"promotions":[{"task_id":"ready-second","status":"DOING"}]}`.
Case A = defect reproduced (asked-top + ready-second -> 0 DOING). Case B = the control.

### F7. Spacing/windows are NOT user-changeable today (observation)
- `resolveConfirmFanWindows(_email)` and `resolveConfirmGap(_email)` (`scheduling-config.server.ts:155-180`) ignore
  their argument and return `CONFIRM_FAN_WINDOWS_DEFAULT` / `CONFIRM_GAP_DEFAULT`. The doc comments say "kept
  async + email-scoped so a per-user override can be layered in later". **That hook is the place to extend.**
  The owner's constraint ("re-ask interval and per-day cap user-changeable") is unmet for the EXISTING
  spacing too, not only for the new knobs.
- `CONFIRM_FIRE_MAX_PER_USER_PER_TICK = 2` (`autowork.server.ts:173`) is a code literal (per-tick, not per-day).
- No per-DAY cap exists anywhere.

### F8. Settings save path will silently DROP a new knob unless it is threaded through (observation, high-risk)
- `identity.scheduling_config.overrides` is JSONB typed `Partial<Record<JobTypeKey, JobCadence>>`.
- `setSchedulingConfig` (`:203-220`) is a WHOLE-OBJECT upsert (`overrides = EXCLUDED.overrides`).
- `setMySchedulingConfigFn` (`scheduling-config.functions.ts`) validates with
  `z.record(z.enum(JOB_TYPE_KEYS), CadenceInput.optional())`. `CadenceInput` = `{tz, hours, daysOfWeek?, everyMinutes?}`.
  The file's own comment records the precedent: *"a row the panel shows but this list omits cannot be saved —
  which is what `scheduleBrief` was after #63"* and *"Without this the validator would STRIP it on every
  save and silently revert a minute job to hourly."*
- `SchedulingPanel.tsx:144-148, 186-194` sends `{...overrides, [key]: next}` and replaces local state with the response.
- **Interpretation:** if the re-ask interval or day cap goes into `overrides` (or a sibling field) without
  extending the zod schema AND the panel's round-trip, then (a) saving it fails or is stripped, or (b)
  saving any OTHER cadence row wipes it. Both are silent. ACs below pin both directions.

### F9. Gate fail-closed is already correct and must stay (observation)
- `isStructuredWorkflowRequired` returns `true` on any config-read error (`agent-workflow-config.server.ts:277-289`).
- `autowork.server.ts:688` uses `requiredByAgent.get(c.agent) ?? true`. The promoteOnly arm uses the same `?? true` (`:657`).
- Promotion to DOING requires `confirm_status==='confirmed' && approach_status==='approved'` (`:694-700`).
  `clarify_status==='open'` vetoes (`:714-716`).

### F4 (UPGRADED from inference to CONFIRMED by reading huddle.functions.ts:686-731)
- In a `dm-<agent>` turn that is not internal, `runHuddleTurn` calls `getPendingConfirmForAgent(em, dmAgent)`.
  If the user's text passes `isPlainConfirmation` ("yes", "ok", "sounds good", ... `:620-629`), it calls
  **`confirmTaskIntent(pc.taskId, em, dod)` DETERMINISTICALLY, with no model involved**, and writes the DoD to journey.
  `pc` = the agent's `asked` row with the newest `updated_at` (`tasks.server.ts:1046`).
- `updated_at` is bumped by `markConfirmAsked`, `proposeTaskDod` (`:1413-1435`), `reArmConfirmAskAt`, and other writers.
  Today the newest asked row is almost always the item just asked, because only one item per agent is
  ever asked on the full pass.
- **Consequence for rotation:** if several items in one agent's lane are `asked` at once, a "yes" typed in the
  DM confirms whichever was written last. That is not necessarily the one the visible message is about.
  **This is a gate leak, not a UX nit:** `confirmed` + `approved` is exactly what moves a task to DOING.
- The **button** path (`confirmTaskFromProposal`, `confirm-ask.functions.ts:39-128`) is SAFE. It carries an
  explicit `taskId`, checks ownership (`getOwnedTaskForConfirmAsk`), and refuses with no `proposed_dod`.
- Side note (out of scope, flagged): when `pc.proposedDod` is null, the deterministic path stores the reply text
  itself as the DoD (`dod = (pc.proposedDod ?? replyText)`), e.g. DoD = "yes".

### F10. Confirmed + approach 'pending' has NO re-drive (observation)
- `autowork.server.ts:694-700`: confirmed but not approved => `promotedToDoing=false`, and nothing is enqueued.
- `propose_approach` is only ever requested inside the confirm turn's directive (`confirmIntentDirective`,
  `autowork.server.ts:157-163`) and the reply directive (`huddle.functions.ts:~2406`). If that turn never called
  it, no code path asks the agent again. `grep` for an approach-pending re-drive found none.
- Under today's [0]-only logic such an item at the top ALSO starves the lane (same mechanism as F1).
- `approach_status='escalated'` is a separate, owner-facing state (override flow in `confirm-ask.functions.ts`)
  and must NOT be auto-redriven.

### F11. Reassignment resets state (observation, regression-relevant)
- `resetEngagementOnReassignment` (`tasks.server.ts:1481-1496`) sets `confirm_status='awaiting'` and
  `confirm_ask_at=NULL` and clears approach/clarify. Any new re-ask columns (attempt count, last-sent-at) must
  be reset here too. Otherwise a reassigned task inherits the old agent's re-ask history and day-cap accounting.

### F12. Lane order is time-dependent (observation -> design constraint)
- `getOpenAssignedTasks` returns `orderForAutowork(rows)` (`tasks.server.ts:840`). The sort keys include `scoreTask(...)`,
  which uses `created_at`, `due_date`, `pushed_count` and `now` (`scoring.ts:220-250`). So an item's index in
  the lane can change between passes without any user action.
- **Interpretation:** "rotate to the next item" cannot be an index pointer such as "last time I asked [0], now [1]".
  Rotation must be keyed on per-item ask history (least-recently-asked first). Otherwise a re-sort makes it
  re-ask the same item or skip one.

### F13. Over-cap lanes exist and the code tolerates them silently (observation)
- `room = Math.max(0, UP_NEXT_CAP - bucket.upNext.length)` (`autowork.server.ts:591`). A 12-item lane just gets
  room 0. Nothing trims it, and nothing here put it there (journey's planner or the user can set UP_NEXT directly).
  The live "12 in UP_NEXT" is caller-reported, not re-queried.

### F14. Dedup — every task-create path, verified
| # | Path | Location | Dedup today |
|---|---|---|---|
| D1 | `create_huddle_task` (text, both dispatchers) | `huddle.functions.ts:2823-2844` | YES: per-turn `createdTaskTitles` + cross-turn `loadExistingOpenTitles()` (`:1874`), which wraps `loadOpenTaskTitles` |
| D2 | `create_huddle_tasks` batch | `huddle.functions.ts:3048-3064` -> `parse_and_create_tasks` `:3084` | YES, same two sets |
| D3 | Voice `create_huddle_task(s)` | `voice/realtime-tools.server.ts:665-734` | YES: `loadOpenTaskTitles` per call. No per-turn ledger shared with text |
| D4 | **Raw journey passthrough, OpenAI dispatch** | `huddle.functions.ts:4621-4640` (`journeyNames.has(c.name)` -> `invokeJourneyTool`) | **NO.** Only hook: `maybeDeferStatusChange` (`:2717`), which handles `update_task` status only |
| D5 | **Raw journey passthrough, Lovable dispatch** | `huddle.functions.ts:6155-6175` (`lovableTools[def.name]`) | **NO.** Same hook, same gap |
| D6 | **Raw journey passthrough, voice** | `voice/realtime-tools.server.ts:820` ("Anything not native -> route to the journey catalog directly") | **NO** |
| D7 | **Produce path `runProduce`** (deep ask -> board task) | `huddle.functions.ts:~1587-1600` -> `quick_create_task {title}` | **NO** (not in the brief) |
- `HIDDEN_FROM_HUDDLE = {web_search, send_email}` (`journey/proxy.functions.ts:85`) is applied to the catalog on text
  (`:904`) and voice (`:426`). `quick_create_task` and `parse_and_create_tasks` stay offered on ALL three surfaces.
- `loadOpenTaskTitles` (`create-task-core.ts:89-104`) catches everything and returns an EMPTY set. That is fail-OPEN
  and SILENT: no `recordFallback`, no log.
- Its source `getTasksForUser` (`tasks.server.ts:563-576`) excludes `DONE` **and `BLOCKED`**, and has **`LIMIT 500`**
  with no ORDER BY. So (a) a duplicate of a BLOCKED task is allowed, and (b) above 500 open tasks an arbitrary
  subset is compared.
- **Two identical `normalizeTaskTitle` exports**: `create-task-core.ts:31` and `scoring.ts:35`. They are byte-identical
  today (`trim().toLowerCase().replace(/\s+/g," ")`), so there is drift risk the moment one is extended. Neither strips
  punctuation, so "Buy camera." and "Buy camera" are distinct.
- The fix extends the existing `maybeDeferStatusChange` interception point (D4/D5) and `create-task-core.ts`
  (shared by text + voice). No new dedup module and no new table.

### Baseline suites (run this pass, all green before any change)
- `bun test scripts/autowork-lane-starvation.test.ts`: 2 pass (case A characterizes the DEFECT).
- `bun scripts/confirm-spacing.test.ts` (a script, NOT a `bun test` suite; `bun test` reports "0 tests" for it): ALL PASS.

---

## Sources read
`src/features/huddle/lib/tasks/autowork.server.ts` (whole file); `tasks.server.ts` (schema 140-215, 810-1063,
1395-1496); `identity/scheduling-config.server.ts` (whole); `identity/scheduling-config.functions.ts`;
`components/SchedulingPanel.tsx` (save path); `identity/agent-workflow-config.server.ts` (90-304);
`tasks/scheduler.server.ts` (heartbeat 270-300); `tasks/confirm-ask.functions.ts` (20-130, 598-660);
`huddle.functions.ts` (600-731 reply binding, 1580-1600 produce, 1856-1876, 2385-2410, 2717-2745, 2823-2844,
3048-3090, 3412-3420, 4605-4660, 6150-6175); `tasks/create-task-core.ts` (whole); `tasks/scoring.ts` (25-50,
160-250); `journey/proxy.functions.ts` (85-94); `voice/realtime-tools.server.ts` (30-60, 172-200, grep 420-830);
`scripts/autowork-lane-starvation.test.ts`; `scripts/confirm-spacing.test.ts`; prior `.claude/AC-confirm-ask-fixes.md`.
NOT read: journey-voice's `quick_create_task` / `parse_and_create_tasks` implementations (they may dedup server-side;
unverified). The live DB was not queried.

## Existing system this extends (not duplicates)
- **Rotation + re-ask:** extend `runScheduledAutoWork`'s per-agent bucket loop (`autowork.server.ts:585-599`), plus
  `fireDueConfirmAsks` and its `getDueConfirmAsks` / `markConfirmAsked` / `getLatestPendingConfirmAskAt` in
  `tasks.server.ts`. State lives on the EXISTING `tasks.task_engagement_state` row (new columns via the file's own
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` pattern). The scheduler is the EXISTING heartbeat
  (`scheduler.server.ts:290`). **No new table, no new scheduler, no new sender** (push stays `enqueueTurn` -> `notify:"push"`).
- **Settings:** extend `identity.scheduling_config` + `resolveConfirmGap` / `resolveConfirmFanWindows`-style resolvers
  (whose comments already reserve the per-user hook) + `setMySchedulingConfigFn` + `SchedulingPanel.tsx`.
- **Dedup:** extend `create-task-core.ts` (`normalizeTaskTitle`, `loadOpenTaskTitles`) and the existing passthrough
  interception point (`maybeDeferStatusChange` call sites `:4623` / `:6165`), plus the voice catalog router.

Terms used below: **lane** = an agent's UP_NEXT items in `getOpenAssignedTasks` order, after top-up.
**ready** = `confirm_status='confirmed' AND approach_status='approved' AND clarify_status<>'open'`.
**ask-eligible** = in the lane, not ready, `confirm_status IN ('awaiting','asked')`, `clarify_status<>'open'`.
**rotation window** = the first `UP_NEXT_CAP` (3) items of the lane (see OQ-1 for over-cap lanes).
**harness** = `scripts/autowork-lane-starvation.test.ts`'s mock pattern (real `runScheduledAutoWork`, mocked stores),
extended with more cases.

---

## ACCEPTANCE CRITERIA

### A. Lane selection: one unanswered ask never blocks the lane (fixes F1)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-1 | Given tess's lane `[asked-top (ASKED), ready-second (READY)]`, no DOING, no review backlog, when `runScheduledAutoWork(force)` runs, then `promotions` contains exactly `{task_id:"ready-second",status:"DOING"}`, `enqueued` has exactly 1 id containing `ready-second`, and `promotions` has NO entry for `asked-top`. | happy-path / regression (case A FLIPS) | harness case A, expectations inverted in the same commit; file header STATUS updated |
| AC-2 | Given the same two items with `ready-second` on top, when the pass runs, then the result is identical to AC-1. | regression (case B unchanged) | harness case B, unmodified |
| AC-3 | Given a lane `[asked, asked, ready]`, when the pass runs, then the 3rd item is promoted to DOING and enqueued. | edge | new harness case |
| AC-4 | Given a lane `[ready-1, ready-2]`, when the pass runs, then ONLY `ready-1` (higher lane order) is promoted, so DOING writes per agent = 1. | edge / WIP | new harness case: count `status:"DOING"` per agent = 1 |
| AC-5 | Given an agent that already has 1 DOING task and a READY item in UP_NEXT, when the pass runs, then no UP_NEXT item for that agent is promoted. | regression (DOING_CAP) | new harness case |
| AC-6 | Given an agent with 2 IN_REVIEW tasks and a READY item in UP_NEXT, when the pass runs, then no promotion is written for that agent and no research turn is enqueued for it. | regression (REVIEW freeze) | new harness case |
| AC-7 | Given a lane `[confirmed+approach 'pending', ready]`, when the pass runs, then `ready` is promoted and the pending item is NOT. | mixed lane (F10) | new harness case |
| AC-8 | Given a lane `[confirmed+approach 'escalated', ready]`, when the pass runs, then `ready` is promoted and the escalated item is not promoted or enqueued. | mixed lane | new harness case |
| AC-9 | Given a lane `[READY but clarify_status='open', ready-2]`, when the pass runs, then `ready-2` is promoted and the clarify-open item gets no promotion and no turn. | edge (clarify pauses, lane moves on) | new harness case |
| AC-10 | Given a lane where every item is `asked` (none ready), when the pass runs, then 0 DOING promotions and 0 research turns are enqueued for that agent. | edge | new harness case |
| AC-11 | Given a lane of 12 UP_NEXT items where only item #9 is READY, when the pass runs, then item #9 IS promoted to DOING. (Recommended default; OQ-1 must ratify it. If the owner instead chooses "first 3 only", this AC inverts to "not promoted" and AC-12 still holds.) | over-cap | new harness case |
| AC-12 | Given a 12-item UP_NEXT lane, when the pass runs, then the pass writes NO status change that demotes, parks or re-tags any of the 12 items, and `promotions` contains no `UP_NEXT` top-up for that agent (room = 0). | over-cap / regression (no auto-shelving) | new harness case: `promotions` filtered to that agent's ids has only DOING entries |
| AC-13 | Given `isStructuredWorkflowRequired` mocked to REJECT for the agent (and separately: the agent absent from `requiredByAgent`), and a lane `[asked, awaiting, confirmed+pending]`, when the pass runs, then 0 DOING promotions and 0 research turns, and the pass resolves (does not throw). | regression (gate FAIL-CLOSED) | new harness case. Note: today a rejection inside the `Promise.all` at `:674-680` would make the pass throw. The AC requires "resolves with no promotion", not merely "throws" |
| AC-14 | Given a task already in DOING with `confirm_status='asked'` (it got there by a race), when the pass runs, then it is NOT enqueued for research. | regression (2026-08-05 leak, `freshPromotion:false`) | new harness case |
| AC-15 | Given a lane with a `parking-lot`-tagged item and an item in its reminder window (`taskIdsInReminderWindow`), when the pass runs, then neither is promoted, asked, or re-asked. | regression | new harness case (mock returns the id in the reminder set) |
| AC-16 | Given `opts.promoteOnly=true` and a lane containing a READY item, when the pass runs, then `promotions` contains only `UP_NEXT` entries (no DOING) and `enqueued` is empty. | regression (groom chain) | new harness case |
| AC-17 | Given any harness run in sections A-C, when `promotions` is inspected, then every `status` is in `{UP_NEXT, DOING}`: never `DONE`, `BACKLOG`, `IN_REVIEW`, and never a `tags` write. | regression (DONE user-only, no auto-park) | assertion added to every new harness case |
| AC-18 | Given the fix is merged, when `grep -n "UP_NEXT_CAP = \|DOING_CAP = \|REVIEW_CAP = " autowork.server.ts` runs, then the values are 3, 1, 2. | regression (WIP caps) | grep in the verifier |
| AC-19 | Given a lane of N items, when the pass runs, then `getTaskEngagementStates` is called ONCE per pass, covering every agent's lane ids (no per-item N+1 query). | performance | harness mock call counter |

### B. Re-ask loop and rotation order (fixes F2, F3, F4, F10, F12)

"Simulated clock" = `fireDueConfirmAsks(now)` / `runScheduledAutoWork` driven tick-by-tick with an injected `now`, and
store mocks that persist writes between ticks (extend the harness, or add `scripts/confirm-reask-rotation.test.ts`).
"Push" = an `enqueueTurn` call whose payload has `notify:"push"` and `huddleId:"dm-<agent>"`.

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-20 | Given an item whose last ask was sent at T and is still unanswered (`asked`), and a re-ask interval of I (setting; seeded default per OQ-4), when the clock is at T+I-1min, then no re-ask push is sent for it. At T+I, inside a fan window, with spacing and day cap satisfied, exactly one re-ask push is sent for it. | happy-path / boundary | simulated clock |
| AC-21 | Given the item was re-asked, when the engagement row is read, then a durable LAST-SENT timestamp and an attempt count (or equivalent) changed. Neither is derived from `updated_at` or `confirm_ask_at`. | data integrity (F2) | row read in test, plus `information_schema.columns` check in the verifier for the new columns |
| AC-22 | Given the same task is re-asked twice, when the turn ids are inspected, then each re-ask produced a DISTINCT `enqueueTurn` id and a NEW `chat.pending_turns` row. The first-ask id `autowork-confirm-${task_id}` is never reused for a re-ask. | regression (B-blocker, F3) | harness: `enqueued` ids unique; mock `enqueueTurn` keyed `ON CONFLICT DO NOTHING` semantics |
| AC-23 | Given `enqueueTurn` returns `false` (id conflict) for an ask, when `fireDueConfirmAsks` returns, then that ask is NOT counted in its return value and its last-sent / attempt state is NOT advanced (so it stays eligible). | error (B-blocker: no silent "sent") | harness: mock `enqueueTurn` returns false, assert return 0 and state unchanged |
| AC-24 | Given tess's rotation window `[A asked 2d ago, B never asked (awaiting, armed+due), C asked 1d ago]`, all unanswered, past the interval, when 4 consecutive ask opportunities fire, then the asked task ids in order are `B, A, C, B`: least-recently-asked first, never-asked first of all, ties broken by lane order, wrapping round-robin. | rotation order + wrap-around | simulated clock: ordered list of task ids in confirm pushes |
| AC-25 | Given the lane is RE-SORTED between ticks (scores change so C moves above A), when the next ask fires, then the choice still follows AC-24's least-recently-asked rule: no item is asked twice before every other ask-eligible item in the window has been asked once. | rotation robustness (F12) | simulated clock with `getOpenAssignedTasks` mock reordering between ticks |
| AC-26 | Given an agent has an UNANSWERED ask, when the rotation moves on, then at most ONE confirm push per agent is in flight per spacing gap. Rotation never sends A, B and C to the same agent back-to-back inside one gap. | trickle | simulated clock: per-agent push timestamps differ by at least gap.min |
| AC-27 | Given B was asked after A (both `asked`), and AFTERWARDS A's row was written for an unrelated reason (e.g. `proposeTaskDod(A)` or any `updated_at` bump), when the user types "yes" in `dm-tess`, then `confirmTaskIntent` is called for **B** only. A stays `asked`. | **gate integrity (F4)** | unit test of `getPendingConfirmForAgent` ordering (ordered by last-SENT, not `updated_at`) plus a `runHuddleTurn` deterministic-capture test asserting the `confirmTaskIntent` task id |
| AC-28 | Given two `asked` items for one agent, when the user taps **Confirm** on A's button row (explicit taskId), then A, and only A, becomes `confirmed`, whichever was asked last. | happy-path (button path stays task-specific) | `confirmTaskFromProposal` unit test, 2 asked rows |
| AC-29 | Given a re-ask turn for item A, when its payload is inspected, then it contains A's task id, instructs `propose_task_intent` for A (so `proposed_dod` exists and the Confirm button does not fail with "No proposed plan found…"), and is `notify:"push"` to `dm-<assigned agent>`. | happy-path (A-blocker carried) | harness: payload `text` includes `task_id "A"` and `propose_task_intent`; `notify==="push"` |
| AC-30 | Given the re-ask is for an item asked before, when its directive text is generated, then it reads as a follow-up to the earlier check-in, not a first-contact greeting. Shape per OQ-2 (recommended: a new message in the same DM thread). | UX | harness: directive differs from first-ask directive and contains a follow-up marker (exact wording pinned at implementation) |
| AC-31 | Given B is answered (Confirm button, or plain "yes" bound per AC-27), when the next 10 ask opportunities fire, then B is NEVER confirm-asked again, and rotation continues over the remaining unanswered items (A, C). | answered ask resumes normal flow | simulated clock |
| AC-32 | Given B is confirmed and its approach becomes `approved`, and tess has no DOING, when the next full pass runs, then B is promoted to DOING and enqueued, even though A and C sit above it unanswered. | answered -> work starts | simulated clock + harness |
| AC-33 | Given an item with `clarify_status='open'`, when ask opportunities fire, then it receives no confirm ask or re-ask. Rotation skips it. When `clarify_status` returns to `'none'`, it re-enters rotation on the next opportunity. | clarify pauses | simulated clock |
| AC-34 | Given an item `confirmed` + `approach_status='pending'` (F10), when the re-drive runs, then the agent gets an internal turn that asks it to call `propose_approach` for that task id. The user is NOT asked to re-confirm the DoD, and `confirm_status` stays `confirmed`. Promotion happens only after `approach_status='approved'`. | stuck-approach fix (problem #3) | harness: turn payload names `propose_approach` and the task id; `confirm_status` unchanged; no promotion before approval |
| AC-35 | Given the approach re-drive has run as many times as the existing approach cap (`WorkflowCaps.approach`, via `getWorkflowCaps`), when the next opportunity fires, then no further re-drive is sent and the item follows the existing escalation (`approach_status='escalated'`). The re-drive does not loop forever and no new cap constant is introduced. | edge (bounded) | harness + grep: no new numeric cap literal in autowork.server.ts |
| AC-36 | Given an `approach_status='escalated'` item, when any ask or re-drive opportunity fires, then it receives NEITHER a confirm re-ask NOR an approach re-drive. The owner-override flow in `confirm-ask.functions.ts` still owns it. | regression | simulated clock |
| AC-37 | Given an `asked` item that LEAVES the lane (the user moved it to BACKLOG, marked it DONE, tagged it `parking-lot`, or an agent flagged it via `task_blockers`), when the next opportunities fire, then it is not re-asked. If it later returns to UP_NEXT, its re-ask eligibility resumes from its existing history (no instant burst). | edge | simulated clock with mock board changes |
| AC-38 | Given an item with re-ask history is REASSIGNED to another agent, when `resetEngagementOnReassignment` runs, then the new last-sent and attempt columns are reset with the rest. The new assignee's first ask is a FIRST ask (directive and id), not a re-ask. | regression (F11) | unit test of the reset SQL's column list + harness |
| AC-39 | Given a task with `tags IS NULL` in `tasks.journey_tasks`, armed and due, when `getDueConfirmAsks` / re-ask selection runs, then the task IS selected. The `NOT ('parking-lot' = ANY(tags))` NULL trap (F5) does not silently exclude it. | edge (F5) | live read via `azure-pg-query.yml` against a `Test-` fixture row, OR the SQL rewritten with `coalesce(tags,'{}')` and asserted by grep |
| AC-40 | Given a task whose ask is due but it is no longer in UP_NEXT, or is in `task_blockers`, or is in its reminder window, when `fireDueConfirmAsks` runs, then no push is sent for it. | edge (F5) | harness against the new selection |

### C. Spacing, day cap, backlog trickle, and Settings (owner constraint: user-changeable, no flood)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-41 | Given a simulated 7-day run with the live-shaped backlog (40 `asked` items across 6 agents, all asked >60 days ago; plus 5 fresh `awaiting` items), when every minute is ticked, then ANY two consecutive confirm-ask pushes (first asks AND re-asks, all agents) for the user are at least `gap.min` (default 45) minutes apart. | performance / trickle | simulated clock, timestamps of all pushes. NOTE: today `CONFIRM_FIRE_MAX_PER_USER_PER_TICK=2` can send 2 in the same minute. This AC deliberately requires the stricter property for re-asks |
| AC-42 | Given the same run, when push timestamps are converted to the user's tz, then 100% fall inside the effective fan windows (default 9-18 and 20-22), and none falls in 18:00-19:59 or 22:00-08:59. | performance | simulated clock |
| AC-43 | Given a per-day re-ask cap K (setting; seeded default per OQ-5), when the 7-day run is bucketed by local calendar day, then re-ask pushes per day are at most K on every day. Leftover stale items are still `asked` (not parked, not BACKLOG, not deleted) and are re-asked on later days. | trickle / no auto-shelving | simulated clock + final state of all 40 rows |
| AC-44 | Given the first heartbeat after deploy with all 40 stale asks past the interval, when the first 60 simulated minutes run inside a window, then at most 1 confirm-ask push is sent in that hour. | performance (deploy-day flood guard) | simulated clock |
| AC-45 | Given re-ask candidates across several agents and a day cap smaller than the number of agents, when the 7-day run completes, then every agent with a stale ask has been re-asked at least once before any agent is re-asked twice (oldest-last-sent across the USER first). | fairness | simulated clock |
| AC-46 | Given the day cap is set to 0, when the 7-day run executes, then 0 re-asks are sent AND first asks for fresh `awaiting` items still fire normally. | edge (0 means re-asks off, NOT unlimited) | simulated clock |
| AC-47 | Given the user opens Settings -> Scheduling, when the panel loads, then it shows the re-ask interval and day cap with their effective values (the seeded default when unset). Changing either and saving persists it: reload shows the new value, and `resolve<ReAsk…>(email)` returns it. | happy-path (config-centric) | Playwright via `verify-uat.yml` on the panel, plus a server-fn round-trip via `getMySchedulingConfigFn` |
| AC-48 | Given the re-ask interval and day cap are set to non-defaults, when the user then edits and saves an UNRELATED cadence row (e.g. Auto-work hours), then both re-ask values are unchanged after reload. | regression (F8: whole-object upsert wipe) | server-fn test: set re-ask, then `setMySchedulingConfigFn` with only an autowork change, then `getMySchedulingConfigFn` |
| AC-49 | Given a save with invalid values (negative interval, interval below `gap.min`, non-integer or negative cap), when `setMySchedulingConfigFn` runs, then it returns an `error` and the stored config is unchanged. A valid save is not stripped by the zod schema (round-trips byte-identical). | error | server-fn test |
| AC-50 | Given the scheduling-config read THROWS, when re-ask resolution runs, then it falls back to the SEEDED defaults (interval and cap). It never resolves to "no cap" or "interval 0". | error (safe degradation) | unit test with a throwing pool mock |
| AC-51 | Given the merged diff, when `autowork.server.ts` and `tasks.server.ts` are grepped for the re-ask interval and cap values, then neither appears as a literal. They are defined only as seeded defaults in `identity/scheduling-config.server.ts`, next to `CONFIRM_GAP_DEFAULT`. | config-centric | grep in verifier |
| AC-52 | Given a heartbeat tick with nothing due, when `fireDueConfirmAsks` runs, then it issues at most one additional indexed query for re-ask candidates, and the tick's added wall time is under 200 ms against the mocked store (no per-task loop before the cap/spacing filter). | performance | harness timing + mock call count |
| AC-53 | Given re-ask selection throws (DB error), when the heartbeat tick runs, then `runDueScheduledJobs` still claims and dispatches its other jobs. `fireDueConfirmAsks` never throws. | error / regression | `scripts/scheduler-one-user.test.ts`-style test with a throwing re-ask query |
| AC-54 | Given the new behaviour, when `bun scripts/confirm-spacing.test.ts` runs, then it prints `ALL PASS`. | regression | script exit 0 |

### D. Task-creation dedup (fixes problem #4)

"Open task" = the same set `loadOpenTaskTitles` reads (`getTasksForUser`: not DONE, not BLOCKED, `completed_at IS NULL`).
All fixture titles are `Test-` prefixed per repo rule.

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-55 | Given an open task `Test-buy studio camera`, when an agent calls raw journey `quick_create_task` with title `"  test-Buy  Studio Camera "` through the OpenAI dispatch (D4), then `invokeJourneyTool` is NOT called with `quick_create_task`, the tool result returned to the model says it was skipped as a duplicate (same shape the model already gets from `create_huddle_task`), and `recordToolUse` records it. | happy-path (D4) | unit test of the interception (mock `invokeJourneyTool` call log) |
| AC-56 | Same as AC-55 via the Lovable dispatch (D5, `lovableTools[def.name].execute`). | happy-path (D5) | unit test |
| AC-57 | Same as AC-55 via the voice catalog router (D6, `realtime-tools.server.ts:~820`). | happy-path (D6) | extend `scripts/voice-toolset-hidden.test.ts`-style test |
| AC-58 | Given an open task `Test-buy studio camera`, when the produce path (`runProduce`, D7) derives that same title, then no second journey task is created and the produce acknowledgement still goes out. | happy-path (D7) | unit test of runProduce with a mocked `invokeJourneyTool` |
| AC-59 | Given open `Test-A` and a raw `parse_and_create_tasks` call with `["Test-A", "Test-B"]` (or text `"Test-A; Test-B"`), when it dispatches, then journey receives ONLY `Test-B`. Given all entries are duplicates, then journey is not called at all. | edge (batch) | unit test |
| AC-60 | Given one turn where the agent calls `create_huddle_task("Test-X")` and THEN raw `quick_create_task("Test-X")`, when the turn completes, then exactly ONE journey create happened. The raw path consults the same per-turn `createdTaskTitles` ledger. | edge (mixed paths, same turn) | turn-level unit test |
| AC-61 | Given open `Test-call the bank` assigned to finn, when ANOTHER agent (sam) creates `Test-call the bank` by any path, then it is deduped. Dedup is per USER, not per agent. | edge ("same task under two agents") | unit test |
| AC-62 | Given open `Test-buy studio camera`, when an agent creates `Test-research camera lenses` or `Test-buy studio camera bag`, then each IS created. | regression (no false-positive block) | unit test |
| AC-63 | Given a task `Test-renew passport` that is DONE, when it is created again, then it IS created (completed tasks never block a re-create). | regression | unit test |
| AC-64 | Given `getTasksForUser` throws during the title load, when any create path runs, then the create PROCEEDS (per OQ-6's recommended fail-OPEN) AND a visible fallback event (`recordFallback` / tool-use note "dedup unavailable") is recorded. It is not a silent empty set. If OQ-6 resolves fail-CLOSED, this AC inverts to "create refused with a readable error". | error | unit test with throwing `getTasksForUser` |
| AC-65 | Given the merged diff, when `grep -rn "export function normalizeTaskTitle" src/` runs, then exactly ONE definition exists and every caller (create-task-core, scoring, voice, huddle.functions) imports it. | regression (single normalizer) | grep |
| AC-66 | Given the existing create paths D1-D3, when their current tests and `scripts/voice-toolset-hidden.test.ts` run, then they pass unchanged (`create_huddle_task` -> `quick_create_task`; `create_huddle_tasks` -> `parse_and_create_tasks`). | regression | `bun test scripts/voice-toolset-hidden.test.ts` |
| AC-67 | Given a raw journey tool that is NOT a create (`update_task`, `get_tasks`), when it is dispatched, then the dedup interception does not touch it, and `maybeDeferStatusChange` behaviour is unchanged. | regression | unit test |

---

## Goal -> AC coverage
| Owner goal | ACs |
|---|---|
| G1 "it gets stuck on the first": an unanswered ask must not block the lane | AC-1..AC-11, AC-32 |
| G2 "keep re-asking": unanswered asks are asked again, never shelved | AC-20..AC-23, AC-37, AC-43 (no auto-park), AC-12, AC-17 |
| G3 "in a loop moving to the next item in the lane" | AC-24, AC-25, AC-26, AC-31, AC-33 |
| G4 Gate stays fail-closed; nothing reaches DOING without confirm + approve | AC-13, AC-14, AC-7, AC-8, **AC-27 (reply binding)**, AC-28, AC-36 |
| G5 Don't flood the phone; trickle the ~40 stale asks | AC-41..AC-46, AC-52 |
| G6 Interval and cap are user-changeable settings | AC-47..AC-51 |
| G7 Stuck confirmed+pending items get moving (problem #3) | AC-7, AC-34, AC-35 |
| G8 No duplicate tasks, without blocking real ones | AC-55..AC-67 |
| G9 WIP caps and DONE-is-user-only unchanged | AC-4, AC-5, AC-6, AC-17, AC-18 |

**ACs not tied to an owner goal (kept, justified):** AC-19 and AC-52 (performance: the heartbeat runs every minute);
AC-39 and AC-40 (F5 selection holes, which would otherwise make G2 silently fail for some tasks);
AC-38 (F11, which would otherwise corrupt G3's history on reassignment).
**Goal with no AC:** none.

---

## OPEN QUESTIONS — the owner must settle these; each has a recommended default

**OQ-1. Over-cap lanes (one agent has 12 in UP_NEXT; the owner believes it is ~3). What does "rotate" cover?**
| Option | What actually happens | Cost / what you lose | Makes easy later | Makes hard later |
|---|---|---|---|---|
| **(a) RECOMMENDED: asks rotate over the first 3 by rank, but ANY ready item in the whole lane may start** | Re-asks cycle through the top 3. A task you already confirmed at position #9 still starts. | Items #4-#12 are never asked about until they rise into the top 3 | Matches "~3 at a time"; the phone volume is bounded by 3 per agent | Nothing irreversible |
| (b) Rotate over ALL 12 | Every item gets asked eventually | 12 per agent x 6 agents = a lot of re-asks; slower cycling back to the top items | Nothing is forgotten | Volume tuning |
| (c) Trim the lane back to 3 (move the extras to BACKLOG) | Lane matches the cap | **Moves the user's items without asking: conflicts with "no auto-shelving"** | A clean lane | Reverses someone's placement |
Recommendation (a): it is the owner's stated mental model, it bounds volume, and it never moves the user's items.
Separately recommended: report how lanes got over cap (journey's planner, or the user dragging cards) as a
finding, not fix it here. AC-11 encodes (a).

**OQ-2. Is a re-ask a NEW message or a nudge on the old one?** Recommended: a **new agent message in the same
`dm-<agent>` thread**, worded as a follow-up ("circling back on …"), with a fresh button row. The existing pipe can
do this. "Editing/bumping" an old message has no mechanism in the turn store, and the push needs a new turn to fire.
AC-29 and AC-30 encode it.

**OQ-3. Pause re-asks while an agent is review-frozen (2 items IN_REVIEW)?** Recommended: **yes, pause re-asks
(not first asks) for a frozen agent.** Nothing it confirms can start until the user clears review, so the push is
noise. Not encoded as an AC. Add one when the owner answers.

**OQ-4. Re-ask interval default.** The owner already chose **24 hours** on 2026-08-26 (`.claude/AC-confirm-ask-fixes.md`,
"SCOPE CHANGED" item 2). Recommended seed: 24h, user-changeable. If the owner now means "loop faster", the setting
covers it without a deploy.

**OQ-5. Day-cap default, and what it counts.** Recommended seed: **4 re-asks per day per user, counting re-asks only.**
First asks are already bounded by the WIP caps and the 45-90 min spacing. At 4/day the 40-item backlog clears one full
round in about 10 days. With the 24h interval, the windows (11 hours) and the spacing, the natural ceiling is roughly 10/day,
so 4 leaves room for fresh first asks. Owner to confirm the number.

**OQ-6. Dedup title load fails: open or closed?** Recommended: **fail-OPEN (create proceeds) but LOUD** (a recorded
fallback, not today's silent empty set). Reason: the cost of a duplicate is one cleanup row via the `cleanup-board` skill.
The cost of a refused create is a lost user request the user may not notice. This is the opposite polarity from the
confirm gate, deliberately: the gate protects against unapproved WORK, while dedup protects against clutter. AC-64 encodes this.

**OQ-7. Should the normalizer also strip punctuation / trailing periods ("Buy camera." vs "Buy camera")?**
Recommended: **yes, trailing punctuation and surrounding quotes only, no fuzzy matching.** Fuzzy matching would
block "genuinely different" tasks (AC-62). Needs the owner's nod because it changes D1-D3 behaviour too. Not encoded as an AC.

**OQ-8. Should dedup also compare against BLOCKED tasks?** `getTasksForUser` excludes BLOCKED today (F14), so re-creating
a blocked task makes a duplicate. Recommended: **include BLOCKED in the dedup set only** (not in the scorer's set).

---

## GAPS / RISKS FOR THE IMPLEMENTER (not ACs; read before coding)
1. **AC-27 is the highest-risk item in this whole change.** Rotation multiplies `asked` rows per agent, and the existing
   deterministic "yes" path confirms by `updated_at`. Ship rotation without fixing the binding and you have a gate leak.
2. **The two enqueue sites diverge** (F3). Fix both, and test the heartbeat path, not just the cadence path.
3. **Settings whole-object upsert** (F8) has already bitten once (`scheduleBrief` after #63).
4. **The existing spacing/windows are also not user-changeable** (F7: `resolveConfirmGap` / `resolveConfirmFanWindows`
   ignore the email). Not required by the owner's constraint, but Engineering principle #1 (config-centric) applies.
   Cheapest to do in the same Settings change. Flagged, not encoded.
5. **The ~40 stale asks:** nothing in these ACs mutates them in bulk. The re-ask loop picks them up (AC-41..AC-45).
   The owner's 2026-08-26 instruction was "put the stuck tasks back in BACKLOG and re-run grooming". Today's
   instruction, "keep re-asking, no auto-shelving", appears to SUPERSEDE that. Confirm that reading with the owner
   before any bulk move.
6. **The live numbers are caller-reported** (40 stale asks, 12 in one lane). Re-query via `azure-pg-query.yml` before
   sizing OQ-5. Suggested: `SELECT jt.assigned_agent, jt.status, es.confirm_status, es.approach_status, count(*)
   FROM tasks.task_engagement_state es JOIN tasks.journey_tasks jt ON jt.id=es.task_id WHERE jt.completed_at IS NULL
   GROUP BY 1,2,3,4 ORDER BY 1,2;`
7. **journey-side dedup is unverified.** If `quick_create_task` already dedups in journey-voice's `execute-tool`, D4-D7 may
   be partly covered there. Read it before building. If not, Huddle-side is the right layer (one interception, three surfaces).
8. **Performance and error categories:** covered (AC-19, AC-41..AC-46, AC-52; AC-13, AC-23, AC-50, AC-53, AC-64).
9. **Tier:** this change decides a gate (what reaches DOING) and binds user replies to confirmations, so it is **Tier 1**:
   independent verifier after, and mutation-prove AC-1, AC-13, AC-22/23 and AC-27 with `scripts/mutate.sh`.

---

## SCOPE CHANGED BY THE OWNER (2026-10-27, after this pass)
Owner: *"why are we limiting to the top n per agent instead of the entire lane given it is already capped instead of double
capping? ... we already had logic for the interval to ask me and how many times a day ... why would re asks pause if an agent
has 2 or more items instead of asking the first, then asking the second so on and so forth in a loop?"*
1. **OQ-1 → rotate the WHOLE UP_NEXT lane** (no top-3 limit). AC-11 holds; rotation order AC-24/25 applies to every item.
2. **No new day cap and no new interval setting.** Re-asks ride the EXISTING throttle: `armConfirmAsksSpaced` /
   `nextSpacedFanSlotIso` (45–90 min `resolveConfirmGap` chain anchored on `getLatestPendingConfirmAskAt`), inside
   `resolveConfirmFanWindows` (9–18, 20–22), plus `CONFIRM_FIRE_MAX_PER_USER_PER_TICK`. **Dropped: AC-43, AC-45, AC-46,
   AC-47, AC-48, AC-49, and OQ-5.** AC-41/42/44 stay as assertions against the existing chain. The only new value is a
   per-item floor of 24h (owner's own 2026-08-26 choice), as `CONFIRM_REASK_MIN_HOURS_DEFAULT` + `resolveConfirmReaskMinHours`
   in the same pattern as `CONFIRM_GAP_DEFAULT` / `resolveConfirmGap`.
3. **OQ-3 → no pause for review-frozen agents.** Asking keeps looping; only promotion to DOING respects REVIEW_CAP.
