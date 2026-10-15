<!--
WHAT:          adversarial acceptance criteria for "push a task / push a category into This Week"
               (priorities widget), written BEFORE implementation by an independent AC subagent.
WHY:           Tier-1-adjacent: the feature writes journey's star (is_priority/priority_rank), which is
               the ONLY input journey's nightly-schedule-builder uses to put work on the calendar, and
               it changes what Monday's groom is allowed to un-star.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      sources read are listed in "Sources read" below (written incrementally).
-->

# Acceptance Criteria — Push task / push category into This Week

Status: COMPLETE — written by the independent AC subagent 2026-10-15; awaiting owner decisions on OQ-1, OQ-2, OQ-5, OQ-8 (BLOCKING) before implementation.

## Live baseline (supplied by coordinator, measured 2026-10-15)

Source: Huddle mirror `tasks.journey_tasks`, owner dev@enterpriseds.io, non-DONE tasks, via
`azure-pg-query.yml` run 38787342521 (NOT re-measured by this subagent — cited as given).

| bucket | count | meaning for this feature |
|---|---|---|
| is_priority=false | 70 | all rank NULL |
| is_priority=true, rank 1..20 | 26 | **26 > PRIORITY_LANE_MAX=20 with ranks only 1..20 means ranks are DUPLICATED** — consistent with category-scoped grooms (`groom_backlog {category}` ranks 1..N inside one category's slice), so "rank" is NOT a global order today |
| is_priority=true, rank > 20 | 7 | leftovers from the pre-cap 80-rank groom; the capped groom has NOT cleared them (it only unsets ids inside its own `slice` — see groom.ts:168-175, 304-310) |
| is_priority=true, rank NULL | 0 | no phone stars exist right now |
| rank 0 | 0 | journey-web 0..N-1 lane rewrite not in use |
| `tasks.week_order` rows | 0 | owner has never reordered; groom's `userPinned` is currently EMPTY |

Consequence for the bootstrap ACs: on the first groom after deploy there is NO record of which of the
33 current stars the groom created; all 33 have a non-null rank, which is the only fingerprint the
current data offers (phone stars are rank-NULL). See OQ-5 and AC-G*.

## Sources read (this session, cold)

Huddle (`/home/user/huddle-extension-app`):
- `src/features/huddle/lib/tasks/groom.ts` (whole file) — `laneFieldFor`, `laneRanks`, `PRIORITY_LANE_MAX`, slice/filters, `userPinned`
- `src/features/huddle/lib/tasks/grooming.server.ts:104-160` — scheduled groom, `SCHEDULED_MAX=80`, signature gate
- `src/features/huddle/lib/tasks/widgets.functions.ts` (whole file) — `updateWidgetTask`, `reorderWidgetBand`
- `src/features/huddle/lib/tasks/widgets.server.ts:245-470, 570-670, 860-1334` — `isOpen`, `isTreeLive`, `isParked`, `byPriorityThenDue`, `applyWeekOrder`, `buildPrioritiesBand`, `buildCategoryTaskTree`, `mergeTopicTree`, `composePrioritiesWidget`, `fetchTopicPayload` (4s timeout), `findTopicMappings`, `buildPrioritiesTree`, `withKnownCategories`, `ACTION_STATUS`
- `src/features/huddle/lib/tasks/tasks.server.ts:20-120, 265-540, 700-740, 1400-1430` — mirror DDL, `week_order` DDL + comment, `upsertJourneyTask`, `getTasksForUser`, `getWeekOrder`/`setWeekOrder`, `getOwnedTaskForConfirmAsk`
- `src/features/huddle/lib/tasks/scoring.ts:130-180` — `rankTasks`
- `src/features/huddle/lib/tasks/autowork.server.ts:501-575` — `runScheduledAutoWork` early exits
- `src/features/huddle/lib/tasks/scheduler.server.ts` (job table grep) ; `src/routes/api/public/run-autowork.ts`
- `src/routes/api/public/tasks-sync.ts` (whole file)
- `src/features/huddle/lib/journey/proxy.functions.ts:107-127` — `invokeJourneyTool`
- `src/features/huddle/components/JourneyWidgets.tsx:180-275, 580-946` — `runAction`, `PriorityRow`, `TopicRow`, `TopicTaskRow` ("star is shown, not editable"), `PrioritiesWidget` reorder
- `scripts/priority-lane.test.ts`, `scripts/week-order.test.ts` (case lists); `package.json` test scripts

journey (`/home/user/journey-voice/supabase/functions`):
- `execute-tool/index.ts:441-442, 960-1000 (batchUpdateTasks), 2822-2832 (setPriorityRank)`; service-role client at :2862
- `_shared/tool-definitions.ts:247-258` (`set_priority_rank` schema: "Omit to add at end" — code stores NULL)
- `huddle-proxy/index.ts:195-230` (`ok = !!exec.success`)
- `nightly-schedule-builder/index.ts:556-645 (auto-archive steps), 717 (totalDays=7), 940-1140 (candidate gather, score, sort)`

## Existing systems this extends (not duplicates)

| need | existing system that already does it | AC consequence |
|---|---|---|
| the star | journey `public.tasks.is_priority`/`priority_rank`, written via `set_priority_rank` / `batch_update_tasks` | AC-X6: no Huddle-side "star" column or parallel lane |
| per-user Huddle priority state | `tasks.week_order` (one row per user, Huddle-only writer) | AC-X7: pushed-category + groom-starred state extends that row/table or the PR states why a new table is needed — never a second per-user priority store that disagrees with it |
| "the system picks the best task from a category" | `rankTasks` (scoring.ts:143) — already mirrors journey's score + tiebreak and already excludes DONE/BLOCKED/completed_at/parking-lot/reminder-window | OQ-3, AC-C3 |
| task write path + ownership | `updateWidgetTask` / `getOwnedTaskForConfirmAsk` / `invokeJourneyTool` | AC-O1..O4 |
| change detection | `tasks-sync.ts` → `upsertJourneyTask` (already compares prev state for `assigned_agent`, :346-352) | AC-R1 |
| periodic reconcile | autowork 9/13/17 ET job (`/api/public/run-autowork`) | AC-R6/R7 |
| calendar placement | journey nightly-schedule-builder (1am ET) | AC-N*; AC-X5 forbids `move_task_to_day` |

## OPEN QUESTIONS — the brief's design is ambiguous or wrong here (settle before coding)

Each item: Observation (what the code says, with location) → why it matters → recommendation.
Items marked **BLOCKING** change what gets built; the rest have a safe default noted.

**OQ-1 (BLOCKING) — a NULL-rank star is scheduled LAST among stars, so "Journey puts it on your
calendar" is not guaranteed.**
Observation: nightly-schedule-builder sorts non-assignment candidates `is_priority` desc, then
`priority_rank ?? 9999` asc, then score (`nightly-schedule-builder/index.ts:1117-1125`). The brief
stars with `set_priority_rank {task_id}` and no rank, which stores NULL (`execute-tool/index.ts:2827`;
the tool schema's "Omit to add at end" is literally true: end of the queue). Live: 33 ranked stars exist.
Consequence: pushed task is placed only after every ranked star that wants the same category window
has been placed; on a full week it gets nothing, and the owner sees a star with no calendar block.
Options: (a) NULL rank (phone parity, last in line); (b) rank 1 (collides with the many existing rank-1s
— ranks are already duplicated per the live baseline); (c) rank 0 (journey web's 0..N-1 convention;
sorts ahead of every groom rank 1..20; but the groom bootstrap fingerprint in OQ-5 must then treat rank
0 as "not groom"). Recommendation: (c) rank 0 — "I pushed it" should outrank "the groom suggested it".
Whatever is chosen, AC-N2 measures it live.

**OQ-2 (BLOCKING) — "category X's tasks" has four different definitions in the code today.**
Observation: (a) tree WITH journey topics: membership is the TOPIC's `category_affinity`/first
`window_affinity`, and tasks linked to no topic are hidden (`buildPrioritiesTree`, widgets.server.ts:1246-1256);
(b) tree WITHOUT topics (journey down or `fetchTopicPayload` 4s timeout): `displayCategory(task.category)`,
which folds PERSONAL→LIFE and PROF_EDUCATION→EDUCATION (:598, :888); (c) journey's nightly placement keys
windows on the task's RAW `category` (`getPreferredWindows(task.category, …)`, nightly-schedule-builder:757);
(d) `getTasksForUser(email, category)` filters `upper(category) = X` raw, with no display folding
(tasks.server.ts:527-530).
Consequence: if the pick follows the tree (the brief's "reachable via topic mappings"), the SAME push
picks a different task depending on whether journey's topic call answered within 4s, and a task filed
under a CAREER topic whose own `category` is VENTURES is scheduled in VENTURES hours — violating "inside
that category's hours".
Recommendation: eligibility = mirror-only `displayCategory(task.category) === X` (deterministic, no journey
round-trip, agrees with the hours journey will actually use up to the PERSONAL/PROF_EDUCATION fold).
Owner to confirm the fold is acceptable (a LIFE push may pick a PERSONAL task and schedule it in PERSONAL's windows).

**OQ-3 — "top eligible task in the tree's order" is mostly alphabetical.**
Observation: among UNSTARRED tasks (the only candidates) `byPriorityThenDue` reduces to due date, then
title `localeCompare`, then id (widgets.server.ts:347-371). With topics present, tree order is also
topic-first (`sortNodes`), so the "top" is the first task of the first topic, not the best task in the category.
The repo already has the "system chooses" engine: `rankTasks` (scoring.ts:143), which mirrors journey's
own score and tiebreak and already applies every exclusion this feature needs.
Recommendation: pick = `rankTasks(eligible)[0]` (extend, don't duplicate). If the owner wants "what I see
at the top of the tree" instead, that is a deliberate choice and AC-C3 flips to the tree comparator.

**OQ-4 — a reopened task with an old `completed_at` can be picked but will NEVER reach the calendar.**
Observation: `isOpen`/`isTreeLive` ignore `completed_at` on purpose (6 such live tasks measured,
widgets.server.ts:287-293); journey's nightly candidates require `completed_at IS NULL`
(nightly-schedule-builder:976, :997). `rankTasks` excludes them (scoring.ts:147).
Recommendation: exclude from the pick (AC-C4). The star alone would be a promise journey cannot keep.

**OQ-5 (BLOCKING, needs owner sign-off) — groom bootstrap and the definition of "groom-starred".**
Observation: today nothing records who starred a task. `laneFieldFor` gives `rank` BEFORE checking
`userPinned` (groom.ts:103-105), so the groom also re-ranks tasks a user already starred. Live baseline:
33 stars, all with non-null rank, 0 NULL-rank (phone) stars, 0 rank-0, `week_order` empty.
Definition required: a task is groom-starred iff the groom wrote `rank` to it while the mirror showed
it NOT starred at the groom's read. A groom re-ranking an already-starred task must NOT add it to the record.
Bootstrap options: (a) empty record → groom never un-stars any of the 33 → lane permanently ≥33 incl. the
7 rank>20 leftovers; (b) one-time seed = {starred, rank NOT NULL, not in week_order, not pushed} at the
first post-deploy groom → that groom un-stars every seeded star it does not re-rank into the top 20 (up
to ~13 tasks disappear from This Week on the phone in one pass).
Recommendation: (b), executed exactly once (persisted "seeded" marker), and the PR reports the exact ids
it would un-star BEFORE the first live groom. Risk to accept: a journey-web reorder (writes ranks 0..N-1)
between measurement and deploy would make web-placed stars look groom-made.

**OQ-6 — the groom only touches ids inside its own slice, so "un-star what it starred" is incomplete as specified.**
Observation: the unset only reaches `assignments` from `slice` = first ≤80 rows of an UNORDERED
`LIMIT 500` read, minus parked and reminder-window tasks, minus BLOCKED (`getTasksForUser` excludes
DONE/BLOCKED) (groom.ts:168-175, 304-310; grooming.server.ts:142-147; tasks.server.ts:531). That is why the 7
rank>20 leftovers survive. The scheduled groom also SKIPS entirely when the backlog signature is unchanged
(grooming.server.ts:127-132), and the signature ignores stars.
Recommendation: on each groom write, also `unset_rank` every recorded groom-starred id that is open, not
parked, not in a reminder window, not in this pass's top-20, even if outside the slice. Owner to decide
whether a groom-starred task that is now BLOCKED is un-starred (band shows BLOCKED rows — `isOpen` keeps them).

**OQ-7 — `tasks.week_order` is the wrong vehicle for protecting a push.**
Observation: (i) `reorderWidgetBand` is called with the WHOLE visible band on any single ▲/▼ tap
(JourneyWidgets.tsx:867-876) and replaces the list wholesale (tasks.server.ts:726-737) — so one tap pins
all ~33 stars, and under today's shield makes every groom star permanent; (ii) a client whose band
predates the push writes a list without the pushed id and silently removes it; (iii) `applyWeekOrder` puts
pinned ids FIRST (widgets.server.ts:431-443), so appending a pushed id to an empty `week_order` moves it
to #1 in the band, above the groom's rank 1.
Recommendation: protection comes from the groom-starred record (a pushed task is never in it), not from
`week_order`. Whether a push should ALSO jump to the top of the band is an ordering choice for the owner;
default: do not touch `week_order` on push. Keep the existing `userPinned` shield as-is (regression AC-X2).

**OQ-8 (BLOCKING) — what ends a category's "active" pushed task?**
Observation: DONE can come from the Huddle ✓, the phone, journey web, AND journey's own 1am auto-archive:
STEP 1.6 sets EDUCATION/PROF_EDUCATION non-assignment tasks due >30 days ago to DONE and does NOT skip
starred tasks (nightly-schedule-builder:611-640; contrast STEP 1.5 which does, :582). The mirror does not
carry `scheduling_context`, so Huddle cannot tell user-done from auto-archived. Other exits: DELETE
webhook, ⏸ park (BACKLOG + parking-lot), BLOCKED, un-starred by the user on any surface, category changed,
and DONE then reopened (journey leaves `is_priority=true` on a DONE task, so reopen re-surfaces it as a star
→ two stars in X).
Recommendation (defaults the ACs use, owner to confirm): DONE (any source) or DELETE → refill; un-starred
by the user → treat as un-push of X (no refill); park / BLOCKED / category change → refill (the task is no
longer doable-in-X); reopen of a former active → stays starred, no un-star of the refilled one (2 stars, no
data loss). Each is an AC below so whichever is chosen is pinned.

**OQ-9 — pushing a category that already has an open pushed star.**
Recommendation: idempotent no-op that reports the existing active task (double-tap safety, AC-C6). A
second task from X is a task-push. If the category's top pick is ALREADY starred (by a task-push, phone or
groom), the category push adopts nothing and picks the next unstarred task (AC-C7) — owner to confirm
vs "adopt the existing star as X's active".

**OQ-10 — empty category (Family today; any category after its last task is done).**
Recommendation: X stays pushed ("armed"); the UI says so; the next eligible task to appear in X (INSERT
webhook, or reconcile tick) is starred. Alternative: auto-unpush. Owner to choose (AC-R5 pins the default).

**OQ-11 — un-push.**
Recommendation: un-pushing X clears the pushed state and un-stars the ACTIVE pushed task only if Huddle
starred it via that category push and it is still open (AC-U1). Un-starring a task-push un-stars it (AC-U2).

**OQ-12 — topic-level push** (the tree is Category → Topic → Task). Not in the owner's words; out of
scope unless stated. AC-V8 asserts topic rows get no push control, so scope creep is visible.

**OQ-13 — harness tasks WILL land on the owner's real calendar.**
Observation: the nightly builder excludes only titles `ILIKE '%Test Task%'` (nightly-schedule-builder:975,
995). A `Test-foo` task that a harness stars is a real 1am candidate.
Recommendation: harness titles start `Test-Task ` (satisfies both the repo's `Test-` rule and journey's
filter), and every harness un-stars + deletes its tasks in the same run (AC-H1/H2).

**OQ-14 — `set_priority_rank` has NO per-user filter in journey.**
Observation: `.update(update).eq('id', args.task_id)` with a service-role client (execute-tool/index.ts:2828,
:2862); contrast `batch_update_tasks` which adds `.eq('user_id', userId)` (:991). Huddle's ownership gate is
the only barrier against starring another user's task by id. Not ambiguous — it makes AC-O1..O3 mandatory.

**OQ-15 — the phone cannot show "category pushed".** It shows only the star (`is_priority`). The pushed-category
state is Huddle-only. Accepted by the owner's "No journey changes"; stated so nobody files it as a bug.

## Acceptance criteria

Test mode legend: **U** = unit, offline, `bun scripts/*.test.ts`, pure functions imported (never a restated copy
— the priority-lane test history shows a restated rule is INERT under mutation). **H** = harness against the
deployed app (server fn / webhook POST / `azure-pg-query.yml` / Supabase MCP SQL on journey `wwxgajrtmslzklnyplah`).
**L** = live-only (owner's phone, real calendar, the real 1am run). Defaults from the OPEN QUESTIONS are used
where a decision is pending; the AC id is cited in the OQ so it can be flipped.

### T — Push a TASK ("I choose")

| # | Given / When / Then | Cat | Mode | Observed via |
|---|---|---|---|---|
| AC-T1 | Given an owned, open, unstarred task T, when the user pushes T, then exactly ONE journey write is issued — `set_priority_rank {task_id:T, rank:<per OQ-1>}` — and journey's row reads `is_priority=true`, `priority_rank=<chosen>` | happy | U (spy on `invokeJourneyTool`) + H | spy call log; `select is_priority, priority_rank from public.tasks where id=T` |
| AC-T2 | Given AC-T1 succeeded, within 10s the mirror row for T reads `is_priority=true` and T appears in `composePrioritiesWidget(email).band` | happy | H | `azure-pg-query` on `tasks.journey_tasks`; server-fn read of `getPrioritiesWidget` |
| AC-T3 | Given T is already starred (any source, any rank), when the user pushes T, then NO journey write is issued, the result is `ok:true, applied:false` (or equivalent "already in This Week"), and T's existing `priority_rank` is unchanged (a phone NULL star is not overwritten, a groom rank 7 is not reset) | edge/idempotency | U + H | spy shows 0 calls; journey row rank before == after |
| AC-T4 | Given a double tap (two concurrent push calls for T), then journey ends with exactly one star, the UI shows one row for T in the band, and no error toast is shown for the second tap | idempotency | U (client `busy` guard) + H | band contains T once; journey row unchanged after 2nd call |
| AC-T5 | Given T is DONE, parked (`parking-lot`), BLOCKED, or has `completed_at` set, when pushed, then the call returns `ok:false` with a reason naming the state, and NO journey write is issued | error | U | spy 0 calls; returned `error` text |
| AC-T6 | Push does NOT call `move_task_to_day`, `unschedule_task`, `update_task`, or `batch_update_tasks` (no status, tags, schedule or category changes) | regression | U | spy call log contains only `set_priority_rank` |
| AC-T7 | Given journey returns `ok:false` (e.g. proxy 5xx), then the user sees an error toast, the optimistic star is rolled back, and no Huddle-side record (week_order / pushed state) claims the task was pushed | error | U (client) + U (server: no record written on failure) | toast text; store row; DB row absent |
| AC-T8 | A task pushed by AC-T1 is NOT in the groom-starred record (so no later groom can un-star it) | happy | U | record read after push excludes T |

### C — Push a CATEGORY ("you choose")

| # | Given / When / Then | Cat | Mode | Observed via |
|---|---|---|---|---|
| AC-C1 | Given category X with ≥1 eligible task, when the user pushes X, then (a) a per-user record "X is pushed, active=T" is persisted Huddle-side, (b) exactly one task T is starred via `set_priority_rank`, (c) the response names T's id and title | happy | U + H | DB row for user shows X + T; journey row for T starred; response body |
| AC-C2 | ELIGIBLE means all of: owned by the caller; `displayCategory(task.category)===X` (per OQ-2 default); status not DONE/BLOCKED; `completed_at IS NULL`; not tagged `parking-lot` (exact lowercase, same predicate as `isParked`); not in a reminder window; NOT already starred | edge | U (pure picker over fixtures) | picker returns no ineligible id across a fixture containing one of each excluded kind |
| AC-C3 | The pick is `rankTasks(eligible)[0]` (OQ-3 default) — given fixtures where tree order (alphabetical) and score order disagree, the score-order winner is starred | happy | U | picker output id == expected score winner; mutate the picker to use `byPriorityThenDue` → test FAILS |
| AC-C4 | Given X's best-scoring task has a stale `completed_at` (reopened), then it is skipped and the next eligible task is picked | edge | U | fixture with reopened task first by score; picker returns the second |
| AC-C5 | Given the journey topic call times out or errors, when X is pushed twice (once with topics, once without), then the SAME task is picked both times (pick does not depend on `fetchTopicPayload`) | edge | U | picker called with/without topic payload → same id; spy shows no `get_task_topics` call on the push path |
| AC-C6 | Given X is already pushed and its active task is open and starred, when X is pushed again (incl. double tap), then no new star is written and the response returns the existing active task (OQ-9 default) | idempotency | U + H | spy 0 `set_priority_rank`; journey star count for X unchanged |
| AC-C7 | Given X's highest-ranked eligible-by-category task is already starred (task-push, phone, or groom), when X is pushed, then that task is NOT re-written and the NEXT unstarred eligible task is starred (OQ-9 default) | edge | U | picker skips starred; journey rank of the starred task unchanged |
| AC-C8 | Given X has zero eligible tasks (e.g. FAMILY today; or only parked/BLOCKED/done tasks), when pushed, then no journey write, X is persisted as pushed with active=none, and the response says "nothing to pick in X yet" (OQ-10 default) | edge | U + H | spy 0 calls; DB row active null; response text |
| AC-C9 | A task linked to two topics (e.g. "Prepare an inspections records database") is a candidate at most once and, if picked, starred once | edge | U | picker output has unique ids; one `set_priority_rank` call |
| AC-C10 | Given duplicate-title tasks in X (e.g. two "Prepare my office camera quality"), the pick is deterministic across repeated calls with the same mirror state (stable tiebreak to id) | edge | U | 50 repeated picks over shuffled input → one id |
| AC-C11 | Given category aliases, pushing LIFE can pick a task whose raw category is PERSONAL, and pushing EDUCATION can pick PROF_EDUCATION (OQ-2 fold) — and pushing a dynamic/unknown category key (e.g. `SIDE_HUSTLE`) works the same way; the Uncategorised bucket has NO push control | edge | U | picker fixtures; widget render test for the Uncategorised row |
| AC-C12 | The pushed-category record survives a page reload, a container restart, and a client workspace sync (it is not stored in `identity.workspace_state` or browser storage) | regression | H | push, reload, read widget → X still shown pushed |

### R — Refill ("stars the next one as soon as you finish")

| # | Given / When / Then | Cat | Mode | Observed via |
|---|---|---|---|---|
| AC-R1 | Given X pushed with active T, when a webhook `UPDATE` arrives for T with `status=DONE`, then within the same webhook handling (or ≤60s after it) the next eligible task U in X is starred and the record reads active=U | happy | U (handler with injected deps) + H (POST `/api/public/tasks-sync` with the real secret, or mark a `Test-Task` done in journey) | journey row U starred; DB record active=U; time delta from journey `updated_at` |
| AC-R2 | AC-R1 holds regardless of which surface set DONE: Huddle ✓ (`updateWidgetTask done`), phone, journey web, or a journey agent tool — the trigger is the mirrored row, not the Huddle button | happy | H (journey SQL `update public.tasks set status='DONE'` on a Test-Task, no Huddle call) + L (phone tick) | same as AC-R1 |
| AC-R3 | Re-delivery: the same DONE payload for T delivered 2×, 3×, or after the refill already happened, stars nothing new (T is no longer the active id) | idempotency | U + H | journey star count in X after N deliveries == after 1 |
| AC-R4 | Echo safety: Huddle's own star write on U triggers an `UPDATE` webhook for U; that webhook causes NO further star writes (no refill loop) | idempotency | U | spy: exactly one `set_priority_rank` per DONE event across the echo |
| AC-R5 | Given X's last eligible task is done, then nothing is starred, X stays pushed with active=none (OQ-10 default), and when a new eligible task in X later arrives (INSERT webhook) or becomes eligible (unparked/unblocked), it is starred within one reconcile cycle | edge | U + H | DB record; journey star after INSERT of a Test-Task in X |
| AC-R6 | LOST WEBHOOK: given T is DONE in journey but the mirror still shows T open (the DONE webhook was never delivered — pg_net is fire-and-forget and never retried), then the next autowork-tick reconcile (9/13/17 ET) refills X. Because the MIRROR is exactly what is stale in this case, the reconcile MUST read each active pushed task's status from JOURNEY (one read via `invokeJourneyTool`, per active id) — a mirror-only reconcile cannot detect this case and FAILS this AC by construction | error | U (reconcile with a stale mirror stub and a journey stub saying DONE → refills) + H (set a `Test-Task` DONE in journey while the mirror row is forced stale, fire `/api/public/run-autowork`) | journey star on the next task; reconcile log line naming the stale id |
| AC-R7 | The reconcile runs even when `runScheduledAutoWork` takes an early exit (`missing_caller_email` aside): empty assigned set (autowork.server.ts:540-542), unchanged signature, or no assignee on any task — refill must not depend on tasks being assigned to an agent | regression | U | reconcile invoked in each early-exit fixture |
| AC-R8 | CONCURRENCY: when the webhook refill and the tick reconcile process the same DONE for X at the same time (and when two webhook deliveries race), exactly ONE new task is starred — enforced by a compare-and-set on the record's active id (e.g. `UPDATE … SET active=$new WHERE active=$old`), not by reading the mirror's star (which lags 1-3s) | concurrency | U (two interleaved calls against a real or faithful CAS) + H (fire two POSTs in parallel) | journey star count in X == previous + 1; loser logs "already refilled" |
| AC-R9 | Refill is scoped to the DONE task's owner: given two users each pushing "CAREER", a DONE for user A's active task never stars a task of user B, and the journey call is made with user A's identity (the webhook has no Entra caller — owner resolved from the row's `user_email` through `resolveScopeByEmail`) | security | U + H | journey row of B's tasks unchanged; spy caller email == A |
| AC-R10 | DELETE webhook for active T → refill (OQ-8 default) | edge | U | handler fixture |
| AC-R11 | Active T parked (⏸ = BACKLOG + `parking-lot`), set BLOCKED, or its category changed out of X → refill with the next eligible task; T's own star is left as journey has it (no un-star write) (OQ-8 default) | edge | U | handler fixtures; spy shows no `unset` for T |
| AC-R12 | Active T un-starred by the user on any surface (mirror shows `is_priority` true→false while T open) → X becomes un-pushed and NOTHING is starred (OQ-8 default) | edge | U + H | DB record cleared; spy 0 star writes |
| AC-R13 | journey auto-archive (STEP 1.6 sets an EDUCATION active task DONE at 1am) → behaves exactly as AC-R1 (refill); the PR states this explicitly so the owner is not surprised by a replaced star on Tuesday morning | edge | U + L | handler fixture; first 1am run after an Education push |
| AC-R14 | A DONE active task later REOPENED (status back to BACKLOG/UP_NEXT, journey still `is_priority=true`) does not un-star the refilled task and does not become active again; X shows 2 stars, neither lost (OQ-8 default) | edge | U | handler fixture |
| AC-R15 | A refill or reconcile failure (journey 5xx, timeout) NEVER makes `/api/public/tasks-sync` return non-2xx for a mirror upsert that succeeded, and never prevents the mirror upsert — the mirror write happens first and refill errors are caught + logged; the next tick retries | error/regression | U | handler with throwing refill → response 200 `ok:true`; mirror row updated |
| AC-R16 | Webhook latency budget: with refill enabled, the p95 handler time for a non-DONE UPDATE (the overwhelmingly common case) rises by < 50ms (one indexed read of the user's pushed record at most) | performance | H | timed 20 POSTs before/after |

### U — Un-push / un-star

| # | Given / When / Then | Cat | Mode | Observed via |
|---|---|---|---|---|
| AC-U1 | Given X pushed with open active T that THIS category push starred, when the user un-pushes X, then the record is cleared and T is un-starred via `set_priority_rank {task_id:T, unset:true}`; if T was already starred before the push adopted nothing (AC-C7) no un-star is written for any pre-existing star (OQ-11 default) | happy | U + H | DB record gone; journey T `is_priority=false`; other X stars unchanged |
| AC-U2 | Given a task-pushed T, when the user un-stars it in Huddle, then journey T reads `is_priority=false, priority_rank=NULL` and T leaves the band within 10s | happy | H | journey row; widget read |
| AC-U3 | Un-push of a category that is not pushed is a no-op returning ok, with no journey write | idempotency | U | spy 0 calls |
| AC-U4 | After un-push, a later DONE of the former active T stars nothing (no refill for an un-pushed category) | regression | U | handler fixture |

### G — Groom only un-stars what the groom starred

| # | Given / When / Then | Cat | Mode | Observed via |
|---|---|---|---|---|
| AC-G1 | Given a phone star (`is_priority=true, priority_rank=NULL`) on an open, groomable task OUTSIDE the groom's top 20 and NOT in `week_order`, when the groom runs, then that task's update carries neither `rank` nor `unset_rank` and journey still shows it starred | happy | U (pure lane function) + H | `laneFieldFor`-successor output `{}`; journey row after a forced groom on a Test-Task |
| AC-G2 | Same as AC-G1 for a journey-web star (rank 0..N-1) and for a Huddle task-push / category-push star | happy | U | pure function fixtures |
| AC-G3 | Given task G that the groom starred on pass N (it was unstarred at pass N's read and received `rank`), when pass N+1 does not rank G in its top 20, then pass N+1 sends `unset_rank` for G and G leaves the record | happy | U + H | update payload; record before/after |
| AC-G4 | Given a task the user had ALREADY starred that the groom re-ranks into the top 20 on pass N, when pass N+1 drops it from the top 20, then it is NOT un-starred (groom re-ranking a user star never converts it to groom-owned) | edge | U | record after pass N excludes it; pass N+1 payload `{}` |
| AC-G5 | Given groom-starred G that the user un-stars and later re-stars on the phone (mirror sees `is_priority` true→false→true), then G is no longer in the record after the false transition, and the next groom leaves it starred | edge | U (webhook handler + record) | record transitions; groom payload `{}` |
| AC-G6 | Given a FULL groom (no `category` argument) and groom-starred G that falls OUTSIDE the groom's 80-task slice (unordered `LIMIT 500` read), when the groom runs and G is open, not parked, not in a reminder window and not in this pass's top 20, then G is still un-starred (OQ-6 default) | edge | U | payload includes `{task_id:G, unset_rank:true}` though G ∉ slice |
| AC-G7 | A groom-starred task that is now parked or in a reminder window is NOT written by the groom at all (the existing "groom never touches parked tasks" rule, groom.ts:157-170, holds — a tags write would strip `parking-lot`) | regression | U | payload has no entry for it |
| AC-G8 | BOOTSTRAP (OQ-5 default): on the first groom after deploy, when no record exists, the record is seeded ONCE from {`is_priority` AND `priority_rank IS NOT NULL` AND id ∉ `week_order` AND id ∉ any pushed record}; a persisted marker prevents a second seeding; on the owner's live baseline this seeds exactly the 33 current stars and the groom then un-stars every seeded id it does not rank into its top 20 — i.e. exactly 33 − |seeded ∩ new top-20| un-stars, which the dry-run must list by title | edge | U (seed fn over the baseline shape: 70 unstarred, 26 rank 1-20, 7 rank>20) + H (dry-run report of ids BEFORE the live groom) | seed set size; second groom does not re-seed; dry-run list delivered to owner |
| AC-G9 | Bootstrap MUST NOT mass-unstar user stars: a NULL-rank star and any id in `week_order` are never seeded, even on the first pass | edge | U | seed excludes fixtures of each kind |
| AC-G10 | Bootstrap MUST NOT leave the lane permanently inflated: after the first two post-deploy grooms on the baseline shape, the count of stars NOT attributable to a user surface (task-push, category-push, phone NULL-rank, week_order) is ≤ `PRIORITY_LANE_MAX` (20) | edge | U (two simulated passes) + H (`select count(*) … is_priority` after the first live groom) | star count by origin |
| AC-G11 | The groom's existing behaviour is otherwise unchanged: cap = `PRIORITY_LANE_MAX`, dense 1..N ranks, assignments/tags/priority writes, CONTROL_TAGS preservation, post-groom `promoteOnly` autowork chain | regression | U | `bun scripts/priority-lane.test.ts` green + new cases |
| AC-G12 | A groom write failure (batch call timed out, `written===0`) does NOT update the groom-starred record (the record reflects journey's actual state, not the plan) | error | U | record unchanged when `invokeJourneyTool` rejects |
| AC-G13 | Category-scoped grooms (`groom_backlog {category}`) only add/remove record entries for tasks in that category's slice; they never un-star groom-starred tasks of other categories because those were absent from this pass's top 20 | edge | U | category-pass payload excludes other-category record ids |

### O — Ownership and cross-user safety (journey's `set_priority_rank` has no user filter — OQ-14)

| # | Given / When / Then | Cat | Mode | Observed via |
|---|---|---|---|---|
| AC-O1 | Given a task id owned by another user (or nonexistent), when user A pushes it, then the call returns `ok:false, error:"Task not found."` (same text for both, as `updateWidgetTask` does) and NO journey call is made | security | U + H | spy 0 calls; response text identical for foreign vs missing |
| AC-O2 | Every star/un-star write in this feature (task push, category push, refill, reconcile, un-push) is preceded by an ownership check of THAT task id against the acting user's alias set (`getOwnedTaskForConfirmAsk` or equivalent) — including server-side paths with no Entra caller | security | U (grep-able single helper + a test per path) | spy order: ownership read before each `set_priority_rank` |
| AC-O3 | A category push never picks a task outside the caller's alias set even if the category matches (fixture: two users' tasks in CAREER) | security | U | picker output ⊆ caller's tasks |
| AC-O4 | Unsigned-in calls return `ok:false, "Sign-in required."` with no DB or journey access | security | U | response; spies 0 |
| AC-O5 | The pushed-category record and groom-starred record are keyed so that a user with an alias email (the `resolveScopeByEmail` alias set) sees ONE pushed state, not one per alias | edge | U + H | push via alias A, read via alias B → same state |

### V — What the user SEES

| # | Given / When / Then | Cat | Mode | Observed via |
|---|---|---|---|---|
| AC-V1 | Each unstarred task row in the priorities TREE (`TopicTaskRow`) has a push control with an accessible name `Push "<title>" to This Week`, ≥44px touch target; a starred row shows the filled star and offers un-star instead (the "star is shown, not editable" comment at JourneyWidgets.tsx:771-774 is superseded and updated) | happy | U (render test) + H (Playwright `verify-uat.yml` screenshot) | DOM query by aria-label; screenshot |
| AC-V2 | Each CATEGORY row (depth 0, including empty FAMILY) has a push control; pushing shows optimistic "pushed" state immediately and, within 10s of server success, the band contains the picked task with its star and the category row shows "pushed" plus the active task's title | happy | H | Playwright screenshot sequence; band DOM |
| AC-V3 | Pushing an empty category shows visible text "Nothing to pick in <Category> yet — I'll star the next task that lands" (or the owner's wording), not a silent no-op | edge | U + H | rendered text |
| AC-V4 | A failed push (journey error, ownership fail) shows a toast with the server's error text and restores the pre-tap UI (no lingering star, no "pushed" badge) | error | U | toast; store state rolled back |
| AC-V5 | After the user ticks ✓ on the active pushed task in the band, within 10s of the refill the band shows the NEXT task with a star and the category row's active title changes — no manual refresh on a `live` widget | happy | H | Playwright: tick, poll band |
| AC-V6 | On the Android phone, the pushed task appears in This Week (star) after the phone widget's next refresh, and after ticking it done ON THE PHONE the next task appears there too | happy | L | owner screenshot / confirmation |
| AC-V7 | Frozen in-chat cards (non-`live`) either hide push controls or route them to the server pick (never send a client-computed candidate id from a stale snapshot) | edge | U | render test with `live=false` |
| AC-V8 | Topic (depth ≥1) rows and the Uncategorised row get NO push control (OQ-12) | regression | U | render test |
| AC-V9 | The band and the tree agree: every task whose tree row shows a star is in the band, and every non-parked band task shows a star in the tree (same mirror read, same `isPriority`) | reconciliation | U (compose over a fixture) | set equality |
| AC-V10 | Category-row counts are unchanged by pushing (pushing stars, never moves or hides tasks) | regression | U | counts before == after |

### N — Calendar placement by journey (no journey changes)

| # | Given / When / Then | Cat | Mode | Observed via |
|---|---|---|---|---|
| AC-N1 | No journey changes: no commit to the journey-voice repo is part of this feature, and every journey interaction uses tools that exist today (`set_priority_rank`, `batch_update_tasks`, plus a read tool for AC-R6) | regression | U (review) | journey-voice `git log` unchanged by this work; spy tool names ⊆ that list |
| AC-N2 | Given a pushed task P in category X with an estimate that fits, after the next 1am ET nightly run P has `is_scheduled=true` and a `start_time` within the next 7 days that falls inside one of X's configured windows (`categoryMappings[P.category].defaultTimeWindow`) — OR the run's audit/log shows P as a candidate with a stated reason it was not placed (`no_window_capacity`), which the PR reports to the owner with the OQ-1 rank decision | happy | L | journey `public.tasks` row for P the morning after; builder logs |
| AC-N3 | P's journey row before the 1am run has unchanged `start_time`, `end_time`, `is_scheduled` versus before the push (Huddle did not schedule it) | regression | H | journey row diff |
| AC-N4 | P is not excluded by the builder's own candidate filter: `completed_at IS NULL`, not parked, status ∉ {DONE, BLOCKED}, title not matching `%Test Task%` (ties to AC-C2/C4) | edge | U (picker fixture) | picker never returns a row the builder would drop |

### X — Regression guards

| # | Given / When / Then | Cat | Mode | Observed via |
|---|---|---|---|---|
| AC-X1 | `bun scripts/category-tree.test.ts`, `category-tree-independent.test.ts`, `widget-topic-tree.test.ts`, `week-order.test.ts`, `widget-park.test.ts`, `widget-live-refresh.test.ts`, `priority-lane.test.ts`, `priority-check.test.ts` all exit 0 unchanged (no existing assertion deleted or weakened; new cases may be added) | regression | U | exit codes; `git diff` of those files shows additions only |
| AC-X2 | `userPinned` (ids in `tasks.week_order`) is still left ENTIRELY alone by the groom (no `rank` removal, no `unset_rank`) — the existing priority-lane case "a user-pinned task outside the cap is left ENTIRELY alone" stays and passes | regression | U | that check line |
| AC-X3 | Band composition is unchanged for a user who never pushes: given today's fixtures, `buildPrioritiesBand` output is byte-identical before and after the change | regression | U | snapshot equality |
| AC-X4 | Existing widget actions (start/done/pause/reopen/today/untoday) and their journey tool mapping are unchanged (`ACTION_STATUS` frozen object identical) | regression | U | widget-park test + equality |
| AC-X5 | No code path added by this feature calls `move_task_to_day` (grep of the new/changed files returns only the pre-existing `today` action) | regression | U | grep in a test |
| AC-X6 | No new star representation: no Huddle-side `is_priority`-like column, tag, or lane; the star is read only from the mirror's `is_priority` | regression | U (review) + grep | schema diff |
| AC-X7 | Pushed-category and groom-starred state live in ONE per-user Huddle store that extends `tasks.week_order` (or a sibling table justified in the PR); the DDL is added to `BOOTSTRAP_SQL` idempotently (`IF NOT EXISTS`) and keyed with `user_id` + `user_email` like every other `tasks.*` table | regression | U + H | DDL text; bootstrap runs twice clean |
| AC-X8 | The mirror stays a single-writer read-model: refill/reconcile never INSERT/UPDATE `tasks.journey_tasks` directly; all star writes go to journey and arrive back via the webhook | regression | U (grep for writes to journey_tasks outside `upsertJourneyTask`/`deleteJourneyTask`) | grep |
| AC-X9 | `byPriorityThenDue` remains a total order (`|| a.id.localeCompare(b.id)` tail kept) | regression | U | existing tie test |
| AC-X10 | Every new guard (picker exclusions, CAS, ownership-before-write, groom-record membership, bootstrap-once marker) is mutation-proved with `scripts/mutate.sh` — each reported FIRED, none NOT-APPLIED | regression | U | mutate.sh output pasted in the verifier report |

### P — Performance

| # | Given / When / Then | Cat | Mode | Observed via |
|---|---|---|---|---|
| AC-P1 | Task push: server fn p95 < 3s end-to-end (one ownership read + one journey call), measured over 10 calls | perf | H | timed calls |
| AC-P2 | Category push: p95 < 4s and makes NO `get_task_topics` call (the pick is mirror-only, AC-C5) | perf | H | timed calls; spy |
| AC-P3 | Reconcile adds ≤ (number of the user's pushed categories) journey reads per tick — never one per task in the backlog | perf | U | spy count |
| AC-P4 | Groom wall time does not regress by more than 1s versus today on the same backlog size (one extra record read + one record write) | perf | H | `_timings` in groom JSON before/after |

### H — Harness hygiene (repo rule: test tasks are `Test-` prefixed and cleaned up)

| # | Given / When / Then | Cat | Mode | Observed via |
|---|---|---|---|---|
| AC-H1 | Every task a harness creates for this feature is titled `Test-Task <…>` (satisfies the repo's `Test-` rule AND journey's nightly `%Test Task%` exclusion — OQ-13) and lives in a category the harness pushes | hygiene | H | journey query for the run marker |
| AC-H2 | At the end of each harness run: its tasks are deleted from journey, its pushed-category records are cleared, its ids are removed from the groom record, and a final query shows 0 remaining for the run marker — all without asking (standing instruction 2026-08-11) | hygiene | H | final count query = 0 |
| AC-H3 | No harness pushes a REAL category of the owner's (LIFE/CAREER/…) against his live account in a way that stars a real task; harness category pushes use a dedicated dynamic test category (e.g. `TEST_PUSH`) or run against a test account | hygiene | H | journey diff of non-test tasks = ∅ |

### Goal → AC coverage

| owner goal (his words) | ACs |
|---|---|
| "push either a TASK ('I choose')" into This Week | AC-T1..T8, AC-V1, AC-U2 |
| "or a CATEGORY ('you choose', the system picks from it)" | AC-C1..C12, AC-V2, AC-V3 |
| "Huddle stars the top task" | AC-C1, AC-C3 (what "top" means — OQ-3), AC-C2, AC-C4 |
| "pins it so Monday's groom can't clear it" | AC-T8, AC-G1, AC-G2, AC-X2 (and OQ-7: protection is the record, not `week_order`) |
| "stars the next one as soon as you finish" | AC-R1..R16, AC-V5, AC-V6 |
| "Journey's 1am job puts it on your calendar inside that category's hours" | AC-N2 (live), AC-N3, AC-N4, AC-T6, AC-X5; at risk until OQ-1 and OQ-2 are decided |
| "No journey changes" | AC-N1 |
| "stop Monday's groom from clearing stars you set yourself on your phone or journey web — have the groom only un-star tasks it starred itself" | AC-G1..G13 (bootstrap: AC-G8..G10, OQ-5) |
| implicit: a write never touches another user's board | AC-O1..O5, AC-R9 |
| implicit: tests never pollute the real board/calendar | AC-H1..H3 |

ACs with no direct owner goal, kept and justified: AC-R15/R16/P1-P4 (the webhook is the mirror's only
writer — breaking it breaks every surface), AC-X1-X10 (regression on surfaces this feature touches).

Goals with NO AC: none. Goals whose AC cannot pass until a decision is made: calendar placement
(OQ-1 rank, OQ-2 category definition) and groom bootstrap (OQ-5).

### Tier note
This feature writes the star that drives journey's calendar and changes what the groom may un-star:
it decides a lane/gate on the owner's real data. Treat as Tier 1 (independent verifier immediately,
mutation-prove every new guard — AC-X10, live verification for AC-N2/AC-V6).
