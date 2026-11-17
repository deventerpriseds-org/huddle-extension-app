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

## Claim 2 -- the cap and the "limit reached" notice

| sub-claim | status | observed |
|---|---|---|
| default is 500 | CONFIRMED | `bun -e`: `DAILY_CAP_DEFAULT` 500, `resolveActionsSettings(null).dailyCap` 500 |
| the OWNER's live cap becomes 500 | UNPROVEN (see D1) | `resolveActionsSettings({dailyCap:150}).dailyCap` = 150; live row not read (no DB access by brief) |
| `usedTodayFor` is the single count | CONFIRMED (read) | `actions.server.ts:115` defines it; heartbeat `:169` and page `:320` both call `usedTodayFor(cfg.ownerLogins, now, s.timeZone)`; both read `settingsFor(cfg.owner)` |
| notice exactly at cap, only then | CONFIRMED | used 499/500 -> null (left 1); 500/500 -> shown (left 0); 501/500 -> shown; 0/0 -> shown (left 0); sorting off -> null; count unreadable (null) -> null |
| notice names the real setting | CONFIRMED (read) | text "... open What shows → Sorting → Daily limit on this page."; `ActionsView.tsx:219` button "What shows", `:794` heading "Sorting", `:800` label "Daily limit", input `onBlur -> onChange=saveSettings (:223) -> setActionsSettingsFn (:155) -> load()` refetch, so the notice recomputes after a save |
| tokens only | CONFIRMED | added lines grep for `#hex / rgb( / hsl( / oklch( / text|bg|border-<palette>` -> none; `border-warning/40 bg-band-cream text-foreground` all map to `--color-*` in `src/styles.css:45,53` |

D1 (MEDIUM, disclosed by the builder at BUILD doc L167-170): `saveActionsSettings` (`actions.server.ts:336-345`) and the
"stop flagging this list" path (`:362-366`) store the WHOLE resolved settings object, so any What-shows change or
list-stop made before this deploy wrote `dailyCap: 150` into `chat.attention_settings.actions_settings`, and
`resolveActionsSettings` keeps that 150. Repro: `resolveActionsSettings({dailyCap:150, hiddenSenders:["x@example.com"]}).dailyCap`
-> 150. Effect: the owner's decision "150 -> 500" may not reach him; the new notice would then say "150 of 150" and
point him at the field. Not fixable in code without a one-off data change or treating a stored 150 as "default";
needs the owner's call or a read of the live row.

## Claim 3 -- suites, tsc, build (branch head 763bd8f6)

CONFIRMED. `bun scripts/<x>.test.ts`: actions-view 90/0, actions-view-server 28/0, report-from-ledger 103/0,
correspondence-ingest 186/0, fireflies-list 9/0 (matches the builder's 90/28/103/186/9). `npx tsc --noEmit` exit 0 (0
`error TS`). `npm run build` exit 0.

## Claim 4 -- mutation proofs (verifier's own, `mutate.sh`, anchors in files, exit code read)

| # | file | mutation | named test | result |
|---|---|---|---|---|
| V1 | report-from-ledger.ts | `groupOnly` ignores `chatWideMention === false` | MK-S3 | exit 0, FIRED (control EQUIVALENT) |
| V2 | teams-log.ts | `mentionKind`: `t === "chat"` returns "group" (@Everyone hideable) | MK-R5 | exit 0, FIRED (control EQUIVALENT) |
| V3 | actions.ts | `capNotice`: `<` -> `<=` (off by one) | CAP-4 GUARD | exit 0, FIRED (control EQUIVALENT) |
| V4 | teams-log.ts | `mentionKind`: `present.length !== 1` -> `< 1` (two variants accepted) | MK-R14 | exit 0, FIRED (control EQUIVALENT) |
| V5 | actions.ts | `DAILY_CAP_DEFAULT` 500 -> 150 | CAP-1 | exit 0, FIRED (control EQUIVALENT) |

Every run restored the file to HEAD (`restored: ... matches HEAD`).

## Claim 5 -- test merge of origin/main

CONFIRMED, no conflict. `git rev-list --left-right --count origin/main...origin/claude_actions-cap-tag-rule` = `0 4`;
`git merge-base --is-ancestor origin/main <branch>` true (origin/main 80a7cf0e). `git merge origin/main` exit 0 and HEAD
stayed 763bd8f6, so the merged tree IS the tree the suites above ran on (no re-run needed: identical bytes).

## Claim 6 -- the Actions classifier uses the same rule

CONFIRMED (read). `runActionsClassify` (`actions.server.ts:166`) and `getActionsPage` (`:302`) both call
`assembleLedgerPlan` -> `teamsChatsFromLedger` (`report-from-ledger.ts:587`) -> `chatFacts` -> `chatInvolvement` (`:316`).
No other caller of `maybeMentionsOwner` / `chatInvolvement` in `src/`.

## Not run

- UI in a browser: the notice band and "Change limit" button were verified by reading `ActionsView.tsx` only. The
  branch is not deployed and this pass was told not to dispatch workflows, so no Playwright run. UI-UNVERIFIED: 1.

## Verdict

MERGE-PENDING-UAT. No code defect found in the rule or the cap. Owed after landing: a browser run showing the
notice at the cap and absent below it. Owner items: D1 (a stored `dailyCap: 150` keeps him at 150) and N1 (channel
mentions hide, though his decision named only team and tag).
