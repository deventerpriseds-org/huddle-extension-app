# VERIFY-actions-cap-tag-rule-1

WHAT:       Independent verification of branch `claude_actions-cap-tag-rule` (head 763bd8f6): daily AI-check cap 150->500,
            the "limit reached" notice, and the team/tag/channel-only mention rule for Teams group chats.
WHY:        Tier-1 change (the rule decides what the owner is shown). Verifier loop 1.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; red-team rows in `VERIFY-actions-cap-tag-rule-1.redteam-rows.ts` (appended to a scratch copy of
            `scripts/report-from-ledger.test.ts` minus its last 2 lines, run with bun). Synthetic data only.

## Claim 1 -- Tier-1 rule: no over-match (owner / @Everyone can never be hidden)

Status: CONFIRMED (38 adversarial shapes, 0 over-matches).

Rule path read: `teams-log.ts` `mentionFacts` + `mentionKind` (L108-160) -> stored `chatWideMention` / `groupMentionOnly`
-> `report-from-ledger.ts` `maybeMentionsOwner` (L234-245) inside `chatInvolvementOf` (L191-204). The owner-mentioned
check (L198) runs BEFORE `maybeMentionsOwner`, so the new exception cannot hide a chat that names the owner.

Graph shape ground truth: `microsoft-graph-docs-contrib/api-reference/v1.0/api/chatmessage-post.md` response Examples 8
(channel) and 9 (team): `mentioned` = `{application:null, device:null, user:null, tag:null, conversation:{...}}`; no
`@odata.type` directly on `mentioned`. Matches the parser's "exactly one non-null variant" assumption.

Observed (`bun` scratch harness):

| row | shape | result |
|---|---|---|
| RT1 | tag + `@odata.type` key on the identity set | SHOW (fail-open; Graph does not emit this key per docs) |
| RT2 | channel, inner `conversationIdentityType@odata.type` key | HIDE |
| RT3 | tag with inner `@odata.type` teamworkTagIdentity | HIDE |
| RT4 | @Everyone, Graph full-null shape | SHOW |
| RT5/6 | @Everyone type `CHAT` / ` chat` | SHOW |
| RT7 | @Everyone empty id | SHOW |
| RT8 | user `{id:null}` alone | SHOW |
| RT9/10 | user `{id:null}` or `{}` + tag in one entry | SHOW |
| RT11 | application, full-null shape | SHOW |
| RT12/13 | `mentioned:null` / every variant null | SHOW |
| RT14 | tag + owner (upper-case, padded id) | SHOW owner_mentioned |
| RT15 | tag + @Everyone in one entry | SHOW |
| RT16 | team + another user | HIDE (per spec) |
| RT17 | owner user + team in one entry | SHOW owner_mentioned |
| RT18 | `<at>` in body only, `mentions: []` | SHOW |
| RT19 | `<at>` with no id + tag | SHOW |
| RT20 | channel post (thread.tacv2), channel mention | HIDE (see note N1) |
| RT21 | channel post, tag, owner wrote | SHOW owner_sent |
| RT22 | msg1 tag-only, msg2 @Everyone | SHOW |
| RT23 | msg1 tag-only, msg2 owner mention | SHOW owner_mentioned |
| RT24 | tag, entry id string "0", body `<at id="0">` | HIDE |
| RT25 | tag in meeting chat | HIDE |
| RT26 | two body `<at id="0">` covered by one tag entry | HIDE (contrived; Graph numbers each `<at>` separately) |
| RT27 | tag value is an array | SHOW |
| RT28 | team + unknown extra non-null key | SHOW |
| RT29 | tag entry with no `id`, body `<at id="0">` | SHOW |
| RT30 | 1:1 with @Everyone | SHOW one_on_one |
| RT31 | stored `groupMentionOnly: "true"` (string) | SHOW |
| RT32 | stored `chatWideMention: null` | SHOW |
| RT33 | stored `mentionedUserIds: "x"` | SHOW cant_tell_no_mention_data |
| RT34 | stored groupOnly + `mentionsOwner: true` | SHOW owner_mentioned |
| RT35 | stored groupOnly + `[OWNER upper-case]` | SHOW owner_mentioned |
| RT36 | stored groupOnly + `&lt;at&gt;` in text, no users | HIDE (the stored flag wins; the `<at` text fallback is for pre-flag rows only) |
| RT36b | stored groupOnly + `mentionedUserIds: [null]` | SHOW |
| RT37 | content hash with flags flipped | equal (`true`) |
| RT38 | parser flags, owner-user + tag | `[mentionsOwner true, unresolved true, chatWide false, groupOnly true]` -> shows via owner_mentioned |

Note N1 (spec interpretation, not a code defect): the owner's decision text names "team or tag" mentions. The build
also hides CHANNEL mentions (MK-R7, MK-R26, RT20). In a channel post, `@<channel>` notifies every channel member, the
same way @Everyone does in a group chat, yet @Everyone SHOWS and @channel HIDES. Consistent with "team mention hides"
(a team mention also notifies him), but it is a reading the owner did not state. Flag for the owner.
