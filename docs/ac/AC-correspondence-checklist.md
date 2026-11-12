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
