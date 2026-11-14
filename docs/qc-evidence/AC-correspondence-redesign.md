<!--
WHAT:          Acceptance criteria for the redesign of Huddle's correspondence "needs you" logic: one item per
               conversation, addressed-to-the-owner only, invites and minutes excluded, meeting action items
               reach the owner only through a triage ping, and a three-list preview report.
WHY:           Owner 2026-11-14, after a preview report listed 41 "open" emails: minutes, mass mailings,
               invites and earlier replies in the same thread were each listed as a separate thing to answer.
SUPERSEDES:    nothing. Extends docs/ac/AC-correspondence-checklist.md (branch claude_ac-correspondence-checklist);
               it does not replace it.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      written cold from code at origin/claude_task-proposals @ ddc7b55d (file:line cited per AC).
               Independent AC pass; no implementation was done.
-->

# Acceptance Criteria: correspondence "needs you" redesign

Task: change how Huddle decides what correspondence (work email + Teams) needs the owner. One item per
conversation. Only things addressed to the owner. Invites and minutes are never reply items. Meeting
action items reach the owner only through a triage ping. The preview report shows three lists.

**Synthetic data only.** Every name, address and id below is made up (`owner@work.example`, `dl-all@work.example`,
`19:aaaa@thread.v2`). This repo is public.

## 0. Sources read, and what the code does today

Read at `ddc7b55d`. Each finding below is something an AC depends on.

| # | Observation (file:line) | Why it matters for these ACs |
|---|---|---|
| F-1 | `scripts/proposals-preview.ts:222-235` builds the email list **one row per message**, not per conversation. | This is the direct cause of "replies in the same email listed separately". |
| F-2 | `scripts/proposals-preview.ts:226,231` decides "open" with `screenMessage(...)`, which is **Iris's live alert screen**. | The report and the live alerts share one rule. The owner wants them separate, so the report needs its own rule and the live screen must stay as it is. |
| F-3 | `inbound-email.ts:70` `INVITE_SUBJECT` and `:171`: any subject starting `Invitation`/`Updated invitation`/`Meeting request`, or containing the word `invite`, **always counts as an ask**. | Invites are flagged as "needs you" on purpose in the live screen. The redesign must not use this clause and must not edit it (rule 1). |
| F-4 | `onedrive-feed.ts:460-495` `mapFeedMessage` keeps sender, subject, body, headers, conversation id. It **drops** `toRecipients`, `ccRecipients`, `replyTo`, `importance`, `hasAttachments`. | Rule 3 (addressed to the owner) cannot be decided from `InboundMessage`. The data must come from the original feed record. |
| F-5 | `inbound-email.ts:30-48` `InboundMessage` is the type `screenMessage` takes. | Adding fields to it risks the live screen. Recipients belong on the correspondence side (see AC-R1.4). |
| F-6 | `email-replies.server.ts:106-135` `recordOwedEmail` writes **one email bell row per alerted message**. It is called from the live inbox watch (`inbound-email.server.ts:175`). | The email rows in the "Needs you" bell are a by-product of Iris's live alerts. This **conflicts** with "the redesign covers the bell but not the alerts". See OQ-2. |
| F-7 | `bell.ts:87` the correspondence bell processor handles **Teams only**. `bell.ts:42-55` `decideChatThread` already decides per chat: newest ask after the owner's last message. | Teams already follows rule 2. Email does not. |
| F-8 | `onedrive-feed.ts:354-369` `sentReplySettles` / `latestSentByConversation`: a sent message in the same `conversationId`, later than the email, settles it. | The thread-level settle for email already exists per row. Extend it, don't add a second one. |
| F-9 | `teams-log.ts:239-252` maps each message to `TeamsMessage` (`source-item.ts:24-37`). There is **no `mentions` field** and no member list. `ownerUserId` on each line is **not read** by the parser. The owner is identified only through `cfg.teams.ownerSenderIds` (`teams-log.ts:248`). | An @mention of the owner cannot be detected today. |
| F-10 | `proposals.ts:73-97` `proposalSourceFromItem`: one proposal source **per message**. Email is screened with `screenMessage(m,"people",...)` (`:77`). The owner's own Teams messages are skipped (`:91`). | Per-message extraction means "cumulative action items" from every message, and it also reuses the live screen (F-2). |
| F-11 | `proposals.ts:126-131`: the extraction schema already returns `assignee` ("the person the evidence NAMES as doing it"). `proposals.ts:409` `groundedAssignee` keeps it only when the evidence names that person. | The data needed to drop "someone else's" items already exists. Today it is **displayed** (`proposals-preview.ts:204`, "for X") and never used to filter. |
| F-12 | `engine.ts:177-210` `runTranscriptProposals` turns every finished Fireflies meeting's `action_items` + overview (`proposals.ts:101-110`) **straight into proposals**, with no owner triage. Driven from `proposals.server.ts:101-140`. | This is exactly the "automatic to-do from minutes" the owner rejects. It must change. It is on an unmerged branch, switched off. |
| F-13 | `proposals-store.server.ts:28-61`: `chat.task_proposals` (`state` CHECK `proposed/approved/completed/dismissed`, `:31`) and `chat.task_proposal_refs` (`source` CHECK `email/teams/transcript`, `:55`). Both use `CREATE TABLE IF NOT EXISTS`. | The meeting queue must live here (rule 5). A new state means a CHECK change, and `IF NOT EXISTS` will **not** update the CHECK on a table that already exists. |
| F-14 | `seed.ts:99-113` `ChecklistRow.kind?: "task" \| "proposal"`, with `proposal?: ProposalRowInfo`. `ProposalChecklistItem.tsx` has Approve, Edit (an inline text `<input>`, `:120-129`), Mark done, Dismiss. `proposals.ts:780-821` `sanitizeChecklistPayload` keeps only known kinds. | The widget already has an inline free-text input and a dismiss. Triage is a small extension, not a new widget. |
| F-15 | `minutes.ts:280-284` Huddle's own minutes email subject is `Meeting Minutes: <theme> <date>` or `Updated Meeting Minutes: ...`. `minutes-store.server.ts:34-50` `chat.fireflies_meetings` is keyed by `meeting_id` with `content_hash`. | Gives a known spelling to exclude, and a per-meeting idempotency key for the ping. |
| F-16 | `minutes.ts:168`: Fireflies `action_items` is read as **free text** (`asText`). Nothing parses it into separate items or people. | The ping needs one row per action item. How Fireflies writes that text is **not known from code**. It needs a counts-only probe (AC-R5.2). |
| F-17 | `proposals-preview.ts:238` calls `decideChatThread(msgs, true)`, which always claims the owner's messages are present. | The report can show a chat as "open" where the live bell would say "can't tell". |
| F-18 | `ingest-pass.ts:97-99` `activeProcessors`: each processor has its own flag. `onedrive-feed.ts:205-224` `correspondenceFlags`: every flag is OFF unless literally `true`. | The pattern the new flags must copy (AC-R9). |

**Reading notes.** The `ownerLogins` + `mailbox` pair (`onedrive-feed.ts:138-143`) is the only owner-address
data. There is no alias list. Teams group vs 1:1 has no direct field (F-9). Section 3 covers this.
