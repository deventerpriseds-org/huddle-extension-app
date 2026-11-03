# DESIGN — thirteen new capabilities, each mapped onto what already exists (2026-11-03)

<!--
WHAT:       per-capability design: what existing structure each request can EXTEND, the smallest
            extension, and any change to existing behaviour (Today | Becomes | Why | Impact | Reversible).
WHY:        org rule "Extend, don't duplicate" — every one of these could be built as a parallel
            subsystem; this file finds the existing home first so the owner signs off only on what is
            genuinely new.
SUPERSEDES: nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:   file:line citations below. Huddle read at origin/main 32f50e4. journey read from the local
            checkout /home/user/journey-voice (branch claude/intelligent-hawking-qj88qu, fetched
            2026-11-03; this agent was worktree-isolated and could not run git there, so journey line
            numbers are from that checkout, not verified against journey origin/main).
-->

**Status: DESIGN ONLY. No code, no DB writes, no live calls were made.** Every "exists" claim below
was read from source this session. Live row counts are NOT re-measured here; where one is quoted it is
cited from `.claude/memory.md` / `.claude/actions.md`, not observed.

One source-of-truth caveat that recurs: journey's generated `src/integrations/supabase/types.ts` is
**stale** — it has no `tasks.tags` or `tasks.assigned_agent`, yet `execute-tool/index.ts:979-980` and
`:1041` write `tags`. Columns added through MCP `apply_migration` are not all in the repo's
`supabase/migrations/`. Any build must read the live schema (`information_schema.columns`) first.

---

## a) Recurring tasks and habits ("gym Mon/Wed/Fri at 3", "vitamins daily")

**(1) What exists**
- **journey has NO task recurrence or habit concept.** `public.tasks` columns
  (`journey-voice/src/integrations/supabase/types.ts:3609-3636`) carry no rule/series/parent-series
  field. The only "recurring" items in journey are unrelated: `user_scheduling_prefs.scheduled_calls`
  (recurring *voice calls*, `migrations/20260119151044_…sql:1-3`) and
  `external_calendar_events.is_recurring` (a read-only flag on synced calendar events,
  `migrations/20260328142355_…sql:1-2`; set in `functions/calendar-delta-sync/index.ts:310,540`).
- **Huddle already has a general recurring-job dispatcher**: `tasks.scheduled_jobs`
  (`src/features/huddle/lib/tasks/tasks.server.ts:245-257`: `job_type`, `target_email`, `cadence JSONB`,
  `enabled`, `next_run_at`, `meta JSONB`), fired by the existing every-minute run-turn heartbeat
  (`lib/tasks/scheduler.server.ts:1-7`: *"Adding a new recurring job type = one case in fireJob + a row —
  no new cron, no new secret. next_run_at is DST-correct"*).
- Its cadence shape already expresses "Mon/Wed/Fri at 3": `JobCadence { tz, hours[], daysOfWeek?[],
  everyMinutes? }` (`lib/identity/scheduling-config.server.ts:51-59`, `daysOfWeek` uses 0=Sun..6=Sat).
- `chat.reminders` (`lib/tasks/turns.server.ts:84-105`) is one-shot (`due_at`, status
  pending/fired/cancelled) — no recurrence.
- Routing already has a home lane: an agent with `domains: ["goals", "habits", …]`
  (`data/agents.ts:619`).

**(2) Smallest design — extend `scheduled_jobs`, do not add a recurrence table**
- New `job_type = "recurring-task"`, **many rows per user** (id `recur-<uuid>`), unlike the
  one-row-per-owner jobs in `JOB_ROWS` (`scheduler.server.ts:137-146`). `cadence` = the existing
  `JobCadence`; `meta` = `{ title, category, estimate_minutes, minute?, mode: "task"|"reminder" }`.
- `fireJob` case: create the occurrence through the EXISTING create path (journey `create_task` /
  `quick_create_task`, so the sync trigger mirrors it) with a `recurring:<jobId>` tag, so the board,
  grooming and auto-work see an ordinary task. `mode:"reminder"` instead writes a `chat.reminders` row
  (vitamins needs a nudge, not a board card).
- Two small gaps in `JobCadence`: (i) a `minute` for "3:30" (today fires at the top of the hour only);
  (ii) the per-owner `resolveJobCadence` live re-read (`scheduler.server.ts:149-155`) keys by job TYPE,
  so recurring rows must use their own stored cadence. Both are additive.
- Agent tools: `create_recurring` / `list_recurring` / `stop_recurring` (stop = `enabled=false`, never
  delete), plus a Settings list. Habit streaks fall out for free: count DONE occurrences carrying the
  `recurring:<jobId>` tag.
- **No journey change required.** journey stays the canonical task store; the RULE lives in Huddle.

**(3) Behaviour change:** none to existing behaviour. New rows only; groom/auto-work treat occurrences
as normal tasks. One thing for the owner to decide (not a change): whether auto-work should SKIP
`recurring:*` occurrences (assist-mode habits should not be "worked" by an agent). Default proposed:
skip, same mechanism as the `parking-lot` tag exclusion.

**(4) Size: M. Repo: huddle-extension-app only.** New structure: **none** (new job_type + meta shape on
an existing table).

---

## b) Undo the last agent action

**(1) What exists**
- journey `public.task_events` (`types.ts:3410-3418`: `task_id, event_type, old_values, new_values,
  user_id, created_at`) written by trigger `log_task_changes` on INSERT/UPDATE **and DELETE** with the
  full row as `to_jsonb(OLD)` / `to_jsonb(NEW)`
  (`migrations/20260821153000_task_events_capture_deletes.sql:13-50`); the cascade FK was dropped so
  history outlives a deleted task (`:9-10`). **So every task write is reconstructible.**
- An undo precedent already exists in journey: `undo_dedup` (`execute-tool/index.ts:380-381`,
  `:1843-1851` → `_shared/task-dedup.ts` `undoDedupSkips`), with the user-facing "reply undo" copy at
  `_shared/task-dedup.ts:359-360`. It undoes ONE specific action kind only.
- Huddle's per-turn action ledger `turnActionLedger` / `claimAction` (`lib/huddle.functions.ts:2179-2188`)
  knows which mutating actions a turn performed, but it is turn-scoped and not persisted beyond the
  chunk-resume `progress` blob.
- `chat.pending_turns.result` / `replies` (`turns.server.ts:36-58`) hold each turn's output, including
  `journeyTaskUpdates` (`huddle.functions.ts:909-910, 1675`) — the tasks an agent touched.

**(2) What `task_events` cannot do alone — the gap that decides the design**
- **It has no ACTOR column.** A row does not say whether the owner (board/journey UI), an agent, or the
  nightly planner made the write; `user_id` is always the task OWNER. "Undo the LAST AGENT action"
  therefore cannot be answered from `task_events` by itself.
- It covers `public.tasks` only. Agent actions outside it — `chat.reminders`, emails sent, artifacts,
  checklist items — are not in it (and a sent email cannot be undone at all).

**Smallest design**
- Huddle side: persist an **action receipt** for each agent mutation into the EXISTING
  `chat.pending_turns.result` (a `actions: [{tool, taskId?, reminderId?, at}]` array beside
  `journeyTaskUpdates`) — no new table. "Undo last" = newest turn for this user with a non-empty
  `actions`.
- Undo execution for task writes: look up the `task_events` row for that `task_id` at/after the receipt
  time and restore `old_values` through `update_task` (UPDATE), delete through the board-gated path
  (CREATE → needs (m)'s confirm), or re-insert from `old_values` (DELETE). Reminders: set
  `status='cancelled'`. Email/artifact: refuse with an explanation.
- Optional journey nicety (not required): an `actor` field in `task_events.new_values` via a
  `scheduling_context`-style marker, or a nullable `actor text` column, so the match is exact rather than
  time-windowed. That WOULD be a new column on a journey table — owner sign-off.
- Always behind a confirm ("undo: moved 'Call dentist' back to Backlog?") — reuse the
  `chat.deep_confirm` pending-row pattern (`lib/tasks/deep-confirm.server.ts:21-30`).

**(3) Behaviour change:** none to existing paths. If the journey `actor` column is chosen: every task
write gains one nullable field — additive. Undo of an agent-CREATED task requires a delete, which runs
into (m); see that row.

**(4) Size: M** (S for "undo last task update only"). **Repos: huddle (receipts + tool); journey only if
the `actor` column is approved.** New structure: none required; `actor` column optional.

---

## c) Subtasks / task hierarchy

**(1) What exists**
- **Feasibility is already done and must not be re-derived**: `.claude/actions.md:3600-3618`
  (ACT:task-hierarchy) and `docs/feasibility-epics-tasks-subtasks.md`. Summary as recorded there:
  ordering works (`priority_rank`, `types.ts:3627`); pointers exist as a correctly typed **dead** column
  `blocked_by uuid[]` (`types.ts:3613`; memory.md:3173 — 0 of 412 rows, never written, mirrored or
  read); hierarchy is absent and grooming ranks FLAT.
- **A second thing this pass found that the ACT row does not mention:** journey already has
  `public.task_checklist_items` (`types.ts:3319-3328`: `task_id, title, is_completed, position`), used by
  journey's own UI (`src/components/ChecklistManager.tsx`, `TaskDetailModal.tsx`, `TaskCard.tsx`). That
  is a one-level, non-schedulable "subtask" list that already exists — it is just not mirrored to Huddle
  nor exposed to agents.
- Huddle's `tasks.task_blockers` (`tasks.server.ts:132`) is a separate Huddle-side blocker record —
  related to `blocked_by`, and must be reconciled with it, not duplicated.

**(2) Smallest design — two tiers, choose by need**
- **Tier 1 (S): "steps inside a task"** — expose `task_checklist_items` to agents (read + add/tick via
  new journey execute-tool cases) and render on the Huddle board card. No schema change.
- **Tier 2 (M/L): real epics/tasks/subtasks** — ACT:task-hierarchy option A unchanged: nullable
  `parent_task_id` on journey `public.tasks`, mirror it plus `blocked_by` into `tasks.journey_tasks`,
  two-level grooming rank. **`parent_task_id` IS a new column — owner sign-off already sought in that
  ACT row.**

**(3) Behaviour change (tier 2 only)**

| Today | Becomes | Why | Impact on the owner | Reversible |
|---|---|---|---|---|
| Grooming writes one flat `priority_rank` across all open tasks | Grooming ranks children within their parent, parents among themselves | Flat ranking cannot keep "these five belong together" in order | Board order shifts for any task given a parent; 139 ranked rows (per actions.md) re-rank once | Column: yes (nullable, drop). Ranking shape: practically no — the old flat ranks are overwritten |
| `blocked_by` is never read | Auto-work skips a task whose blockers are not DONE | Pointers become meaningful | A blocked task stops being picked up for DOING | Yes — stop reading the column |

**(4) Size: tier 1 S (journey + huddle); tier 2 L (journey migration + huddle mirror, board, groom).**
New structure: tier 1 none; tier 2 `parent_task_id`.

---
