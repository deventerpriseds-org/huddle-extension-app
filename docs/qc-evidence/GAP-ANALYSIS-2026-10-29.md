# Huddle gap analysis: what the agents still cannot do, or do clumsily (2026-10-29)

<!--
WHAT:          A gap list, grouped by what the AI does for the owner, so fixes stop arriving one mishap at a time.
WHY:           On 2026-10-28 one "plan my day" ask hit three separate defects: the hold gate (#116), the FOCUS
               hint moving everything to Doing, and an essay instead of a timed list. Each was found only by
               the owner tripping on it.
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing (current).
EVIDENCE:      read at origin/main 4cb2273 (#124); journey-voice checkout at /home/user/journey-voice (read-only);
               docs/qc-evidence/VERIFY-ownership-judge-delete-2.md on origin/claude_verify-ownership-judge-delete-2 (17ae300).
-->

**How to read this.** Each row is marked **OBSERVED** (seen in code or in the records, with a cite) or
**INFERRED** (my judgment from how the owner works; no code or record proves it). Severity: **now** = the
owner hits it in normal use this week; **soon** = it will bite as usage grows; **later** = worth having.
Size: S = hours, M = a day or two, L = a multi-PR build. Line numbers are at `origin/main 4cb2273` unless
marked otherwise. I proposed at most one line of fix direction per gap.

**What I compared against.** I matched the owner's everyday verbs (look up, go get, create, help me,
research, plan, add, remind, draft) against the full tool list an agent actually receives:
- Huddle's own tools: `grep -rhoE 'name: "[a-z_]+"' src/features/huddle/lib` returned 41 names.
- journey's tool catalog: the `execute-tool/index.ts` switch cases, minus `HIDDEN_FROM_HUDDLE = {web_search, send_email}` (`journey/proxy.functions.ts:85`) and the UI-only `delete_task` (`:114`).

Huddle tools: `ask_clarifying_question build_checklist business_hours confirm_task_intent create_artifact
create_email_draft create_huddle_task(s) delegate_to_specialist flag_blocker focus_on get_calendar_events
get_external_calendar_events get_nexus_* (11) groom_backlog ledger_ops list_artifacts lookup_facts
override_approach_gate propose_approach propose_email_reply propose_task_intent request_approach_override
resolve_clarifying_question schedule_and_priorities schedule_reminder search_memory search_scholar send_email
show_priorities_widget show_schedule_widget tavily_web_search triples_out`.

journey tools reachable from Huddle: `batch_update_tasks clear/set/list_scheduling_caveat create_calendar_event
create_google_event create_outlook_event create_task explain_task_score find_open_slots get_my_config
get_task_topics get_tasks get_tasks_by_topic get_today_tasks initiate_phone_call hang_up
list_pending_assignments move_task_to_day parse_and_create_tasks quick_create_task reschedule_task
schedule_task send_chat_message send_slack_message set_priority_rank swap_task_order undo_dedup
unschedule_task update_task send_push register_push_token`.

---

## 1. LOOK UP / ANSWER

| Gap | What the owner would experience (concrete example) | Evidence | Sev | Size |
|---|---|---|---|---|
| **In a 1:1, an out-of-lane question is refused instead of answered first.** OBSERVED. This contradicts the policy the owner approved. | "Iris, roughly what should I budget for the Austin trip?" Iris replies "That's really Finn's area, let me pass it to him", and he gets no number. | `huddle.functions.ts:2437-2443`: `laneDirective` in a 1:1 says "Do NOT answer it yourself or improvise in their lane". The generic scene at `:2482` says "keep it to one short line and @mention the right specialist", and it runs in 1:1s too. CLAUDE.md says "NO @handle in a 1:1". | now | S |
| **Turn intent is decided by regex, and anything unmatched counts as "perform".** OBSERVED. | A casual question phrased an unusual way ("thoughts on moving the gym to 5?") gets classed as a perform request. That arms the lane hand-off and the deferral prose above. | `capabilities.ts:116-126`: ACKNOWLEDGE/QUERY/STATUS/INFORM regex lists, then `return "perform"`. It feeds `laneDirective` (`huddle.functions.ts:2438`) and `capabilityHandoffBlock` (`:2501-2509`). | now | M |
| **"What's blocked?" can come back "nothing".** OBSERVED in memory. The structural fix was never built. | "Anything blocking me this week?" gets "no blockers" while 3 tasks sit in BLOCKED. | memory.md:1036: journey `get_tasks(ACTIVE/WORKABLE)` and Huddle `prioritize` both exclude BLOCKED (`tasks.server.ts` `NOT IN ('DONE','BLOCKED')`). "FIX must make blocker/status questions read a blocker-inclusive source ... un-built, needs sign-off." | now | S |
| **Schedule answers show UTC times and drop items.** OBSERVED as open in actions.md. Not re-verified today. | A 10am ET task is read back as "2 PM", and only 2 of 6 scheduled items are listed. | actions.md:2483 and :2731 are still `[OPEN]`: "schedule_and_priorities shows times in RAW UTC ... and over-trims (2 of 6 shown)". | now (if still true) | S |
| **There is no inbox search or read tool.** OBSERVED. Agents can draft and reply, and the inbound watch pushes new mail, but nobody can look something up in his email on demand. | "Did Professor Lee email me about the 702 deadline?" The agent cannot check. | No `search_email`/`read_email` tool in the 41 names. `graph-email.server.ts:249` `listInboxMessagesSince` exists, but it is used only by the watch (`inbound-email.server.ts:53`). | now | M |
| **Calendar reads cover Outlook only. Google calendars are invisible.** OBSERVED. | A dentist appointment on a Google calendar is missing from "what's on tomorrow". | CLAUDE.md "Calendar reads": "Outlook/M365 only. A Google-only calendar won't appear here". `get_external_calendar_events` describes Microsoft only (`calendar/tools.ts:40`). | soon | M |
| **The external calendar read 403s until an admin grants consent.** OBSERVED as open. | "What's on my Outlook calendar?" errors out or comes back empty. | actions.md:2475: "`get_calendar_events` returns 403 (Calendars.Read consent missing)", which is an admin action, not code. | soon | S (admin) |
| **There is no people or contacts lookup.** OBSERVED (no tool). INFERRED need. | "What's Marcus's number?" or "email my advisor" cannot resolve a person to an address. | None of the 41 Huddle names or the journey cases is a contact or people lookup. | soon | M |
| **There is no "what did we decide" over past chats beyond semantic memory.** INFERRED. | "What did Finn say about the card last week?" works only if the embedding scores ≥0.3. Exact-phrase or by-date recall is missing. | `search_memory` and `lookup_facts` exist. The retrieval floor is 0.3 (CLAUDE.md "Auto-retrieval calibration"). No tool searches `chat.pending_turns` by date or agent. | later | M |

## 2. GO GET / RESEARCH / WRITE

| Gap | What the owner would experience (concrete example) | Evidence | Sev | Size |
|---|---|---|---|---|
| **There is no instruction on the SHAPE of an answer for list-style asks.** OBSERVED. This is the third failure from 2026-10-28. | "Plan my day: gym 3pm, vitamins, two DBA papers, eulogy, app work" comes back as a multi-paragraph essay instead of a short timed table. | A grep for `timed table`, `time-block` and `plan my day` in `src/**/*.ts` finds only the two comments about the gate (`huddle.functions.ts:1783`, `routing.ts:476`), and no output-format directive. The scene's "1–3 short sentences" (`:2482`) is the only length rule, and the snapshot instructions win over it. | now | S |
| **The owner-approved planning contract is not encoded anywhere.** OBSERVED (absent). | The owner approved: a short timed table, create the missing tasks, start nothing, add times only when asked. None of that is in the runtime layer, so it depends on the model guessing. | No match in src for a planning directive. `routeDeepAsk` (`tasks/ask-shape.ts`) only picks the tier and the offer. | now | S |
| **Uploaded PDFs and Word files are not read.** OBSERVED (a follow-on in memory). | He attaches the DBA 702 rubric PDF and says "check my draft against this". The agent sees only the filename. | memory.md:2899-2901: "other binaries → acknowledged by name ... Follow-ons: PDF/docx real parse (input_file)". | now (coursework) | M |
| **The Lovable backend flattens images to a text note.** OBSERVED. | A photo of a whiteboard sent to an agent on the Lovable backend is not seen. | memory.md:2899: "Lovable `generateText` path FLATTENS images to a text note". | later | S |
| **Agents with a vector store narrate "uploaded files" and add latency.** OBSERVED. The product decision is still open. | Charleston or Finn says "I couldn't find that in the uploaded files" on a plain question. | memory.md:2460 (3): `charleston-lewis, elle-rowan, finn-reid, cam-post` have live vector stores. `fileSearch` defaults true. "a PRODUCT decision ... not yet done." | later | S |
| **Artifacts mirror to OneDrive only after admin consent, and Google Drive is deferred.** OBSERVED. | An approved brief does not show up in OneDrive (403 `needsConsent`), and never shows up in Google Drive. | CLAUDE.md "Artifact store ... Phase 2": needs `Files.ReadWrite.All` consent; `gdrive` returns `{deferred:true}`. | soon | S (admin) / M |

## 3. CREATE / ADD / CAPTURE

| Gap | What the owner would experience (concrete example) | Evidence | Sev | Size |
|---|---|---|---|---|
| **A standing hint tells agents to START everything in a list.** OBSERVED. This is failure #2 from 2026-10-28. | "Here's what I want to get done today: ..." puts all six items in Doing at once, against WIP cap 1. | `tasks/tools.ts:476-477` `FOCUS_SYSTEM_HINT`: "When the user tells you what they want to work on or focus on — a list ... call `focus_on` ... starts the ones that already exist and creates-then-starts the ones that don't ... do not ask for confirmation." It is appended to both backends (`huddle.functions.ts:3447`, `:5813`). | now | S |
| **Voice `focus_on` ignores the journey toggle.** OBSERVED (verifier finding). | A voice harness or test session with journey off can still create and start real tasks on his board. | VERIFY-ownership-judge-delete-2.md AC8: `realtime-tools.server.ts:174` always includes `FOCUS_TOOL`; the executor at `:526-528` "calls `dispatchFocusOn` with no journey check". | now | S |
| **There are no recurring tasks or habits.** OBSERVED (no tool). | "Gym every Mon/Wed/Fri at 3" or "take vitamins daily" gets one task or one reminder, then nothing. | Recurrence hits in `src/features/huddle/lib` are all about the internal job scheduler (`tasks/scheduler.server.ts:1`). `SCHEDULE_REMINDER_TOOL` (`tasks/reminders.ts:9-40`) takes a delay or time with no repeat field. journey cases have no recurrence. | now | M |
| **There is no shopping or errand list.** OBSERVED (no tool). INFERRED usage. | "Add fish oil and magnesium to my vitamin shop list" becomes a board task per item, or one vague task. | Grep for `shopping|grocery` in lib returns 0. No list tool exists other than `build_checklist` (a checklist on a task). | soon | S |
| **There are no quick notes.** INFERRED. | "Note: the eulogy should mention the lake house" goes to memory (if it scores) or becomes a task. There is no notes surface he can open. | Capture paths are `create_huddle_task(s)`, `create_artifact`, and the RAG auto-write. No note tool. | soon | M |
| **Standalone-Huddle task creation does not write the mirror.** OBSERVED as open. | A Huddle-only user (no journey) creates a task and it never appears in `prioritize` or on the board. | actions.md:2744: "[OPEN — data parity] Standalone-Huddle create path must write `tasks.journey_tasks` directly". | later | M |
| **There is no task hierarchy (epic, task, subtask).** OBSERVED (owner-requested, not started). | "Break the DBA 702 paper into research / outline / draft" produces flat tasks with no parent, and grooming can reorder them apart. | actions.md:3600-3618 `ACT:task-hierarchy`: "hierarchy is genuinely absent ... the build is not started". `blocked_by uuid[]` is dead (0 rows). | soon | L |
| **Near-duplicate tasks still slip through.** OBSERVED as open. | "Prepare investor pitch" and "Lock investor pitch" both live. Parking one leaves its twin scheduled. | actions.md:2749 `[OPEN — bug]`. Exact-duplicate cleanup is waiting on his row approval (`ACT:duplicate-cleanup`). | soon | M |

## 4. PLAN / SCHEDULE / REMIND

| Gap | What the owner would experience (concrete example) | Evidence | Sev | Size |
|---|---|---|---|---|
| **He cannot list, cancel or move a reminder.** OBSERVED. | "Cancel the 2pm reminder" or "push that alarm to 4". The agent has no tool, and no screen lists reminders. | Only `schedule_reminder` exists. `cancelReminder` (`tasks/turns.server.ts:680`) is called only internally, when the linked task is DONE (`tasks/reminders.ts:179`). Grep for `cancelReminder|listReminders` in `src` finds no component. | now | S |
| **He cannot edit, move or delete a calendar event.** OBSERVED. | "Move my 3pm with Dana to 4" or "cancel tomorrow's study block". The agent can create events but not change them. | journey cases include `create_calendar_event`, `create_google_event` and `create_outlook_event`, and no update or delete event case. No Huddle tool either. | now | M |
| **Planning has no "fit this list into my free time" step.** INFERRED. Uses existing pieces. | "Plan my day" lists items without checking his 2pm meeting or class times, so the table collides with real commitments. | `find_open_slots` (journey) and `schedule_and_priorities` exist, but nothing tells a planning answer to call them. See §2 row 1. | now | S |
| **A star set on the phone can be erased by Monday's groom.** OBSERVED (known exposure). | He stars "Call insurance" on Android. Monday 8am the groom un-stars it because it was not in the top 20. | memory.md DATA MODEL "Known exposure (not fixed): a star set on the phone or journey web ... is cleared by Monday's groom unless in `week_order`". | soon | S |
| **"Today" via `move_task_to_day` writes no end time.** OBSERVED. | A task moved to today does not count against capacity, so the nightly planner overbooks. | memory.md DATA MODEL: `move_task_to_day` "writes `start_time` + `due_date`, **no `end_time`**, bypasses windows — invisible to the nightly's capacity maths". | soon | S |
| **Two scoring engines and a window mismatch.** OBSERVED as open. | Huddle's priority order and journey's nightly order disagree. "After work" means 17-22 in one place and 17-19 in another. | actions.md:2738 `[OPEN — design] Unify the scoring engine`. CLAUDE.md Backlog #4: "`after_work` window drift ... whole-hour truncation ... capacity guard". | later | L |
| **There is no overcommit warning.** OBSERVED (backlog). | He asks for six things today with four free hours. Nothing says "this does not fit". | CLAUDE.md Backlog #4: "a capacity guard that flags overcommitment instead of scheduling into nonexistent time". | soon | M |
| **The owner cannot tune his daily digest.** INFERRED from records. | He wants the morning brief at 7:30, or without the task list. Cadences are per-user overrides with 0 rows and no chat path; content is hardcoded. | CLAUDE.md "Reach-out cadence": `identity.scheduling_config` "had 0 rows". Brief content lives in a directive (memory.md:172-185). | later | M |

## 5. CHANGE / ORGANIZE (update, move, park, complete, delete, undo)

| Gap | What the owner would experience (concrete example) | Evidence | Sev | Size |
|---|---|---|---|---|
| **There is no general undo.** OBSERVED. | An agent moves six tasks to Doing by mistake, or re-assigns one. He has to fix each by hand. | The only undo is journey `undo_dedup` (restores a task the dedup guard skipped, `tool-definitions.ts:302`). There is no action log to reverse. | now | M |
| **Agents cannot delete a task, even when he asks.** OBSERVED (by design in #124). | "Delete the 'Plan daily activities' task" gets "use the board's Delete" or a park. It cannot be done in chat. | `UI_ONLY_JOURNEY_TOOLS = new Set(["delete_task"])` (`proxy.functions.ts:114`). The memory shows the stray task still waiting on a manual delete (memory.md "Open: stray task"). | soon | S (a confirm-in-chat path) |
| **An agent can re-assign a task with no ownership check.** OBSERVED (verifier finding). | Sam calls `update_task(assigned_agent:"sam-...")` on Finn's task and it moves silently. | VERIFY-ownership-judge-delete-2 AC1: "agent-invoked journey `update_task` with an `assigned_agent` arg — NO — bypass" (journey `tool-definitions.ts:74-89`, execute-tool `:976-977`). | soon | S |
| **journey `update_task` is not scoped to the user.** OBSERVED (verifier, journey side). | With the client-asserted caller (§10), any task id could be edited. | VERIFY-ownership-judge-delete-2: "`updateTask` filters only `.eq('id', args.task_id)` at :998-999, with no user_id". | soon | S (journey) |
| **Grooming replaces tags blindly.** OBSERVED as open. | A tag he added by hand ("waiting-on-Dana") disappears after Monday's groom. | actions.md:2746: "grooming (`groom.ts:168`) blind-replaces the tags array". Parked tags were fixed (`bebc385`), but not general tags. | soon | S |
| **Parking a task leaves its owner and rank.** OBSERVED as open. | A parked task still shows an assignee and rank in some views. | actions.md:2793 `[OPEN — consider] the PARK action could also clear stale assigned_agent/priority_rank`. | later | S |
| **The nightly planner demotes IN_REVIEW and DOING to TODO.** OBSERVED (root-caused 2026-08-06). Current state not re-verified. | A draft waiting for his review vanishes from Review overnight. | memory.md:1055-1067: journey `nightly-schedule-builder` "OVERWRITES status to 'TODO'" (lines 837/1344/1454). "fix NOT yet built". | now (if unchanged) | S (journey) |

## 6. COMMUNICATE (email, messages, calls)

| Gap | What the owner would experience (concrete example) | Evidence | Sev | Size |
|---|---|---|---|---|
| **No on-demand inbox read.** OBSERVED. See §1. | "Summarise what came in from the program office today" cannot be done. Only the push-driven watch tells him about new mail. | `graph-email.server.ts:249` `listInboxMessagesSince` is used only by `runInboundEmailWatch`. | now | M |
| **Save-to-Drafts for email replies is not owner-confirmed.** OBSERVED. | He taps "Save to Drafts" on Iris's reply card and does not yet know if it lands in Outlook. | memory.md:3806 (`ACT:inbound-email-watch`): "Save-to-Drafts NOT yet owner-confirmed". actions.md:4678 "OPEN until owner confirms". | now | S |
| **No text or SMS channel.** OBSERVED (no tool). INFERRED need. | "Text Dana I'm running late" has no route. journey offers `send_chat_message` (in-app), `send_slack_message` and `initiate_phone_call`, but no SMS. | The journey case list has no sms. Huddle has none either. | later | M |
| **Agent replies have no push unless journey is connected.** OBSERVED. | A Huddle-only user gets no phone notification for a reply, a reminder or an alarm. | CLAUDE.md "Known gap — Huddle-only (no journey) has NO phone push at all ... Deferred by the user (2026-10-08)". | later | M |
| **A Huddle alarm on a task journey already alarms rings in both apps.** OBSERVED (the user chose to leave it). | Double alarm for the gym. | CLAUDE.md "Known overlap, left as is by the user's choice". | later | S |

## 7. WORK IN THE BACKGROUND (produce, autowork, confirm gates, review)

| Gap | What the owner would experience (concrete example) | Evidence | Sev | Size |
|---|---|---|---|---|
| **A short "ok" or "great" in a 1:1 can silently confirm a pending task's Definition of Done.** OBSERVED. | Iris asked about task X earlier. Later he says "ok great" about something else, and task X's DoD is locked and the task advances. | `huddle.functions.ts:700-760`: when the DM agent has an `asked` task, `isPlainConfirmation(replyText)` (`:639-648`, which matches `ok|sure|great|right|perfect` under 40 chars) calls `confirmTaskIntent` before any model reads the message. The binding is now the last-sent ask (`tasks.server.ts:1227`), which is better, but the message still is not checked to be ABOUT that task. | now | S |
| **The confirm, approach and review gates are heavy for simple tasks.** INFERRED from his philosophy, with OBSERVED mechanics. | "Get the vitamin list together" goes through confirm-intent, then an approach grade, then review before anything happens. A ChatGPT-style "just do it" is not available for work done in the background. | CLAUDE.md "Agent auto-work": the UP_NEXT→DOING gate behind `confirm_task_intent`, then the "auto-graded approach gate", then IN_REVIEW. `ACT:chatgpt-work-flow-parity` (actions.md:3638) is an open assessment. | soon | M |
| **The produce offer is lost if he replies with anything other than an explicit produce phrase.** OBSERVED (by design). | The agent offers the full version; he says "yes please". `isOfferAccepted` needs a produce phrase, so the offer is cleared and nothing is produced. | `huddle.functions.ts:1726-1740`: "Only an explicit produce phrase accepts (a bare 'yes' may be answering a question inside the answer itself)". "Any other next message clears it." | soon | S |
| **Specialist workers can spawn from a plain question and post into other agents' DMs.** OBSERVED (incident). | A "plan my day" turn produced 2 Tess artifacts in his review queue and messages in Sam's and Tess's DMs. | accuracy-log.md 2026-10-28: "it also spawned Tess specialist workers that put 2 artifacts in the review queue and messages in Sam's/Tess's DMs". | soon | S |
| **There is no chat-reachable reset for a stuck task.** INFERRED. Partially addressed. | A task stuck in an escalated approach or awaiting review: he has to know which tool or board action applies. | The escalated-is-terminal issue was fixed (`approach-gate.server.ts` comment block at ~:130). `override_approach_gate` and `request_approach_override` exist, but he has no "unstick this" verb. | later | S |

## 8. TEAM / HAND-OFF

| Gap | What the owner would experience (concrete example) | Evidence | Sev | Size |
|---|---|---|---|---|
| **1:1 deferral by default** (same as §1 row 1). OBSERVED. | In Iris's DM he asks a money question and gets a hand-off instead of an answer. | `huddle.functions.ts:2442`. | now | S |
| **The 1:1 scene text still says @mention, which contradicts the 1:1 rule.** OBSERVED. | An agent writes "@finn-reid" in a DM, where the mention does nothing (nobody is in the room). | `:2482`: the generic scene has no scope check. CLAUDE.md: "NO @handle in a 1:1 (@ is group-only)". | soon | S |
| **A hand-off in prose re-queues nobody.** OBSERVED (documented). | In a group, "I'll get Finn to run the numbers" and Finn never speaks. | CLAUDE.md "Secondary (prose handoff)": "When an agent delegates in prose ... no re-queue happens". | soon | M |
| **Grooming in chat can exceed the 45s ceiling.** OBSERVED (computed by the verifier, not measured). | "Terry, groom the backlog" in chat can time out and come back partial. | VERIFY-ownership-judge-delete-2 AC3: "total ... **~63.5s** ... Still over the ~45s ceiling in the worst case. Typical time is UNPROVEN". | soon | M |
| **Every created task can add up to 5s for the ownership judge, even with journey off.** OBSERVED. | A brain-dump with 6 items created one by one adds up to 30s. | VERIFY-ownership-judge-delete-2 AC2 notes (b) and (c). | soon | S |

## 9. MEMORY / CONTEXT

| Gap | What the owner would experience (concrete example) | Evidence | Sev | Size |
|---|---|---|---|---|
| **His ChatGPT knowledge is not ingested.** OBSERVED (stated gap). | Things he told ChatGPT over months (preferences, venture details) are unknown to the team. | memory.md:128: "Gaps: ... the owner's ChatGPT knowledge isn't ingested yet." | soon | M |
| **Voice now shares memory, but that is not owner-confirmed.** OBSERVED. | It is not known yet whether a voice 1:1 actually knows his goals. | actions.md `ACT:voice-context-parity`: "[ ] Owner confirms on a live voice 1:1 ... (NOT yet confirmed)". | now | S |
| **Short-term context does not cross huddles.** OBSERVED (by design). | He says something in the group, then in Iris's 1:1 says "like I said": she has only RAG memory, and only if the score is ≥0.3. | CLAUDE.md "Chat memory & context architecture": history is per-huddle, and the only bridge is `rag_chunks`. | later | M |
| **The Memory view's intent is still an open owner decision.** OBSERVED. | He cannot see or curate what the team "knows" about him in one place. | actions.md:3865: "OWNER DECISION deferred by the owner to post-deploy: Memory view — original intent". | later | M |
| **Agents do not know their own mechanisms.** OBSERVED (incident note). | Tess says "I don't handle real-time board state" when she can read it. | memory.md:1038: "agents blind to their own mechanisms ... = separate follow-on". | later | S |

## 10. PLATFORM / RELIABILITY / SAFETY

| Gap | What the owner would experience (concrete example) | Evidence | Sev | Size |
|---|---|---|---|---|
| **The caller identity is asserted by the client.** OBSERVED. | Anyone who can call the server fn with his email can read or write his board. Today this is a single-user app, so the risk is latent. | The server-fn input takes `caller: { entra_object_id?, entra_email? }` as optional zod strings (`huddle.functions.ts:216`, `:8015`, `:8103`). VERIFY-ownership-judge-delete-2 AC5: "The client-asserted caller is pre-existing". journey `updateTask` is unscoped (§5). | soon (before any second user) | M |
| **The journey toggle is enforced per call site, not at one chokepoint.** OBSERVED. | A test harness run writes real tasks to his board. This happened on 2026-10-28 (7 created, 8 started). | accuracy-log 2026-10-28: "the toggle is per call site, not global ... Open: a single chokepoint test that EVERY journey-writing dispatch is gated". Voice focus_on is still ungated (§3). | now | S |
| **The ~45s hosting ceiling and slow tiers.** OBSERVED. | Long group turns or deep asks come back "deferred", or as partial replies that trickle in. | `huddle.functions.ts:695-700`: `CHUNK_BUDGET_MS = 30_000`, `TURN_DEADLINE_MS = 36_000`, `MAX_CHUNKS = 6`. memory.md:2727-2736: "an in-flight OpenAI call can't be paused/resumed across executions". | soon | L |
| **There is no per-agent model-call timeout.** OBSERVED (backlog). | One slow agent in a group wave drags the whole turn toward the ceiling. | CLAUDE.md Backlog #2: "Wrap each agent's `callOpenAIResponses`/`generateText` in an AbortController (~30s)". | soon | S |
| **Prompt caching is not exploited.** OBSERVED (backlog #1). | Slower, costlier turns, especially in groups. | CLAUDE.md Backlog #1: "order the prompt as [stable prefix] + [volatile suffix]". | later | M |
| **There is no token streaming in 1:1 chat.** OBSERVED. | He waits 5-10s for a whole reply. journey feels faster because it streams. | memory.md:2460 (2): "Latency 5–10s/turn ... Journey feels faster because it STREAMS tokens". `docs/plan-1on1-token-streaming.md` exists as a plan. | soon | L |
| **Admin consents that gate features are not granted.** OBSERVED. | Outlook calendar reads 403. OneDrive mirroring returns `needsConsent`. | actions.md:2475; CLAUDE.md Artifact store Phase 2. | soon | S (admin) |
| **Connector expiry has no proactive alert.** INFERRED. | His Google or Outlook connection in journey lapses, and Iris's brief silently loses meetings. | The brief depends on `resolveCalendarMailbox` via journey `get_my_config` (memory.md:174). I found no expiry check or "reconnect" message in src. | later | M |
| **Many shipped fixes are not owner-confirmed.** OBSERVED. | Behaviour he has not seen work is recorded as live: deep-ask hybrid, confirm rotation, sticky priority push, timestamps, voice context parity, email drafts. | memory.md:120, :130, :147, :172, :1747; actions.md:4819. All are marked "NOT owner-confirmed". | now | S (one walk-through) |

---

## Top 10 to do next (ranked by owner impact)

1. **Replace the FOCUS hint with the approved planning contract.** A list means a short timed table, create the missing tasks, start nothing, add times only when asked. This fixes failures #2 and #3 from 2026-10-28. (`tasks/tools.ts:476`; §2, §3)
2. **Make the 1:1 lane rule "answer first, then offer the hand-off"**, and drop "@mention" from the 1:1 scene. (`huddle.functions.ts:2442`, `:2482`; §1, §8)
3. **Stop a bare "ok"/"great" from confirming a task's Definition of Done** unless the message is about that task. (`huddle.functions.ts:639-760`; §7)
4. **Add tools to list, cancel and move reminders.** The backend `cancelReminder` already exists. (§4)
5. **Add tools to edit and delete calendar events** (journey side, beside `create_calendar_event`). (§4)
6. **Add an on-demand inbox search and read tool** on top of the existing `listInboxMessagesSince`. (§1, §6)
7. **Gate every journey write at one chokepoint**, including voice `focus_on`, so test runs can never touch the real board. (§3, §10)
8. **Add recurring tasks and habits** (gym MWF, daily vitamins). (§3)
9. **Make blocker and status questions read a source that includes BLOCKED tasks, and localise schedule times to ET.** (§1)
10. **Add an undo of the last agent action, plus a chat path to delete a task with a confirm step.** (§5)

Also worth an owner walk-through in one session: the not-owner-confirmed list in §10, last row.
