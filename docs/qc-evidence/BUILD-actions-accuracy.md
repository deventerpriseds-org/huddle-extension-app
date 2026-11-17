<!--
WHAT:          Build log for the Actions-view accuracy fixes (branch claude_actions-accuracy): sender reversed,
               hallucinated claims, an "AI misread it" Wrong? reason, meeting label lines as rows, cut-off text,
               duplicate rows for one Teams thread.
WHY:           Owner report 2026-11-17 from the live Actions view on his phone ("sender and receiver wrong ...
               hallucination of actions not asked for ... no good option for when the information is just ai
               inaccuracy ... several actions are not actionable ... the text areas don't expand").
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      commits on claude_actions-accuracy; scripts/*.test.ts named below; one azure-pg-query.yml run (counts only).
-->

# BUILD: Actions accuracy

Branch `claude_actions-accuracy`, cut from `origin/main` 80a7cf0e (fetched 2026-11-17).
THIS REPO IS PUBLIC: every example below is synthetic; the live probe printed COUNTS only.

## Log

1. Branch cut. Read `lib/actions/pipeline.ts`, `correspondence/report-from-ledger.ts` (teamsOwnerIds /
   isOwnerMessage / chatFacts), `external-feeds/teams-log.ts` (parseTeamsLog fromOwner / ownerUserId),
   `correspondence/source-item.ts` (teamsSourceItem content hash), `correspondence/ledger.server.ts` (upsert).
   Dispatched ONE counts-only `azure-pg-query.yml` run (SQL in section "Probe" below).

## Probe (one `azure-pg-query.yml` run, 44015118829, job 133811074364, COUNTS ONLY)

SQL: Teams ledger rows with `item_at` in the last 2 days (`t`), the distinct stored `content->>'ownerUserId'` values
over ALL Teams rows (`oid`), and per-chat counts. No content, id or name was selected.

| measure | count |
|---|---|
| Teams rows, last 2 days | 69 |
| ... carrying `ownerUserId` | **0** |
| ... `fromOwner` true / false / null | 0 / 0 / **69** |
| ... with a sender id (all GUID-shaped) | 69 |
| distinct `ownerUserId` over ALL stored Teams rows | 1 |
| recent rows whose sender id IS that stored owner id | **37** |
| chats (1:1 / meeting / group / channel-or-unknown) | 14 (12 / 1 / 2 / 0) |
| chats with no message from the owner id | 2 |
| rows whose `thread_id` differs from `content.chatId` | 0 |
| non-1:1 chats with at most 2 distinct senders | 2 |

### Root cause #1 (sender reversed)

- OBSERVED: 37 of the 69 recent messages were sent by the owner's own Teams id, yet NONE of the 69 rows carries
  `ownerUserId` and every one has `fromOwner: null`. The owner id exists only on OTHER (older) stored rows.
- OBSERVED (code): `teamsOwnerIds(messages, configured)` builds the owner-id set PER CHAT, from that chat's own
  rows only (`chatFacts` / `chatInvolvement` in `report-from-ledger.ts`). Configured `teams.ownerSenderIds` is
  empty in the live config (inferred from `fromOwner` null on all 69 rows: the parser sets it from the configured
  ids first).
- So in a chat whose rows all lack `ownerUserId`, the owner-id set is EMPTY, `isOwnerMessage` is false for the
  owner's own message, it is labelled OTHER, becomes `latestOther`, and the classifier is told someone else
  wrote it. That is the "Ellis, Von asks you ..." row.
- INFERRED (not proven, confidence medium): the Power Automate lines stopped carrying `ownerUserId` (or carry it
  under another key) for the recent captures. Not settled by this probe; settling it means reading one line of
  the live log, which this session does not do. The fix below does not depend on it.
- FIX AT THE SOURCE (every consumer reads `teamsChatsFromLedger`, so the report, Actions and the uninvolved rule
  agree): the owner-id set is built ONCE over ALL stored Teams rows (configured ids + every row's `ownerUserId`),
  not per chat. Last resort, only when NO id is known anywhere: a sender whose display name is one of the owner's
  configured names (`effectiveOwnerNames`, "Last, First" folded) contributes its sender ID, and ids do the rest.

### Root cause #6 (two rows for one ask)

- OBSERVED: no row has a `thread_id` different from its chat id, and no chat is of unknown kind, so one chat id
  never splits into two threads. The second label ("Teams, <name>") is the non-1:1 branch of the label, i.e. a
  DIFFERENT chat (a group or meeting chat) whose Teams name is the member list. 2 such chats have at most 2 senders.
- INFERRED: the same ask was posted in the 1:1 and in a small group chat with the same person; each chat is its
  own thread and each got its own verdict. Both were the owner's OWN message (root cause #1), so with #1 fixed
  neither is a needs-reply item. Belt and braces: open Teams items with the same sender and the same quote, or the
  same backing proposal, collapse to the newest one; a group chat named only after the owner is labelled
  "Teams group chat".
