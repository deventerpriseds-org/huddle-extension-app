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

## Shared definitions (used by every section)

- **Owner addresses** = `cfg.mailbox` plus every entry of `cfg.ownerLogins` (`onedrive-feed.ts:138-143`),
  lower-cased and trimmed. Plus an optional new `correspondence.ownerAliases` list (OQ-4). Compared as whole
  addresses, case-insensitive, never as substrings.
- **Owner Teams ids** = `cfg.teams.ownerSenderIds` (`onedrive-feed.ts:194-200`). If that list is empty, the
  ids come from the line's `ownerUserId`, but only when every line agrees on one value. That is the rule the
  preview already uses (`proposals-preview.ts:74-88`), moved into the live parser.
- **Conversation key**: email = `(mailbox, conversationId)`; Teams = `chatId`. An email with no
  `conversationId` is its own conversation, keyed by its message id, and counted as `no_conversation_id`.
- **Classifier** = the new pure function the redesign adds. It takes one conversation and returns exactly
  one **verdict**: `needs_reply`, `replied`, `fyi`, `invite`, `minutes`, `not_addressed`, `automated`
  (bulk header or automated sender), or `cant_tell`. Every count in sections 7 and 8 is a count of these.
  When two apply, the first in this order wins: `automated`, `invite`, `minutes`, `not_addressed`,
  `replied`, `cant_tell`, `needs_reply`, `fyi`.

## R1. Scope: Iris's live email alerts do not change

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-R1.1 | Given the redesign branch, when `git diff origin/main -- src/features/huddle/lib/email/inbound-email.ts` is run, then the bodies of `screenMessage`, `asksSomething`, `newTextOnly`, `isAutomatedAddress`, the `ASK` and `INVITE_SUBJECT` regexes and the `InboundMessage` interface are byte-identical to `origin/main`. | regression | the `git diff` output for those symbols is empty |
| AC-R1.2 | Given a fixed fixture of at least 40 synthetic `InboundMessage`s (covering every row of spelling tables S-A to S-D), when `screenMessage(m, mode, mailbox)` runs for all three modes before and after the change, then every verdict is identical (`keep` and `reason`). | regression | a committed snapshot test that fails on any difference |
| AC-R1.3 | Given the redesign is fully switched on, when `runInboundEmailWatch` runs over a fixture with an invite, a minutes email and a reply inside a thread, then it announces exactly the same messages, with the same turn ids (`inboundEmailTurnId`), as with the redesign switched off. | regression | a test comparing the two runs' enqueued turn ids |
| AC-R1.4 | Given the classifier needs recipients (F-4), when it is built, then it reads `toRecipients` / `ccRecipients` from the ORIGINAL feed record (or from a new field on `SourceItem`, `source-item.ts:39-56`), and `InboundMessage` gains no field. | regression | `git diff` on `inbound-email.ts` is empty |
| AC-R1.5 | Given the classifier, when its source is grepped, then it never calls `screenMessage` and never passes a subject to `asksSomething`. It may call `asksSomething({subject:"", bodyText})` for body text only, so the `INVITE_SUBJECT` clause (F-3) can never fire. | regression | grep, plus a unit test: subject `"Re: quick invite question"`, body `"Thanks, all set."` gives no ask |
| AC-R1.6 | Given `scripts/proposals-preview.ts` after the change, when it is grepped, then it no longer uses `screenMessage` or `INBOUND_EMAIL_MODE_DEFAULT` to decide "open" (F-2). It uses the classifier only. | regression | grep |

**Push-back on rule 1.** "The redesign covers the bell, not the live alerts" cannot hold as written for email.
The email bell rows ARE the live alerts' rows (F-6): one row per alerted message, and that row drives the alert
card's Draft reply / Dismiss actions. Changing which email rows exist changes the alert card. This is **OQ-2**.
Until the owner answers it, these ACs treat the **email bell** as out of scope and put a separate flag in
place for it (AC-R9.4). The Teams bell rows (`bell.ts`, kind `chat`) are in scope.

## R2. One item per conversation; a later owner reply settles the whole thread

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-R2.1 | Given 4 inbox messages with the same `conversationId` (A asks at t1, B writes "+1" at t2, A asks again at t3, C writes "thanks" at t4), when the classifier runs, then it returns ONE conversation item, and the report lists it once. | happy-path | classifier test: output length 1 |
| AC-R2.2 | Given the same thread, when the decision is made, then it uses the **latest message not from the owner** (t4, "thanks", no ask): verdict `fyi`, not `needs_reply`, even though t1 and t3 asked. | happy-path | verdict `fyi` |
| AC-R2.3 | Given A asks at t1 and B (not the owner) answers it at t2 with no new ask, when classified, then the verdict is `fyi`. | edge | verdict `fyi` |
| AC-R2.4 | Given A asks at t1 and the Sent Items file holds a message in the same `conversationId` sent at t2 > t1, when classified, then the verdict is `replied` (extends `sentReplySettles`, F-8; no second settle rule). | happy-path | verdict `replied` |
| AC-R2.5 | Given A asks at t1, the owner sends at t2, and B asks something NEW at t3 > t2, when classified, then the verdict is `needs_reply` and the item's ask is the t3 message. | edge | verdict + ask message id |
| AC-R2.6 | Given the owner's own reply appears in the INBOX file (`from` = an owner address) and Sent Items does not have it, when classified, then that message counts as an owner message and settles earlier asks. | edge | verdict `replied` |
| AC-R2.7 | Given the Sent Items file is missing, rejected or has no usable times, when a conversation would be `needs_reply`, then its verdict is `cant_tell` (reason `no_sent_items`). It appears in the counts line, never in the reply list. | error | verdict + reason |
| AC-R2.8 | Given a zoneless sent time (`2026-11-10T10:00:00`), when compared, then it is read as UTC (`parseUtcMs`, `onedrive-feed.ts:105`), the same as `mapSentRecords`. | edge | unit test at a timezone boundary |
| AC-R2.9 | Given a conversation's messages arrive in two snapshots (t1 Monday, t3 Tuesday), when the second pass runs, then the decision uses every message of that conversation the pass holds text for, and t1 never makes its own row. | edge | ledger test with two file versions |
| AC-R2.10 | Given a Teams chat with 3 asks in a row and no owner message after them, when classified, then ONE item, the newest ask. This is today's `decideChatThread` (`bell.ts:42-55`): reuse it, don't fork it. | regression | the existing section J tests stay green; no second chat-decision function in the diff |
| AC-R2.11 | Given the owner posted in a chat after its last ask, when classified, then `replied`, and the `chat` bell row is settled (`settleChatAttention`). | regression | existing test |
| AC-R2.12 | Given the preview report, when it decides a chat, then it passes the real per-chat owner-presence value, not the constant `true` (F-17), so its chat verdicts equal the live bell's. | regression | test: same fixture, report verdict == bell verdict |
| AC-R2.13 | Given a forward (`Fw:` / `Fwd:`) that Outlook gave a NEW `conversationId`, when classified, then it is its own conversation. Grouping is by `conversationId` only, never by cleaned subject. | edge | two items for an original + its forward |

**Push-back on rule 2.** "The latest message from someone else asks the owner something" is weaker than it
sounds in a group thread: the latest message may ask a DIFFERENT person. AC-R3.7 applies the addressing test to
the latest message, not just to the conversation as a whole.

## R3. Addressed to the owner

**How "individually addressed" is decided (email).** Split `toRecipients` and `ccRecipients` into addresses.
The field is a STRING of unknown format, so accept `;` or `,` as separators, display names (`Name <addr>`,
`"Last, First" <addr>`) and bare addresses. A comma inside a quoted name must not split. Compare each address
with the owner addresses.

| Owner position | Other named people? | Result |
|---|---|---|
| On To, alone | none | **direct** |
| On To | yes | **group, includes owner** |
| On CC only | any | **group, includes owner** (subject to OQ-3) |
| Not on To or CC | any | **not addressed**: distribution list, mailing list, BCC, or mass mailing |
| To and CC both empty or missing | n/a | **not addressed**, reason `no_recipients` (BCC or "undisclosed recipients") |

A distribution list that delivers to the owner shows only the LIST address on To, so the owner's address is
absent and the result is "not addressed". This works without knowing which addresses are lists.

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-R3.1 | Given `toRecipients: "owner@work.example"`, when parsed, then the owner is `direct`. | happy-path | unit test |
| AC-R3.2 | Given `toRecipients: "Pat Doe <pat@work.example>; Owner Name <OWNER@Work.Example>"`, when parsed, then the owner is `group`. Case does not matter. | happy-path | unit test |
| AC-R3.3 | Given `toRecipients: "\"Doe, Pat\" <pat@work.example>, owner@work.example"`, when parsed, then there are 2 addresses, not 3. | edge | unit test: address count 2 |
| AC-R3.4 | Given `toRecipients: "dl-all@work.example"` and no owner address on CC, when classified, then `not_addressed`, even when the body asks a question. | happy-path | verdict |
| AC-R3.5 | Given `toRecipients: "owner@work.example.evil.test"` or `"notowner@work.example"`, when parsed, then the owner is NOT found. Whole-address match only. | edge (over-match) | unit test |
| AC-R3.6 | Given the recipients field arrives as an array of `{emailAddress:{address}}` (Graph's own shape), when parsed, then each item goes through `parseAddress` (`onedrive-feed.ts:378`) and the answer equals the string form's. | edge | unit test, both shapes |
| AC-R3.7 | Given a thread where the owner was on To of the first message, but the LATEST non-owner message has the owner on neither To nor CC, when classified, then `not_addressed`. | edge | verdict |
| AC-R3.8 | Given a message addressed to the owner that carries `List-Id`, `List-Unsubscribe`, `Precedence: bulk/list/junk` or `Auto-Submitted` other than `no`, when classified, then `automated`. Same header names as `screenMessage:191-197`, without calling it. | edge | verdict |
| AC-R3.9 | Given the owner address list is empty (should be impossible: `parseFeedsConfig` returns null), when the classifier runs, then every email is `cant_tell`, never `not_addressed` and never `needs_reply`. Fail closed. | error | verdict |
| AC-R3.10 | Given a Teams message in any chat of the owner's own log, when classified, then it is addressed. The log only holds chats the owner is in (`proposals-preview.ts:67-68`). | happy-path | verdict is not `not_addressed` |
| AC-R3.11 | Given a Graph mention whose `mentioned.user.id` is an owner Teams id, when parsed, then the message gets `mentionsOwner: true` (new optional field on `TeamsMessage`). A mention of a `conversation` (the whole chat or channel) or a `tag` does NOT set it. | happy-path | parser test |
| AC-R3.12 | Given no line in the log has a `mentions` array, when parsed, then `mentionsOwner` is `null` (unknown), not `false`, and the counts line names `mentions_field_absent`. | edge | parser test |
| AC-R3.13 | Given a chat, when it is labelled `one_to_one` / `group` / `meeting_chat` / `unknown`, then the label uses only the chatId shape, the number of distinct non-owner senders for that chat across the whole log, and `chatName`. It never claims a member count. | edge | one unit test per row of table S-E |

**What can and cannot be known about Teams chats (no member list, F-9).**

| Question | Knowable? | How |
|---|---|---|
| Is the owner in the chat? | Yes | the log holds the owner's own chats |
| 1:1 or group? | Usually | Common Graph chat-id shapes: 1:1 `19:<guid>_<guid>@unq.gbl.spaces`; group `19:<hex>@thread.v2`; meeting `19:meeting_<id>@thread.v2`. **UNVERIFIED** against this log, needs probe P-3. Fallback: 2+ distinct non-owner senders means group. |
| How many members? | No | not in the file |
| Was an ask in a group chat aimed at the owner? | Only with an @mention | needs `mentions` (AC-R3.11) |

**Push-back on rule 3 for Teams.** Every chat in the log includes the owner, so rule 3 filters out almost nothing
in Teams. The useful filter in a group chat is "was the latest ask aimed at me". Recommended default: in a
`group` or `meeting_chat`, an ask is `needs_reply` only when it @mentions the owner, OR it has no @mention
of anyone and the chat has 2 or fewer distinct non-owner senders. Otherwise it is `fyi`. This is **OQ-5**,
because it changes Teams bell rows that exist today.
