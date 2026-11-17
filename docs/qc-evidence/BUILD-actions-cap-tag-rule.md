# BUILD -- Actions daily-cap 500 + notice, and the team/tag/channel mention rule

```
WHAT:          Build log for two owner decisions of 2026-11-17: (1) the Actions classifier's daily AI-check cap
               default goes 150 -> 500, and the Actions page says when the cap is hit and where to change it;
               (2) a Teams group / meeting / channel chat whose ONLY mention is a team, tag or channel mention is
               HIDDEN by the uninvolved-chat rule (it used to show).
WHY:           Owner decision 2026-11-17. 150 checks/day ran out with no explanation on the page; group chats kept
               showing because a team/tag/channel mention (never aimed at him) counted as "maybe mentioned".
SUPERSEDES:    nothing. Changes the rule recorded in docs/qc-evidence/BUILD-report-from-ledger.md (verifier loop 1,
               finding 1: "any mention that names no user SHOWS") for team / tag / channel mentions only.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      scripts/report-from-ledger.test.ts (MK-*), scripts/actions-view.test.ts (CAP-*, MK-A*), this file.
```

Branch `claude_actions-cap-tag-rule`, from `origin/main` 80a7cf0e. Synthetic ids and text only.

## Step 0 -- baseline (before any change, 80a7cf0e)

| suite | pass | fail |
|---|---|---|
| `bun scripts/actions-view.test.ts` | 82 | 0 |
| `bun scripts/actions-view-server.test.ts` | 26 | 0 |
| `bun scripts/report-from-ledger.test.ts` | 62 | 0 |
| `bun scripts/correspondence-ingest.test.ts` | 186 | 0 |
| `bun scripts/fireflies-list.test.ts` | 9 | 0 |

## Step 1 -- facts found (read, not recalled)

- Cap default: `DAILY_CAP_DEFAULT = 150` in `src/features/huddle/lib/actions/actions.ts`; max `DAILY_CAP_MAX = 2000`.
- Override: `ActionsSettings.dailyCap`, stored in `chat.attention_settings.actions_settings`, resolved by
  `resolveActionsSettings`.
- **The cap is ALREADY a number field in the owner's settings**: Actions page -> "What shows" button -> "Sorting"
  heading -> "Daily limit ... AI checks a day" (`WhatShows` in `ActionsView.tsx`). No new field or table needed.
- Count used: `actionCallsToday` (actions.server.ts) = recorded ATTEMPTS since the owner's local midnight (D2), never
  fewer than verdicts stored today. The heartbeat already computes it; the page read did not return it.
- Existing notice anatomy reused: PolishView's "You edited the polished text..." band:
  `border-b border-warning/40 bg-band-cream ... text-warning-foreground` (tokens only, no raw colours).
  `FallbackBanner.tsx` was NOT reused: it is raw `amber-*` colours.

## Step 2 -- SPELLING TABLE: Graph chatMessage mention shapes -> SHOW / HIDE (written BEFORE code)

Sources (Graph's own documentation, read from its source repo `microsoftgraph/microsoft-graph-docs-contrib` @ main,
because `learn.microsoft.com` does not resolve from this session):

- **G1** `api-reference/v1.0/resources/chatmessagemention.md`: `id` Int32 "Matches the {index} value in the
  corresponding `<at id="{index}">` tag in the message body"; `mentioned` chatMessageMentionedIdentitySet "The entity
  (user, application, team, channel, or chat) that was @mentioned".
- **G2** `api-reference/v1.0/resources/chatmessagementionedidentityset.md`: `application`, `conversation`
  (teamworkConversationIdentity, "a conversation (for example, team, channel, or chat)"), `device` ("Not used because
  it's not supported to @mention devices"), `user`.
- **G3** `api-reference/beta/resources/chatmessagementionedidentityset.md`: adds `tag` (teamworkTagIdentity, "a tag
  @mentioned in a team message"). `teamworktagidentity.md`: `id`, `displayName`.
- **G4** `api-reference/v1.0/resources/teamworkconversationidentity.md`: `conversationIdentityType` "The possible
  values are: `team`, `channel`, `chat`, and `unknownFutureValue`"; `id`; `displayName`.
- **G5** `api-reference/v1.0/api/chatmessage-post.md` Example 8 (@mention a channel) and Example 9 (@mention a team):
  the response carries the OTHER variants as explicit `null` (`"application": null, "device": null, "user": null,
  "tag": null, "conversation": {..., "conversationIdentityType": "channel"}`).
- **G6** owner decision 2026-11-17 (this task's brief): @Everyone (a conversation mention of the chat itself) IS aimed
  at him; team / tag / channel not aimed at him HIDE; no tag-membership data exists, so a tag is "not aimed at him";
  malformed / unreadable SHOWS unless provably team / tag / channel; old rows without kind info SHOW.

Context for every row unless stated: a GROUP chat (`19:...@thread.v2`), the owner's id known, the owner never wrote,
every message has mention data. "SHOW" = `chatInvolvement(...).hide === false`.

| # | mention shape (one message unless stated) | verdict | reason | source |
|---|---|---|---|---|
| R1 | `user.id` = the owner's id | SHOW | owner_mentioned | G1, G2, G6 |
| R2 | `user.id` = another user's id only | HIDE | uninvolved (unchanged) | G2 |
| R3 | `user.id` empty / whitespace / a number / `user: null` and nothing else | SHOW | can't tell who | G2, G6 (fail open) |
| R4 | `application: {id}` (a bot) | SHOW | not covered by the decision; unchanged | G2, G6 |
| R5 | `conversation: {id, conversationIdentityType: "chat"}` (@Everyone) | SHOW | chat-wide = aimed at him | G4, G6 |
| R6 | `conversation: {id, conversationIdentityType: "team"}` | HIDE | team mention | G4, G5 Ex.9, G6 |
| R7 | `conversation: {id, conversationIdentityType: "channel"}` | HIDE | channel mention | G4, G5 Ex.8, G6 |
| R8 | `conversation` with `conversationIdentityType: "unknownFutureValue"` | SHOW | not provably team/channel | G4, G6 |
| R9 | `conversation` with no `conversationIdentityType` | SHOW | not provably team/channel | G4, G6 |
| R10 | `conversation` type `"team"` but `id` empty / missing | SHOW | malformed | G4, G6 |
| R11 | `tag: {id, displayName}` | HIDE | tag; no membership data | G3, G6 |
| R12 | `tag` with empty / missing `id` | SHOW | malformed | G3, G6 |
| R13 | Graph's real channel shape: `user/tag/application/device: null` + `conversation` channel | HIDE | explicit-null siblings are not variants | G5 Ex.8 |
| R14 | two non-null variants in one entry (`tag` object AND `conversation` object) | SHOW | ambiguous | G2, G6 |
| R15 | `device: {id}` | SHOW | not supported by Graph -> unreadable | G2, G6 |
| R16 | `conversationIdentityType: "Team"` (wrong case) | SHOW | not a documented value | G4, G6 |
| R17 | body `<at id="0">` with NO `mentions` entry | SHOW | unexplained mention | G1, G6 |
| R18 | body `<at id="0">` matched by a `tag` mention with `id: 0` | HIDE | the `<at>` is the tag | G1, G3 |
| R19 | `tag` at id 0 + body `<at id="1">` with no entry | SHOW | unexplained mention | G1, G6 |
| R20 | **mix**: `tag` + `user.id` = owner | SHOW | owner_mentioned | G6 |
| R21 | **mix**: `tag` + `conversation` chat (@Everyone) | SHOW | chat-wide | G6 |
| R22 | **mix**: `tag` + `application` | SHOW | the app half is unreadable | G6 |
| R23 | a `null` entry / an entry with no `mentioned` | SHOW | malformed | G6 |
| R24 | legacy shape the parser never documented: `mentioned: {team: {...}}` / `{channel: {...}}` | SHOW | not Graph's shape -> unreadable | G2, G6 |
| R25 | meeting chat (`19:meeting_...`), team mention only | HIDE | same rule as group | G6 |
| R26 | channel chat (`@thread.tacv2`), channel mention only | HIDE | same rule as group | G6 |
| N1 | **over-match negative**: 1:1 chat with a tag mention | SHOW | one_on_one (always shows) | G6 |
| N2 | **over-match negative**: group chat, tag mention, the owner wrote | SHOW | owner_sent | G6 |
| N3 | **over-match negative**: tag-only message + another message with no mention data | SHOW | cant_tell_no_mention_data | G6 |
| N4 | **over-match negative**: tag-only message + no owner id known | SHOW | cant_tell_owner_unknown | G6 |
| S1 | stored OLD row: `unresolvedMention: true`, no kind fields | SHOW | can't tell the kind -> fail open | G6 |
| S2 | stored new row: `unresolvedMention: true, groupMentionOnly: true, chatWideMention: false` | HIDE | | G6 |
| S3 | stored inconsistent: `groupMentionOnly: true, chatWideMention: true` | SHOW | chat-wide wins | G6 |
| S4 | stored: `groupMentionOnly: true` but `chatWideMention` absent | SHOW | kind info incomplete | G6 |
| S5 | stored: `groupMentionOnly: true` + a `""` in `mentionedUserIds` | SHOW | unreadable user entry | G6 |
| S6 | two stored messages: one new tag-only (S2), one OLD unresolved (S1) | SHOW | the old one can't be told apart | G6 |
| H1 | the content hash is unchanged by the new stored fields | -- | nothing re-processes | brief |

Stored shape (the brief's per-kind flags), written by the parser whenever it has a `mentions` array:
- `unresolvedMention` keeps its EXACT old meaning (any mention naming no comparable user, including @Everyone and
  team/tag/channel). Kept on purpose: if this change is reverted, the old reader still SHOWS every new row.
- `chatWideMention: boolean` -- some mention was a conversation mention of type `chat` (@Everyone).
- `groupMentionOnly: boolean` -- `unresolvedMention` is true AND every unresolved mention is a team / channel / tag
  mention (no @Everyone, no app, no malformed entry, no unexplained `<at>`).
- The rule hides on an unresolved mention ONLY when `groupMentionOnly === true && chatWideMention === false`.
