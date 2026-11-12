<!--
WHAT:          Independent acceptance criteria for "daily correspondence + task-proposal checklist":
               a Teams rolling log and the email feed read from OneDrive, unanswered correspondence
               shown in the attention bell, and to-dos proposed as rows in the EXISTING chat checklist.
WHY:           Owner request (handoff b689ff57 + chat, 2026-11-12). Tier 1: it admits model output
               (extracted tasks, "needs a reply" verdicts) into stored claims, so it needs ACs before code.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      written cold from origin/main 207b0b5e by an AC subagent; every AC names its binding file.
-->

# Acceptance Criteria: correspondence watch and task-proposal checklist

**Task:** Huddle reads the day's Teams messages (a new rolling JSONL in OneDrive) and the existing email feed. It flags correspondence that still needs the owner's reply in the **existing attention bell**. It also proposes to-dos from emails, chats and Fireflies transcripts as **new rows in the existing chat checklist**, which the owner can approve, edit, complete or dismiss. Nothing is enabled until the real Power Automate files are verified.

**Primary source:** the owner's handoff (`Claude_Code_Huddle_Daily_Email_Teams_Processing_Handoff.md`, lines 1-105) plus his chat message. If an AC and the handoff disagree, the handoff wins.

**Sources read (origin/main 207b0b5e):** `lib/external-feeds/onedrive-feed.ts`, `onedrive-feed.server.ts`; `lib/email/inbound-email.ts`, `inbound-email.server.ts`, `email-replies.server.ts`; `lib/attention/attention.ts`, `attention.functions.ts`; `components/AttentionBell.tsx` (actions only); `lib/tasks/scheduler.server.ts` (JOB_ROWS, fireJob, runDueScheduledJobs); `lib/tasks/create-task-core.ts` (header and exports); `lib/tasks/tools.ts` (CHECKLIST_TOOL, hint, executor); `data/seed.ts` (ChecklistRow/Payload, SuggestedTaskDraft); `store.ts` (ChecklistRowState, seed/refresh/set/rollback, approveTask/skipTask); `components/HuddleView.tsx` (ChecklistCard, ChecklistItem.apply); `components/ContextPanel.tsx` ("Needs your approval"); `lib/stream-context.ts` (checklist summary); `lib/tasks/board.functions.ts` (updateBoardTask); `lib/fireflies/fireflies.server.ts` (saveTranscript, heartbeat hook); `scripts/onedrive-feed.test.ts`, `scripts/onedrive-feed-dryrun.ts` (headers); `.claude/memory.md` G7 note.

**Existing systems this EXTENDS (each one, not a parallel copy):**

| Concern | Existing system (read) | Extension point |
|---|---|---|
| OneDrive reading | `readFeed` (eTag, maxBytes, 10s deadline, last-good copy in `chat.external_feed_state`), config `HUDDLE_ONEDRIVE_FEEDS` via `parseFeedsConfig` | a third `FeedFileConfig` (Teams) in the SAME config; same state table |
| Email screening | `screenMessage` (self / bulk-header / automated-sender / other-folder / no-ask) | reused unchanged for email and adapted for chat |
| Owed / settled | `chat.email_replies` (`recordOwedEmail`, `settleEmailReply`, `OWED_STATUSES`, `kind`) | a new `kind` for Teams; email rows unchanged |
| Bell | `ATTENTION_KINDS`, `toAttentionItem`, `bellItems`, `getAttentionFn`, `dismissAttentionFn`, `AttentionBell.tsx` | the new kind is added to these lists, not to a second bell |
| Periodic work | `runDueScheduledJobs` heartbeat (Fireflies is started alongside it; jobs go in `JOB_ROWS` + `fireJob`) | no new cron, no new public route (G7) |
| Checklist | `build_checklist`, `ChecklistPayload`/`ChecklistRow`, `checklistState`, `ChecklistCard`/`ChecklistItem`, stream-context summary | a new row KIND (proposal) inside the same payload and card |
| Task creation | `create-task-core.ts` (`normalizeTaskTitle`, `loadOpenTaskTitles`, `screenRawJourneyCreate`, `screenCapabilityMetaTask`) → journey `public.tasks` → mirror | Approve calls this, never a raw journey insert |
| Transcripts | `chat.fireflies_meetings` (PK `meeting_id`), `fireflies-<id>.md` in `Automation/transcripts` | read-only source of transcript proposals |
| Older approve list | `ContextPanel` "Needs your approval" (client-only `Task.suggested`, `approveTask`/`skipTask`) | must be reconciled (AC-5.14), not left as a second approve list |

Notation: **[F]** is an offline test against a fixture; **[DB]** is a SQL row check (`azure-pg-query.yml`); **[UI]** is a Playwright check (`verify-uat.yml`); **[LOG]** is captured console output. Tier 1 throughout.

---

## 1. Teams rolling JSONL adapter

The handoff names the intended source (handoff L33-39): one stable, rolling file, planned at `/automation/huddle-source-log.jsonl`. Each line is one record with source, chat id, capture timestamp, pending status, and an array of message objects (id, timestamp, body, sender). Identity is chat id + message id, never the capture date.

| # | Given / When / Then | Cat. | Observed via |
|---|---|---|---|
| AC-1.1 | Given `HUDDLE_ONEDRIVE_FEEDS` with a `teams` file entry, when `parseFeedsConfig` runs, then the result has `teams: {enabled, path}` built by the SAME `file()` rule as `email`/`appointments`: a path not starting with `/`, or containing `..`, sets `enabled:false`. An absent `teams` key leaves email and appointments parsing byte-identical to today. | happy/regression | [F] `onedrive-feed.test.ts` new cases + all existing cases still PASS |
| AC-1.2 | Given the Teams file, when it is read, then it goes through `readFeed`'s I/O path (same app token, same `FEED_READ_DEADLINE_MS`, same `maxBytes` size check before AND after download, same eTag short-circuit). Its state row is in `chat.external_feed_state` with `feed_key` beginning `teams:`. There is no second Graph download function. | extend | code review: one `fetch` site for drive content; [DB] row `teams:%` exists after a run |
| AC-1.3 | Given a JSONL file, when it is parsed, then each line is parsed on its own. A whole-file `JSON.parse` (which today returns `rejected:not_json` for any JSONL) is never applied to the Teams file. | happy | [F] a 3-line fixture yields 3 records, not `not_json` |
| AC-1.4 | Given one malformed line (truncated JSON) between two good lines, when parsed, then both good lines' messages are returned, the bad line is counted in `skipped`, and the file status is `ok` with a `last_error` note naming the COUNT only (the existing `skippedNote` pattern). | edge | [F] counts 2 good / 1 skipped; [LOG] note has no line content |
| AC-1.5 | Given the same message (same chat id + message id) on two lines (a flow rerun), when processed, then it produces exactly ONE ledger row (AC-3.1), ONE bell item at most, and ONE proposal at most. | edge | [F] + [DB] `count(*)` = 1 for that source id |
| AC-1.6 | Given two lines with DIFFERENT capture timestamps carrying the same message ids, when processed, then the capture timestamp has no effect on identity: no new rows, and only a changed body/edit (AC-3.4) updates anything. | edge | [F] |
| AC-1.7 | Given two messages with the SAME message id in DIFFERENT chat ids, when processed, then they are two distinct items, because identity is (chat id, message id) (handoff L37). | edge | [F] two rows |
| AC-1.8 | Given the file exceeds `maxBytes`, when read, then status is `rejected:too_large`, the last-good state is kept, NOTHING already processed is re-emitted, and health shows the rejection (AC-6.6). Because the file only ever grows, this is the expected end state of an untrimmed log. See OQ-3. | edge/error | [F] + [DB] `last_status` |
| AC-1.9 | Given `synthetic:true` in config, when a Teams record is not explicitly marked synthetic (field per OQ-2), then it is skipped and counted. This is the same fail-closed rule as `synthetic_mismatch` for email. Given `synthetic:false`, a record still marked synthetic is skipped too. | regression of safety rule | [F] both directions |
| AC-1.10 | Given `notBeforeUtc`, when a Teams message's own timestamp is earlier, then it is never evaluated (same rule as `eligibleFeedMessages`). | edge | [F] |
| AC-1.11 | Given a record with an empty message array, when parsed, then it yields zero items and is not an error. | edge | [F] |
| AC-1.12 | Given a parse, when it runs, then the adapter is the ONLY module that knows the PA field names. It outputs a source-neutral item `{source:'teams', chatId, messageId, at, senderId, senderName, text, chatName?, webUrl?}`, and no domain module (ledger, correspondence, proposals) reads a raw PA field. | design | grep: PA field names appear only in the adapter + its test |
| AC-1.13 | Given a run, when Huddle reads the log, then it never writes, renames, moves or deletes the file (handoff L60). Pending status in the file is never written back. | regression | code review: no `PUT`/`PATCH`/`DELETE`/`move` on the Teams path; Graph call log in test spy shows GET only |

### Spelling table, Teams record adapter (Tier 1 parser)

"Documented by" cites what was actually opened this session. The Graph chatMessage reference and jsonlines.org were **unreachable** (network allowlist), so rows that depend on them are listed under Gaps, not here.

| # | Input spelling (one JSONL line, abbreviated) | Documented by | Expected verdict | Wrong answer would be |
|---|---|---|---|---|
| S-1 | `{source, chatId, capturedUtc, status:"pending", messages:[{id, timestamp, body, sender}]}` | handoff L37 (planned shape) | ACCEPT, 1 item per message | FALSE REFUSAL |
| S-2 | same line, repeated verbatim twice | handoff L38 | ACCEPT once; 2nd is a no-op | FALSE PASS (duplicate) |
| S-3 | same `chatId`+message `id`, different `capturedUtc` | handoff L38 ("capture date is not identity") | no new item | FALSE PASS |
| S-4 | message object missing `id` | handoff L37 (id required) | SKIP that message, count it | FALSE PASS |
| S-5 | line missing `chatId` | handoff L37 | SKIP line, count it | FALSE PASS |
| S-6 | message `timestamp` not a parseable date | handoff L37 + existing `isIso` rule in `onedrive-feed.ts` | SKIP message, count it | FALSE PASS |
| S-7 | `{"chatId":"c1","messages":[` (truncated line) | AC-1.4 / existing "one malformed record must not freeze the feed" comment (`validateEnvelope`) | SKIP line; other lines processed | FALSE REFUSAL of whole file |
| S-8 | whole file is one JSON array `[{...},{...}]` (not JSONL) | handoff L39 ("adapt the parser or document the field") | REJECT with status `rejected:not_jsonl` (named), never half-ingest | silent FALSE PASS |
| S-9 | blank line between records | Gap G-2 (jsonlines.org) | TBD, not filled from recall | — |
| S-10 | CRLF line endings | Gap G-2 | TBD | — |
| S-11 | message `body` is an object `{content, contentType:"html"}` | existing `mapFeedMessage` handles exactly this shape for email | ACCEPT; text via existing `htmlToText` | FALSE REFUSAL |
| S-12 | message whose sender is the owner's configured Teams id (OQ-4) | handoff L65 ("evaluate in thread context, including later replies") | ACCEPT as a REPLY signal, never as an item needing reply | FALSE PASS (owner's own message flagged) |
| S-13 | body text `"echo: please send the deck by Friday"` inside a **quoted/forwarded** block | over-match negative, same rule as `newTextOnly` / `stripBlockquotes` for email | quoted part not used as an ask or a task | FALSE PASS (proposes a to-do from quoted history) |
| S-14 | body `"https://x.example/form?id=1"` only | over-match negative, existing `htmlToText` "URL ? is not a question" rule | not an ask | FALSE PASS |
| S-15 | `source` value other than the configured Teams source label | parallel of `wrong_source` in `validateEnvelope` | SKIP line, count `wrong_source` | FALSE PASS |
| S-16 | system/event message (member added, call ended), deleted message, edited message | Gap G-1 (Graph `messageType`, `deletedDateTime`, `lastModifiedDateTime` not opened) | TBD from the real sample: proposed verdicts are not-an-item / resolve-or-ignore / AC-3.4 update | — |

---

## 2. Email source (the existing snapshot feed)

**The handoff and the code disagree, and the code is what runs today.** The handoff (L43) describes "individual files" in `/automation/email`. `parseFeedsConfig` defaults to ONE replace-in-place snapshot, `/automation/email/emails.json`, with a bounded window (`window_start_utc`, `complete:true`, < 1000 records). These ACs bind to the snapshot. If the real archive is per-file, AC-2.1 to 2.3 still apply per record. See OQ-1.

| # | Given / When / Then | Cat. | Observed via |
|---|---|---|---|
| AC-2.1 | Given the email feed, when the correspondence and proposal pass runs, then it uses the records from `feedEmailMessages` / `readFeed(cfg,"email")` (same `feed_key`, same eTag state). There is no second reader of `emails.json`, and no second screen. | extend | code review; [DB] exactly one `email:%` row in `external_feed_state` |
| AC-2.2 | Given a feed record, when its identity is computed, then the key is `(source='email', mailbox, original Outlook id)`, which is already what `mapFeedMessage` builds as `feed:<mailbox>:<id>`. If the record carries `internetMessageId`, that is stored too. A record with neither id is skipped and counted (existing rule), never keyed by subject or time. | happy | [F] |
| AC-2.3 | Given the snapshot has no provider message id but the drive item has an eTag, when that fallback is used, then the ledger row records `identity_basis='drive_item_etag'` and a health note "provider message id missing". This is the "recorded gap" from handoff L44. | edge | [DB] column value; [UI] health line |
| AC-2.4 | Given a workday snapshot published 18:00 ET Friday and the next on Monday 18:00 ET, when the Monday run processes, then every message received after the Friday snapshot is evaluated, including one at Monday 06:00 ET. **Today's `INBOUND_EMAIL_LOOKBACK_HOURS_DEFAULT` (12h, max 72h) would silently drop it.** The ledger (section 3), not the lookback window, decides "new". | edge (wrong-but-running) | [F] fixture with `nowMs` Monday 18:05 ET |
| AC-2.5 | Given a message that was in yesterday's snapshot and has rolled out of today's window, when today's snapshot is processed, then its ledger row, bell item and proposals are UNCHANGED. Absence from a bounded snapshot is not deletion, reply or resolution. | edge | [F] + [DB] |
| AC-2.6 | Given any run, when it ends, then the archive file's drive eTag is unchanged by Huddle. Huddle issued no write to any path under the email folder. | regression | test spy: GET-only on that path |
| AC-2.7 | Given the existing inbound-email watch (Iris's per-email alert, `recordOwedEmail`, `emailReplyRef` card, `draftable:false` for feed mail), when this feature is on, then each feed email is still announced exactly as today: one turn id `inboundEmailTurnId(m.id)`, same directive, same card. The new pass adds no second announcement for the same email. | regression | `bun scripts/inbound-email.test.ts` green; [DB] 1 `pending_turns` row per email |

---

## 3. Durable processing ledger

The handoff requires a ledger in the existing Huddle database (L54-60). The ledger lives in Azure PG `RAG_AI_Agents`, bootstrapped like `chat.external_feed_state` (`ensureBootstrapped`, idempotent DDL).

| # | Given / When / Then | Cat. | Observed via |
|---|---|---|---|
| AC-3.1 | Given any source item, when it is first seen, then exactly one row exists with PRIMARY/UNIQUE key `(source, source_item_id)`. `source` ∈ `email`/`teams`/`transcript`. `source_item_id` is (mailbox:id), (chatId:messageId) or (Fireflies `meeting_id`). | happy | [DB] unique constraint present; duplicate insert is a no-op |
| AC-3.2 | Given a row, then it carries every field the handoff lists (L55): thread/chat/conversation id when available, item timestamp, drive path + item id, file eTag when available, `first_seen_at`, `status`, result ids (bell item id, proposal ids), `last_error_category`. | happy | [DB] column list |
| AC-3.3 | Given processing of an item, when the bell or proposal write FAILS, then the row is NOT `processed`. It is `failed_retryable` with `attempts+1`, and the next run retries it. `processed` is set in the same transaction as, or strictly after, the committed result rows. | error | [F] with a failing writer stub: status ≠ processed |
| AC-3.4 | Given an item re-read with a different content hash (an edited Teams message, a changed email body), when processed, then the SAME row is updated (`content_hash`, `updated_at`). Its bell item and proposals are updated in place or superseded, never duplicated. A proposal the owner already decided is never reopened by an edit. | edge | [DB] still 1 row; proposal count unchanged unless new to-dos |
| AC-3.5 | Given an unchanged item (same hash) re-read on every run, then zero writes happen to the ledger, bell or proposals beyond a cheap `last_seen_at` touch. | perf/idempotent | [DB] `updated_at` unchanged |
| AC-3.6 | Given an item that fails `max_attempts` times (a configurable default, proposed 5), then it becomes terminal `failed` with a category. Health shows the count, and it is never retried in a hot loop. | error | [F] |
| AC-3.7 | Given an item whose reply status cannot be decided (AC-4.6/4.7), then its status is `needs_context` with `missing_field` set (`sent_items`, `owner_teams_id`, `thread_id`, ...). It is re-evaluated when a later file supplies that context. | edge | [DB] |
| AC-3.8 | Given a run over a fixture whose bodies contain the canary `CANARY-7f3a`, when console output is captured, then the canary, any subject, sender address, chat name, transcript text, Graph token or `Bearer` string appears in NO log line. Logs carry counts, statuses, error categories and sender DOMAIN only (the existing inbound-email rule). | security | [LOG] grep = 0 hits |
| AC-3.9 | Given two overlapping heartbeat ticks processing the same item, then the unique key plus a compare-and-set claim (the `claimConfirmAskSend` shape) yields one result set. | edge | [F] concurrent calls → 1 row, 1 bell item |
| AC-3.10 | Given a normal day (≤ 300 Teams messages, ≤ 200 emails, ≤ 5 transcripts), when a pass runs from `runDueScheduledJobs`, then it is started alongside the other jobs (the Fireflies shape) and never delays them. A pass not done in 60 s yields and resumes next tick from the ledger. It needs no new cron, workflow or public route file (G7). | perf/extend | timed fixture; `cross-app-turn-gate.test.ts` G7 green |

---

## 4. Unanswered correspondence → attention bell

| # | Given / When / Then | Cat. | Observed via |
|---|---|---|---|
| AC-4.1 | Given a Teams item judged to need a reply, then ONE row is written to the existing `chat.email_replies` with a new `kind` (proposed `chat`), status `owed`, and an id prefix that cannot collide with an email short-hash or an `attn-` id. No new table backs the bell. | extend | [DB] `kind='chat'` row; no new bell table |
| AC-4.2 | Given the new kind, then `ATTENTION_KINDS`, `ATTENTION_KIND_LABEL`, `toAttentionItem` and `AttentionBell`'s `KIND_ICON` all include it. **Today `toAttentionItem` returns null for an unknown kind, so without this the row exists and the bell silently never shows it.** | wrong-but-running | [F] `attention.test.ts`: chat row → item; [UI] bell lists it |
| AC-4.3 | Given an owner who SAVED `chat.attention_settings.urgent_kinds` before this ships (a list without the new kind), when the bell renders, then chat items still count and the new checkbox appears. The existing explicit-empty-list rule (owner switched everything off) is still honoured. Without this, `parseUrgentKinds` drops chat for every existing owner. | wrong-but-running | [F] `parseUrgentKinds(["email","meeting","appointment"])` rule tested; [UI] |
| AC-4.4 | Given chat rows exist, when `getEmailReplyCounts`, `listOwedEmailReplies` and `findOwedEmailReplyByFrom` run, then their results are identical to before (they filter `kind='email'`). Iris's "replies owed" tally excludes chat items. | regression | [F]/[DB] counts before = after inserting chat rows |
| AC-4.5 | Given a Teams message from another person asking something, and a LATER message in the same chat id from the owner's configured Teams identity, then no bell item is created, or the open one is settled `replied`. The owner is matched by configured id, never by display name. | happy | [F] |
| AC-4.6 | Given a Teams message with no later message in its chat, when the log is known to export the owner's own messages for that chat (OQ-5), then the item is `owed`. When that cannot be established, the item is `needs_context` and its bell row reads "Can't tell if answered: <missing field>". It never says "unanswered". | edge | [F] two fixtures; [UI] label |
| AC-4.7 | Given a feed EMAIL, when the snapshot holds a later message in the same `conversationId` from the work mailbox, then it settles `replied`. When the snapshot carries no sent mail at all (today's flow exports the Inbox only), then its correspondence status is `needs_context` (`missing_field='sent_items'`). Its existing owed row and Iris alert stay exactly as today (AC-2.7); see OQ-6. | edge | [F] + [DB] |
| AC-4.8 | Given automated or FYI input (bulk header, automated sender, `other-folder`, a Teams bot/app sender, no ask per `asksSomething`), then no bell item is created. Email reuses `screenMessage` unchanged. Chat applies `asksSomething` + `isAutomatedAddress`/app-sender to the chat sender. | edge | [F] one fixture per `ScreenVerdict` reason → 0 rows |
| AC-4.9 | Given one chat where the other person sends 4 questions in a row, then there is ONE open bell item for that chat (newest unanswered message), not 4. One later owner message settles it. | edge | [F] |
| AC-4.10 | Given the owner taps Dismiss in the bell on a chat item, then `dismissAttentionFn` settles it `dismissed` through the existing ownership check, and the next pass does not reopen it. | happy | [UI] + [DB] |
| AC-4.11 | Given a feed bell item, then it shows source, sender/participants, subject or chat name, message time and a short reason, plus a deep link only when the record supplied one. A missing link renders no dead control. | happy | [UI] |
| AC-4.12 | Given any outcome, then nothing is sent: no email, no Teams message, no draft into any mailbox. Graph calls in the pass are GET only. | security | test spy: no `sendMail`, no `POST .../messages` |
| AC-4.13 | Given an open bell item, when the next file shows the owner replied, then the item auto-settles `replied` on that pass with no action in Huddle. | happy | [F] two-pass fixture |

---

## 5. Task proposals as a new row kind in the EXISTING checklist

**What exists today:** `build_checklist` (`tools.ts`) renders `ChecklistPayload {title, rows: ChecklistRow{taskId,title,status,tags}}` on `Message.checklist`. `ChecklistCard` (`HuddleView.tsx`) seeds `checklistState` from the snapshot, then refreshes from `getBoardTasks`. `ChecklistItem.apply` writes through `updateBoardTask` with optimistic `setChecklistRow` / `rollbackChecklistRow`. `stream-context.ts` summarises the checklist to the model. Every row today is an existing journey task. **Proposals become a second row kind in that same payload and card.** There is no new widget, no daily checklist, and no file per day.

| # | Given / When / Then | Cat. | Observed via |
|---|---|---|---|
| AC-5.1 | Given `ChecklistRow`, then it gains an optional `kind: "task" \| "proposal"`. A row with no `kind` (every message already persisted in the thread) renders and behaves exactly as today. | regression | [F] old payload fixture renders identical; existing checklist tests green |
| AC-5.2 | Given a proposal row, then its id is from a proposal namespace (e.g. `prop-<hash>`) that can never equal a journey task uuid. Its `checklistState` entry therefore cannot collide with a task row's. | edge | [F] |
| AC-5.3 | Given a proposal row, when any control is used, then `updateBoardTask` is NEVER called with the proposal id. Proposal actions go to proposal server functions, under the same optimistic `setChecklistRow` → server → `rollbackChecklistRow`-on-failure contract and the same one-write-in-flight `busy` guard. | design | [F]/[UI] network log: no `updateBoardTask` for `prop-*`; failed call → row restored + toast |
| AC-5.4 | Given proposals, then they persist server-side in Azure PG (one table, idempotent bootstrap), owner-scoped by `resolveTaskEmail(caller)`. They survive reload, a second device and a container restart, unlike `checklistState`, which is not persisted. A guessed id from another owner returns "not in your list" (the `getOwnedEmailReply` rule). | happy/security | [DB]; [UI] reload keeps rows; cross-owner call → not found |
| AC-5.5 | Given a proposal, then its state is one of `proposed` \| `approved` \| `completed` \| `dismissed`. Only `proposed` rows are in the ACTIVE queue. A decided row keeps its source reference, normalized text and decision time for audit and dedup. | happy | [DB] |
| AC-5.6 | Given a mounted checklist message containing proposal rows, when it refreshes (stage 2), then proposal rows reconcile from the proposal store, not `getBoardTasks`. A proposal decided elsewhere (another message, another device) shows its decided state here too, and its controls are inert. | edge | [UI] approve in message B → message A shows approved after mount |
| AC-5.7 | Given Approve on a `proposed` row, then the task is created through the EXISTING creation core (`create-task-core.ts`: `normalizeTaskTitle`, `loadOpenTaskTitles` dedup, `screenCapabilityMetaTask`, `screenRawJourneyCreate`) → journey `public.tasks` → the mirror via the sync trigger. There is no raw insert into `public.tasks` or `tasks.journey_tasks`. | extend | code review; [DB] journey row exists; mirror row appears (poll ≤ 30s, the sync is async) |
| AC-5.8 | Given Approve tapped twice, or two devices approving the same row, then exactly ONE journey task exists (compare-and-set `proposed→approved`; the loser returns `alreadyDone`). | edge | [DB] count = 1 |
| AC-5.9 | Given Approve succeeds, then the proposal stores the created journey task id. The row becomes an ordinary task row (`kind:"task"`, that taskId), so done / Doing / Backlog / parking-lot work on it immediately. | happy | [UI] tick it → `updateBoardTask` with the journey id |
| AC-5.10 | Given Approve when the title already matches an OPEN board task (`normalizeTaskTitle` equality), then no second task is created. The proposal resolves as `approved`, linked to the existing task, and the UI says it was already on the board. | edge | [DB] task count unchanged |
| AC-5.11 | Given Edit on a `proposed` row, when the owner changes the text and saves, then the edited text is stored. Approve then creates the task with the EDITED title, and a later re-read of the source does not overwrite the edit. | happy | [DB] + [UI] |
| AC-5.12 | Given Dismiss, then state = `dismissed`, the row leaves the active queue, and the same to-do from the same source is never proposed again on re-read. | happy | [DB] + [F] re-read |
| AC-5.13 | Given Complete ("already done"), then state = `completed`, the row leaves the active queue, and NO open task is created on the board. | happy | [DB] no journey row |
| AC-5.14 | Given the older ContextPanel "Needs your approval" list (client-only `Task.suggested`, `approveTask` flips a lane locally, `skipTask` deletes), then the shipped design names ONE place where proposals are approved. Either that section shows the server proposals with the same actions, or it is documented as a separate, untouched feature in the implementation note. It is never a second list holding the same proposals with different behaviour. | extend | code review + implementation note states which |
| AC-5.15 | Given a new day's extractions, then new proposals are APPENDED to the same active set. The delivered checklist message contains every still-`proposed` row (no cap; the owner rejected caps on this widget). Undecided rows stay until decided (handoff L18, L76). | happy | [DB]; [UI] row count = active proposals |
| AC-5.16 | Given the delivery message (OQ-7), then it reuses the durable-turn path that inbound-email uses (`enqueueTurn` with an idempotent turn id per delivery, `internal:true`, `journey:{enabled:false}`). Re-running the delivery for the same set sends nothing twice, and the turn itself writes no board task. | extend/idempotent | [DB] 1 `pending_turns` row per delivery id; 0 journey rows from the turn |
| AC-5.17 | Given `stream-context.ts`, when a message carries proposal rows, then the model-facing summary marks them as proposals with their state (e.g. `proposed:` vs task status), so an agent never reports a proposal as an existing task. | wrong-but-running | [F] stream-context summary text for a mixed payload |
| AC-5.18 | Given a source with a stated or assigned to-do ("Can you send me the Q3 deck by Friday?"; Fireflies `action_items` "Von to update the budget"), then one proposal with that text is created. Given a source with no stated to-do ("Thanks, see you tomorrow"; an FYI newsletter; a question already answered in the thread), then zero proposals are created. | happy/edge | [F] fixture corpus with expected counts per item |
| AC-5.19 | Given any proposal, then it stores a verbatim evidence span that is a substring of the source's NEW text (after `newTextOnly`/blockquote stripping), plus source kind, source item id (email id / chatId:messageId / Fireflies `meeting_id`) and source timestamp. A proposal whose evidence is not a substring is rejected before storage. This is the mechanical guard against invented tasks. | Tier 1 guard | [F] mutation: feed a model stub returning a paraphrase → 0 rows stored |
| AC-5.20 | Given extraction, then `owner` and `due` are stored ONLY when the evidence span itself names them. "by Friday" is in the span, so due is set and resolved in the owner's TZ. With no date words, due = null. Owner = null unless a person is named in the span. No default owner or due date is ever invented. | Tier 1 | [F] null fields for the no-date fixture; mutation stub inventing a date → rejected |
| AC-5.21 | Given the same source re-read, or the same to-do stated on two runs, then no duplicate proposal is created. The dedup key is `(source, source_item_id, normalizeTaskTitle(text))`, checked against ALL states including decided ones. Also, a to-do equal to an open board task title is not proposed at all. | idempotent | [F] + [DB] |
| AC-5.22 | Given a Fireflies meeting, then transcript proposals read the meeting already queued and processed in `chat.fireflies_meetings` (its `meeting_id` + the fetched summary). The minutes email, the `fireflies-<id>.md` upload, the queue lease and the webhook are byte-unchanged. | extend/regression | `bun scripts/fireflies-minutes.test.ts` + `fireflies-queue-sql.test.ts` green; diff shows no edit to minutes flow |
| AC-5.23 | Given any test or UAT run that exercises Approve, then the proposal text starts with `Test-` (repo hard rule) and the run deletes its journey rows and proposal rows afterwards. Zero remain. | hygiene | [DB] `title ILIKE 'Test-%'` count 0 after cleanup |
| AC-5.24 | Given a checklist with 50 proposal rows, when it mounts, then it paints from the snapshot immediately and the proposal refresh is ONE request (not one per row), completing in < 2 s on the deployed SWA. | perf | [UI] network log + timing |

---

## 6. Feature flag, dev enablement, health, Fireflies unchanged

| # | Given / When / Then | Cat. | Observed via |
|---|---|---|---|
| AC-6.1 | Given `HUDDLE_ONEDRIVE_FEEDS` absent, unparseable, `enabled:false`, or with `teams` absent/disabled, when the heartbeat runs, then the pass makes ZERO Graph calls for Teams, writes ZERO ledger/bell/proposal rows, and posts no checklist message. | flag | test spy: 0 fetches; [DB] 0 rows |
| AC-6.2 | Given the config is valid but the owner-facing enablement control (a Settings toggle, default OFF, stored per owner, the config-centric rule) is OFF, then the same zero-activity result as AC-6.1 holds. Toggle ON with the config absent stays off and shows "OneDrive sources not configured". | flag | [UI] toggle; spy |
| AC-6.3 | Given the correspondence pass and the proposal pass, then each can be enabled independently (bell only, checklist only, both). | flag | [F] config permutations |
| AC-6.4 | Given everything OFF, then the existing email feed behaviour (Iris alerts from `emails.json`), appointments feed, bell and checklist are byte-identical in behaviour to origin/main 207b0b5e. | regression | `onedrive-feed.test.ts`, `inbound-email.test.ts`, `attention.test.ts` green, unmodified expectations |
| AC-6.5 | Given this feature in any state, then `bun scripts/fireflies-minutes.test.ts` and `bun scripts/fireflies-queue-sql.test.ts` pass unchanged. No edit touches the Fireflies webhook route, `saveTranscript`, `TRANSCRIPT_FOLDER`, or the minutes settings. | regression | suite output; `git diff` on those paths empty |
| AC-6.6 | Given any read, then a health view (Settings panel, same place as the mirroring/minutes panels) shows per source: last status (`ok`/`unchanged`/`missing`/`rejected:<reason>`/`error`), checked-at, counts (new, processed, needs_context, failed), and skipped-line count. It shows NO message, subject, sender or transcript text. | ops | [UI] screenshot; content canary absent |
| AC-6.7 | Given a public route file, then none is added or edited (G7 `cross-app-turn-gate`). Work runs from `scheduler.server.ts` (`runDueScheduledJobs`). | guard | `bun scripts/cross-app-turn-gate.test.ts` green |
| AC-6.8 | Given this ships to `main`, then nothing is enabled in prod: no `HUDDLE_ONEDRIVE_FEEDS` change, no toggle flipped, no email sent (handoff L26, L93). | release | SWA app settings unchanged; deploy log |

---

## 7. Dummy-file mode (switch to real files by config only)

| # | Given / When / Then | Cat. | Observed via |
|---|---|---|---|
| AC-7.1 | Given repo fixtures `fixtures/onedrive/huddle-source-log.sample.jsonl` (planned record shape, synthetic, ≥ 1 duplicate line, ≥ 1 malformed line, ≥ 1 owner reply, ≥ 1 stated to-do, ≥ 1 FYI) and an email snapshot sample in the existing envelope, then the offline suite runs the full pass (adapter → ledger → bell → proposals) against them with an in-memory store, and expected counts match. | happy | [F] |
| AC-7.2 | Given the same pure adapter, then the SAME function parses the fixture and a real downloaded file. Moving from dummy to real changes only `HUDDLE_ONEDRIVE_FEEDS` (path, `synthetic`, `subjectPrefix`, Teams fields) and the toggle. There is no code edit or redeploy beyond the settings change. | design | code review: no fixture path referenced from `src/` |
| AC-7.3 | Given the existing `scripts/onedrive-feed-dryrun.ts`, then it is extended (not copied) to read the real Teams file and print verdict counts, skipped-line reasons and field-presence flags (e.g. `has_sender_id`, `has_internetMessageId`, `has_sent_items`). It prints NO ids, names, subjects or bodies (public Actions logs). | extend | dry-run output on fixture; [LOG] canary absent |
| AC-7.4 | Given dummy data uploaded to OneDrive for an end-to-end try, then every subject/text starts with the configured synthetic prefix and every proposal starts with `Test-`, and a cleanup step removes resulting rows. | hygiene | [DB] 0 remaining |

---

## 8. Public repository hygiene

| # | Given / When / Then | Cat. | Observed via |
|---|---|---|---|
| AC-8.1 | Given every new or changed file under `src/`, `scripts/`, `fixtures/`, `docs/`, then no real email address, tenant id, drive id, chat id, flow id or person name appears. Fixtures use `*.example` domains and placeholder ids (the existing `onedrive-feed.test.ts` convention). | security | a test greps new fixtures: every `@` domain ends `.example`; no GUID outside an allow-listed placeholder set |
| AC-8.2 | Given client code, then no source path, mailbox, drive user or Teams identity is hard-coded. All come from the server-only config; the client receives only display data for its own owner. | security | grep `src/features/huddle/components` for `automation/` = 0 |
| AC-8.3 | Given CI or workflow output for this feature, then it prints counts, statuses and domains only (AC-3.8 applies to Actions logs too). | security | workflow log grep for canary |

---

## OPEN QUESTIONS / UNKNOWN UNTIL REAL FILES EXIST

- **OQ-1 Email archive shape.** The handoff says "individual files in `/automation/email`". The code reads one snapshot `emails.json`. Which is real? If it is per-file, the reader must list a folder (new Graph call, paging, cap). That changes AC-2.1/2.2.
- **OQ-2 Synthetic marker for Teams.** The planned record has no `synthetic` field. Synthetic-mode safety (AC-1.9) needs one: a per-line flag, a chat-id allow-list, or a body prefix. Power Automate must emit it.
- **OQ-3 Log growth.** The rolling file only grows. Does the flow trim it (by age or size)? If not, it will hit `maxBytes` (AC-1.8) and the feed stops. The trim policy and the cap need to be agreed.
- **OQ-4 Owner's Teams identity.** Which sender field does the flow emit (AAD object id, UPN, display name)? Reply detection (AC-4.5) needs a stable id in config.
- **OQ-5 Does the log include the owner's own messages** in each chat? If it is inbound-only, every chat item is `needs_context` (AC-4.6), and the bell feature delivers little until that changes.
- **OQ-6 Behaviour change for feed email (owner thumbs-up needed).** Today the email snapshot is Inbox-only, so a work email can only settle by Dismiss. Marking those items "can't tell if answered" (AC-4.7) is a visible change to an existing flow. It needs the owner's 👍, or the flow must also export Sent Items.
- **OQ-7 Where and when the proposal checklist is posted.** Is it in Iris's 1:1 as a checklist message after each 18:00 ET pass, on demand ("show my proposed tasks"), or both? Is there a push? Does a new delivery re-post all active proposals (AC-5.15) or only the new ones? Is a bell item added for "N tasks proposed"?
- **OQ-8 "Completed" semantics.** Does completing a proposal create a DONE task for the record, or only close the proposal (AC-5.13 assumes the latter)?
- **OQ-9 Cross-source dedup.** The same to-do stated in an email AND a Teams chat: one proposal or two? AC-5.21 only dedups within a source item and against the board.
- **OQ-10 Path casing.** Fireflies writes `Automation/transcripts` (capital A); the planned paths use `/automation/...`. Confirm the real casing. Whether Graph path addressing is case-insensitive on OneDrive was not verified this session (no docs opened).
- **OQ-11 Meaning of the record's `pending` status** and whether Huddle should ignore lines that are not `pending`.
- **OQ-12 Edited and deleted Teams messages, and system messages** (S-16): their shape is only knowable from the real sample.
- **OQ-13 Bell badge.** Do `needs_context` items count toward the badge, or show uncounted?

## Gaps (documents that could not be opened this session)

- **G-1** Microsoft Graph `chatMessage` resource reference (`learn.microsoft.com`): DNS blocked by the session allowlist. This blocks spelling rows for `messageType`, `deletedDateTime`, `lastModifiedDateTime`, `from.application` and `body.contentType`.
- **G-2** JSON Lines format (`jsonlines.org`): blocked. This blocks the blank-line and CRLF rows (S-9, S-10).
- **G-3** No real Power Automate sample exists yet. Every Teams field name in this file is the handoff's PLANNED shape.

## Goal → AC coverage

- Teams day's messages read without duplicates → AC-1.1-1.13, S-1-S-16, AC-3.1, 3.5
- Email + Teams processed durably and idempotently → AC-2.1-2.7, AC-3.1-3.10
- Unanswered correspondence in the bell, stored and updated → AC-4.1-4.13
- To-dos from emails/chats/transcripts as a checklist to approve/edit/keep adding/remove → AC-5.1-5.24
- Fireflies keeps working → AC-5.22, AC-6.5
- Off until verified; quick switch with dummy files → AC-6.1-6.8, AC-7.1-7.4
- Public repo safety → AC-8.1-8.3, AC-3.8
- No AC lacks a goal. AC-5.24 and AC-3.10 (performance) are proposed defaults for the owner to confirm.
