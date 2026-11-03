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

## d) Quick notes ("note: the eulogy should mention the lake house")

**(1) What exists**
- **Every user message is already saved.** `runHuddleTurn` writes the user's text as a `scope='global'`
  `rag_chunks` row (`lib/huddle.functions.ts:1072-1082`), and `rag_chunks` already has `metadata JSONB`
  and `source` columns (`lib/rag/azure-pg.server.ts:127-136`). So "note: …" is ALREADY stored and
  semantically recallable via auto-retrieval and `search_memory` (`lib/rag/tools.ts:9`). What is missing
  is (i) marking it AS a note, and (ii) listing notes back exactly ("show my eulogy notes").
- `artifacts.items` (`lib/artifacts/artifacts.server.ts:29-48`) holds documents with `folder`, `name`,
  `task_id` — the right home only once a note grows into a document.
- journey `session_notes` (`types.ts:3059-3068`) is class-session notes keyed to `session_id` — a
  different domain; not a fit.

**(2) Smallest design — extend `rag_chunks`, no new table**
- A `save_note` agent tool (or a deterministic `^note:` prefix check) that writes ONE extra chunk with
  `metadata = {kind:"note", topic:"eulogy"}` through the existing `writeChunk`, and a `list_notes(topic?)`
  tool that selects `WHERE metadata->>'kind'='note'` newest first. Reuses the write-time dedup key
  (`azure-pg.server.ts:150-172`) and the existing owner scoping.
- Optional: when a note mentions an existing task, set `metadata.task_id` so the board card can show it.

**(3) Behaviour change:** none. The user-message auto-write is unchanged; notes are additional rows.

**(4) Size: S. Repo: huddle.** New structure: none (a `metadata.kind` value).

---

## e) A shopping or errand list

**(1) What exists**
- **Huddle already has a user-scoped list store: `chat.user_ledger`**
  (`lib/rag/ledger-store.server.ts:29-35`: `user_email PK, ledger JSONB`), whose entries are
  `{type:"list", value:string[]}` mutated by `add/remove/set/clear` ops (`:53-90`, `applyLedgerOps`).
  Its header (`:1-7`) describes exactly this use: *"a LIST edited by deltas ('drop Cobalt, add Delta')"*.
  It is rendered into agent prompts (`huddle.functions.ts:2640-2645`).
- **But it is gated to `memoryMode === "researched"`** for both the write
  (`huddle.functions.ts:1371-1376`) and the read (inside the `if (data.memoryMode === "researched" …)`
  block opened at `:2620`), and the default mode is `"reconstruction"` (`huddle.functions.ts:1466`,
  `components/SettingsSheet.tsx:469`). Ops are LLM-extracted after the turn
  (`ledger-store.server.ts:182`), not a deterministic tool.
- `build_checklist` (`lib/tasks/tools.ts:58`, prompt `:94`) renders tick-boxes — but over BOARD TASKS,
  so it is the wrong backing for groceries (each "milk" would be a board card).
- journey `task_checklist_items` (see c) is per-task.

**(2) Smallest design — extend `chat.user_ledger` with an explicit tool**
- Add a deterministic `update_list({list:"shopping", add:[…], remove:[…]})` / `get_list(list)` tool that
  calls the EXISTING `applyLedgerOps` + upsert. Lists are keys in the same JSON doc. No new table.
- Render through `build_checklist`'s tick-box UI by giving it a `source:"ledger"` mode (ticking = a
  `remove` op), so the UI is reused, not rebuilt.
- Errands that need a TIME or a PLACE stay tasks or reminders; the list is for items.

**(3) Behaviour change** — only if the mode gate is lifted:

| Today | Becomes | Why | Impact on the owner | Reversible |
|---|---|---|---|---|
| The ledger is read into prompts and written only in "researched" memory mode | The ledger block is injected in EVERY mode | A shopping list that vanishes when memory mode is "reconstruction" is useless | Agents in default mode start seeing any facts/lists already in the ledger, including ones captured earlier in researched mode | Yes — restore the mode gate |

A narrower alternative that changes nothing: inject in every mode only the keys the new tool wrote
(e.g. a `list:` key prefix), leaving the LLM-extracted part researched-only. **Proposed as the default.**

**(4) Size: S. Repo: huddle.** New structure: none.

---

## f) Contacts / people lookup ("email my advisor")

**(1) What exists**
- **No contacts or people store or tool exists in Huddle or journey.** Grep for `/contacts`, `/people`,
  `Contacts.Read`, `People.Read` across Huddle `src/` returns nothing. The router's prose mentions
  "calendar/tasks/contacts" journey tools (`lib/routing.ts:517, 707`), but journey's `execute-tool`
  dispatch (`execute-tool/index.ts:333-463`) has no contacts case — that wording is aspirational.
- The app-only Graph client exists: `getAppToken()` (`lib/email/graph-email.server.ts:101`), already used
  for send/draft, inbox reads (`listInboxMessagesSince`, `:249`) and calendar (`getGraphCalendarEvents`,
  `:530`). The owner's own addresses live in `identity.profile_emails`
  (`lib/identity/identity.server.ts:33`).
- RAG memory can hold "my advisor is Dr. X" (triples via `lookup_facts`, `rag/tools.ts:26`).

**(2) Smallest design — one more Graph read on the existing client**
- `find_contact(query)` → `GET /users/{mailbox}/contacts?$filter=…` and/or
  `GET /users/{mailbox}/people?$search=…` with the same `getAppToken()`. Resolve ROLE words ("my
  advisor") through `lookup_facts` first, then the name through Graph. Returns name + email only; the
  existing `send_email` / `create_email_draft` path sends (with its existing claim-ledger guard).
- **Prerequisite (tenant-admin action, not code):** the Graph app needs an application permission —
  `Contacts.Read` for `/contacts`. Whether app-only `People.Read.All` is honoured for `/people` is
  **inference, unverified** — a one-call probe workflow should settle it before building (same as the
  inbox probe precedent in `lib/email/inbound-email.ts:5-7`). A 403 = "grant consent", exactly as with
  `Calendars.Read`.
- Fallback needing no new permission: harvest correspondents from the inbox read the app already has.

**(3) Behaviour change:** none.

**(4) Size: S (plus an admin consent). Repo: huddle.** New structure: none.

---

## g) Google calendar reads

**(1) What exists — and the route is shorter than mail-and-appointments**
- **journey already syncs Google calendars.** `calendar_connections` (`types.ts:785-804`: `provider`,
  `expires_at`, `refresh_token`, `is_active`, …) holds Google and Outlook connections;
  `functions/calendar-delta-sync/index.ts` refreshes Google tokens (`:73-79`) and upserts into
  `public.external_calendar_events` (`:246-381`; columns `types.ts:1747-1766` — `title, start_time,
  end_time, is_all_day, location, attendees, organizer_email, show_as, is_recurring, connection_id`).
- journey already READS that table inside `find_open_slots` (`execute-tool/index.ts:2854-2864`), but no
  execute-tool case returns the events themselves.
- Huddle's `get_calendar_events` is Graph-only (`graph-email.server.ts:530-560`), so a Google-only
  calendar never appears.
- `deventerpriseds-org/mail-and-appointments` (the "mail-watcher") is an M365 + Google middleware. Not
  cloned per instructions; `lib/email/inbound-email.ts:5-6` records it was checked for inbox reading and
  did not provide that path.

**(2) Smallest design — read journey's synced events, not a third provider client**
- journey: add a `get_calendar_events` case to `execute-tool` selecting `external_calendar_events` by
  `user_id` and date range (all providers), reusing `find_open_slots`' query shape.
- Huddle: in the existing `get_calendar_events` tool, merge the Graph result with that journey call via
  `invokeJourneyTool` (`lib/journey/proxy.functions.ts:116`), dedup on `external_event_id` or
  subject+start. The schedule brief (`lib/tasks/schedule-brief.server.ts:19-22`) inherits it for free.
- mail-and-appointments is the route only if journey's sync is NOT running for the owner's Google
  account — one read-only check of `calendar_connections` for an active `provider='google'` row decides it.

**(3) Behaviour change**

| Today | Becomes | Why | Impact on the owner | Reversible |
|---|---|---|---|---|
| `get_calendar_events` and the 8am/8pm schedule brief show Outlook/M365 events only | They also show Google events journey has synced | Google-only events are invisible today | Briefs get longer; an event on both calendars could appear twice if dedup misses | Yes — drop the merge |

**(4) Size: S–M. Repos: journey (one execute-tool case) + huddle (merge).** New structure: none.

---

## h) Exact recall of past chats by date or agent

**(1) What exists**
- `chat.pending_turns` (`lib/tasks/turns.server.ts:36-58`) holds every durable chat turn: `huddle_id`
  (`dm-<agentId>` = that agent's 1:1; `all-members`/`daily` = group), `payload` (user text at
  `payload->>'text'`), `replies` / `result` (agent replies), `created_at`, `user_id`; indexed on
  `(huddle_id, updated_at DESC)` and `user_id` (`:48, :67`).
- Voice ceremonies live in `chat.ceremony_transcript` instead (`lib/ceremony/ceremony-transcript.server.ts:30`).
- Existing recall is SEMANTIC only: `rag_chunks` stores the user text with `source=huddle:<id>`, plus a
  "<Agent> said: <gist>" chunk (`huddle.functions.ts:7138-7154`) — a gist, not the verbatim reply. So
  `search_memory` cannot answer "what exactly did Finn say last Tuesday".

**(2) Smallest design — a read tool over `pending_turns`**
- `recall_conversation({agent?, from, to, query?})` → select `payload->>'text'`, `replies`, `result`,
  `created_at` from `chat.pending_turns` where `user_id` matches, `huddle_id` in the agent's DM (and group
  huddles filtered to replies whose `agentId` matches), `created_at` in range, optional `ILIKE`. Union
  `ceremony_transcript` when the range covers a stand-up. Cap rows and truncate replies to fit a prompt.

**(3) Behaviour change:** none (read-only). A `(user_id, created_at)` index may be wanted; additive.

**(4) Size: S. Repo: huddle.** New structure: none.

---

## i) Reading attached PDF/Word files

**(1) What exists**
- Chat attachments shipped 2026-08-12 (`.claude/memory.md:2899-2911`): uploads go to the existing
  artifact blob store (`artifacts.items`, folder "Uploads") via `uploadChatAttachmentFn`; the mime
  allow-list already ACCEPTS pdf/docx/office (`lib/artifacts/attachments.functions.ts:19-23`).
- `resolveAttachmentContent` (`lib/huddle.functions.ts:1336-1364`): images → `input_image`; artifacts
  with stored `row.text` → inlined; **everything else (PDF, Word) → "contents aren't readable inline yet —
  acknowledge it and ask for the key details"** (`:1355-1356`). memory.md:2911 names the follow-on:
  "PDF/docx real parse (input_file)".

**(2) Smallest design — fill the existing `else` branch**
- PDF: add an `input_file` content part beside `input_image`, using the same fresh SAS URL. The exact
  `input_file` shape must be read from the OpenAI SDK before coding — not asserted here.
- DOCX: extract text once at upload and store it in the artifact's existing `text` field, so the existing
  inline-text branch handles it with no turn-time change.
- Lovable `generateText` path: flatten to extracted text, as images are flattened today.

**(3) Behaviour change**

| Today | Becomes | Why | Impact on the owner | Reversible |
|---|---|---|---|---|
| A PDF/Word attachment is acknowledged by name; the agent asks you for the key details | The agent reads the document | That is what attaching it is for | Longer, slower, costlier turns on big files (input tokens); answers now grounded in the file | Yes — restore the acknowledge branch |

**(4) Size: S–M. Repo: huddle.** New structure: none.

---

## j) Importing the owner's ChatGPT history into memory

**(1) What exists**
- The memory store is `rag_chunks` (`lib/rag/azure-pg.server.ts:127-136`: `scope, agent_id, text, source,
  embedding, metadata, created_at`, plus `author_agent_ids`) with a write-time dedup unique index
  (`:150-172`), written through `writeChunk`. Facts go to `rag_triples` (`:177`). Every live user message
  is already written the same way (`huddle.functions.ts:1072-1082`) with `source = huddle:<id>`.
- Uploads: the chat attachment path stores files in `artifacts.items` with an **8MB** cap
  (`.claude/memory.md:2902-2903`). A ChatGPT export (`conversations.json` inside a zip) is often larger.
- Ops precedent for heavy one-shot DB work: GitHub-Actions workflows with the org Azure SP
  (`bootstrap-memory-db.yml`, `migrate-huddle-db.yml`, `azure-pg-query.yml` — CLAUDE.md).

**(2) Smallest design — a one-shot importer that calls the existing writer**
- Input: the export zip, uploaded either through the existing attachment path (if under the cap) or
  committed nowhere and handed to a `workflow_dispatch` importer that reads it from blob storage.
- Process: parse `conversations.json`, keep USER messages (and optionally assistant summaries), chunk,
  embed with the same embedding model, `writeChunk({scope:"global", source:"import:chatgpt:<conversation_id>",
  metadata:{imported:true, original_at:<message time>, title}})`. Re-running is idempotent by the dedup key.
- Optional second pass: extract durable facts into `rag_triples` with the existing researched-mode
  extractor, marked `imported`.
- Must run off-box (workflow), not in a turn: thousands of embeddings exceed a 45s request.

**(3) Behaviour change**

| Today | Becomes | Why | Impact on the owner | Reversible |
|---|---|---|---|---|
| Auto-retrieval only ever surfaces things said inside Huddle | It can surface ChatGPT-era content in any reply | That is the point of importing | Agents may cite old/stale context from years of chats; noisier recall until relevance is tuned; one-off embedding cost | Yes — `DELETE FROM rag_chunks WHERE source LIKE 'import:chatgpt:%'` |

Privacy note for the owner, not a code change: the export may contain other people's details; it
lands in the same store as everything else.

**(4) Size: M. Repo: huddle (importer script + workflow).** New structure: none (a `source` prefix).

---

## k) Overcommit warning when planning ("this doesn't fit in your day")

**(1) What exists**
- journey's nightly planner already computes capacity: `WindowCapacity {totalMinutes, usedMinutes,
  remainingMinutes}` (`functions/nightly-schedule-builder/index.ts:110-123`, computed `:163+`, per-day
  `:876`) and records placements/deferrals (`:858`, `tierA … deferred`). It knows when work does not fit,
  but only logs it.
- `find_open_slots` (`execute-tool/index.ts:2854-2864`) reads calendar events per day — the free-time
  side of the sum.
- `tasks.estimate_minutes` (`types.ts:3609-3636`) is the demand side.
- CLAUDE.md backlog #4 already names this: *"a capacity guard that flags overcommitment instead of
  scheduling into nonexistent time"*, and the `after_work` window drift (17–22 vs 17–19,
  `execute-tool/index.ts:2735`).
- Huddle's priority check (`lib/tasks/priority-check.server.ts:1-8`, 6am/8pm) and schedule brief
  (`lib/tasks/schedule-brief.server.ts`) are the existing pushed moments where a warning would land.

**(2) Smallest design — compute once in journey, surface through existing Huddle messages**
- journey: a read-only `check_day_capacity(date)` execute-tool case = (window minutes from the user's
  scheduling windows) − (calendar busy minutes, as `find_open_slots` computes) − (sum of
  `estimate_minutes` of tasks scheduled that day). Returns `{free, demand, overBy, items}`.
- Huddle: call it (a) when an agent schedules or plans a day (`schedule_task` / `move_task_to_day`
  results) and (b) inside the 8pm schedule-brief / priority-check edition; add one sentence when
  `overBy > 0`. Never auto-moves anything.
- Missing `estimate_minutes` is the weak point: fall back to a per-category default and SAY it is assumed.

**(3) Behaviour change**

| Today | Becomes | Why | Impact on the owner | Reversible |
|---|---|---|---|---|
| The 8pm brief / planning replies list what is scheduled, with no capacity judgement | They add "this is ~Xh over what fits" when it is | The planner silently defers or overflows today | One extra line on over-full days; may be wrong where estimates are missing | Yes — drop the line |

**(4) Size: M. Repos: journey (read-only case) + huddle (surfacing).** New structure: none.

---

## l) Alert when a calendar or email connection expires

**(1) What exists — three different "connections", three expiries**
- **journey calendar OAuth (Google/Outlook):** `calendar_connections.expires_at / refresh_token /
  is_active` (`types.ts:785-804`). `calendar-delta-sync` tries a refresh and on failure only appends
  `'Token expired and refresh failed - needs re-authentication'` to its result
  (`calendar-delta-sync/index.ts:80-91`) and logs it (`:146`) — **nobody is told**.
- **Huddle Graph mail subscription:** `chat.graph_mail_subscriptions.expires_at`
  (`lib/email/mail-subscription.server.ts:39-48`) — renewed by Huddle's own code.
- **Huddle's app-only Graph client** (`getAppToken`, `graph-email.server.ts:101`) uses a client SECRET
  that itself expires in Azure AD; a 401/403 from Graph today surfaces as a per-call error
  (e.g. `needsConsent` on artifact mirroring — CLAUDE.md).
- Delivery: the existing away-notification (`send_push` via a durable DM turn), as the schedule brief
  and priority check do (`schedule-brief.server.ts:21-22`). Scheduling: `tasks.scheduled_jobs`.

**(2) Smallest design — one daily health job, existing delivery**
- New `job_type = "connection-health"` row in `tasks.scheduled_jobs` (one per owner, `JOB_ROWS` entry).
  It reads: journey `calendar_connections` health via a read-only execute-tool case
  (`is_active`, `expires_at`, last sync error); Huddle `graph_mail_subscriptions.expires_at`; one cheap
  Graph probe call. Any failure → one DM from the owning agent (Iris) with what broke and where to
  reconnect, deduped per connection per day.
- Better fidelity, optional, journey-side: have `calendar-delta-sync` persist its failure (e.g. into the
  existing `calendar_connections.metadata` JSON, not a new table) so the health job reads a fact rather
  than inferring from `expires_at`.

**(3) Behaviour change:** the job itself is additive. Writing the failure into `metadata` is a new key
on an existing JSON column — additive. **None to existing behaviour.**

**(4) Size: S–M. Repos: huddle (+ small journey read case; optional journey metadata write).**
New structure: none.

---

## m) Delete a task from chat, with a confirm step

**(1) What exists**
- journey `delete_task` (`execute-tool/index.ts:350-356`, body `:947-962`) — owner-scoped, comment says
  *"Not advertised to LLMs — agents never delete."*
- Huddle gate: `UI_ONLY_JOURNEY_TOOLS = new Set(["delete_task"])`
  (`lib/journey/proxy.functions.ts:114`), enforced in `invokeJourneyTool` (`:120`) — the single chokepoint
  for text agents, the voice executor and the debug fn (`:106-113`). Only the board's `deleteBoardTask`
  passes `allowUiOnly` (`lib/tasks/board.functions.ts:85-105`), behind the card's confirm.
- **Deletes are recoverable**: `task_events` keeps the full row on DELETE
  (`migrations/20260821153000_task_events_capture_deletes.sql:31-41`).
- Interactive chat payloads already exist: the in-chat checklist renders board-wired controls
  (`components/HuddleView.tsx:423-465`), so a chat message can carry a button whose click is a real user
  action.

**(2) Smallest design — keep the gate; let the agent PROPOSE, the user's click DELETES**
- Agent tool `propose_delete({task_id})` returns a `deleteProposal` payload; the chat renders a card
  ("Delete 'Call dentist'? This is permanent — [Delete] [Keep]"). The [Delete] click calls the EXISTING
  `deleteBoardTask` server fn. The model still can never invoke `delete_task`; `UI_ONLY_JOURNEY_TOOLS`
  is unchanged.
- Voice: the same proposal is spoken and rendered; deletion still needs the tap (no spoken "yes"
  executing it) unless the owner explicitly wants that, which WOULD loosen the gate.

**(3) Behaviour change**

| Today | Becomes | Why | Impact on the owner | Reversible |
|---|---|---|---|---|
| Agents never raise deletion; "delete X" in chat gets a pointer to the board (by design in #124) | Agents can offer an in-chat Delete card for a named task; the delete still happens only on your click | Deleting from chat saves a trip to the board | You may see delete offers when you ask; a mis-matched task title could be offered (the card shows the exact title, and `task_events` makes it restorable) | Yes — remove the tool; the gate never moved |
| (Only if chosen) a spoken/typed "yes" deletes | Confirmation by reply rather than click | Hands-free in voice | **Loosens #124's gate**: a model-interpreted "yes" executes a permanent delete | Code: yes. Each delete: only via `task_events` restore |

Recommended: row 1 only.

**(4) Size: S. Repo: huddle.** New structure: none.

---

## Summary

| Capability | Extends | New structure needed? | Changes existing behaviour? | Size |
|---|---|---|---|---|
| a) Recurring tasks / habits | Huddle `tasks.scheduled_jobs` + `JobCadence`; journey create path | No (new `job_type`) | No (decide: auto-work skips `recurring:*`) | M |
| b) Undo last agent action | journey `task_events` (old/new values incl. DELETE); `undo_dedup` precedent; `pending_turns.result` | No; optional journey `actor` column | No | M |
| c) Subtasks / hierarchy | journey `task_checklist_items` (tier 1); `priority_rank` + dead `blocked_by` (tier 2) | Tier 1 no; tier 2 `parent_task_id` (sign-off) | Tier 2 yes — grooming becomes two-level | S / L |
| d) Quick notes | `rag_chunks` (`metadata.kind='note'`) | No | No | S |
| e) Shopping / errand list | `chat.user_ledger` + `applyLedgerOps`; `build_checklist` UI | No | Only if the researched-mode gate is lifted (default proposal avoids it) | S |
| f) Contacts lookup | app-only Graph client; `lookup_facts` | No (needs `Contacts.Read` consent; `/people` app-only unverified) | No | S |
| g) Google calendar reads | journey `external_calendar_events` (already synced); Huddle `get_calendar_events` | No | Yes — calendar tool + schedule brief include Google events | S–M |
| h) Exact chat recall | `chat.pending_turns` (+ `ceremony_transcript`) | No | No | S |
| i) PDF/Word reading | `resolveAttachmentContent` else-branch; `artifacts.items.text` | No | Yes — agents read files instead of asking | S–M |
| j) ChatGPT import | `rag_chunks` via `writeChunk`, `source='import:chatgpt:…'` | No | Yes — recall can surface imported content | M |
| k) Overcommit warning | journey `WindowCapacity`, `find_open_slots`, `estimate_minutes`; schedule brief / priority check | No | Yes — one extra line on over-full days | M |
| l) Connection-expiry alert | `calendar_connections`, `graph_mail_subscriptions.expires_at`, `scheduled_jobs`, `send_push` DM | No | No | S–M |
| m) Delete from chat with confirm | `deleteBoardTask` + in-chat interactive payload; `UI_ONLY_JOURNEY_TOOLS` unchanged | No | Yes — agents may OFFER deletion (gate unchanged); voice "yes" variant would loosen #124 | S |

**Genuinely new structure across all thirteen: only `parent_task_id` (c, tier 2, already pending in
ACT:task-hierarchy) and the optional journey `task_events.actor` (b).** Everything else extends an
existing table, tool, job runner or UI.

**Rows needing the owner's 👍 before build:** c tier 2 (two-level grooming), e (only if the mode gate
lifts), g (Google events in briefs), i (agents read attachments), j (imported memory in recall),
k (capacity line), m (agents offer deletion; and separately whether a spoken "yes" may delete).
