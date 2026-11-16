# VERIFY-report-from-ledger-1

WHAT:       Independent verification (loop 1) of PR #257, merged as ece03e60 (report from the Azure ledger,
            uninvolved-chat rule, resolution rule, Teams mentions stored, Fireflies date-range back-fill).
WHY:        Tier-1 gate path (decides what the owner's report hides). Builder claims need a cold read.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; base origin/main 046ec493 (contains ece03e60).

Public repo: no content, names, ids or addresses below. Synthetic fixtures only.

## Suites (run on 046ec493, worktree)

| suite | result |
|---|---|
| bun scripts/report-from-ledger.test.ts | 39 passed, 0 failed, rc=0 |
| bun scripts/fireflies-list.test.ts | 7 passed, 0 failed, rc=0 |
| bun scripts/correspondence-ingest.test.ts | 186 passed, 0 failed, rc=0 |
| bun scripts/correspondence-ledger-sql.test.ts (real local PG 16/17 via initdb) | 76 passed, 0 failed, rc=0 |
| npx tsc --noEmit | rc=0 |

## Claims

### Claim 1 -- uninvolved-chat rule: REFUTED (on two inputs), otherwise holds

Probe: `VERIFY-report-from-ledger-1.probe1.ts` (synthetic ids only), run with bun against 046ec493.

Spelling table (Graph chat id shapes + mention shapes) and observed verdicts:

| input | expected | observed |
|---|---|---|
| `19:a_b@unq.gbl.spaces` / upper-case | 1:1, show | one_on_one, show -- PASS |
| `19:x@thread.v2` | group | group -- PASS |
| `19:meeting_...@thread.v2` | meeting (checked before group) | meeting -- PASS |
| `19:x@thread.tacv2` | channel, show | not_group_or_meeting, show -- PASS |
| `@thread.skype`, URL-encoded `19%3A..%40thread.v2`, trailing space, `48:notes`, `@thread.v2.evil` | unknown, show (fail open) | unknown, show -- PASS |
| owner cfg `"  OWNER-9 "`, sender `owner-9`, fromOwner=false | show owner_sent | PASS |
| stored ownerUserId upper-case | show owner_sent | PASS |
| prefix collision `owner-9` vs `owner-90` (sender and mention) | hide (no false match) | PASS |
| mention id upper-case | show owner_mentioned | PASS |
| mentions absent on one message | show cant_tell | PASS |
| mentions `null` | show cant_tell | PASS |
| `<at>` tag in body, no mentions array (parser) | absent -> cant_tell | PASS |
| no owner id anywhere / fromOwner null / empty list / empty-string cfg ids | show cant_tell | PASS |
| **mentions = non-array truthy (string or object) in stored content** | show (cant tell) | **THROWS** `(m.mentionedUserIds ?? []).some is not a function` -- line 166 runs before the Array.isArray guard on line 168. One bad row aborts teamsChatsFromLedger, i.e. the whole report. |
| **@Everyone in a group chat** (`mentioned.conversation`, Graph documents `chat` as a mention entity type) | show (the owner IS addressed; TEAMS_INSTRUCTIONS itself says items "of everyone in the chat" are his) | **HIDDEN before any AI call**: parser keeps `mentionedUserIds: []`, `mentionsOwner: false`; E2E plan `hidden=1 scan=0`. |
| mention with `user.id` empty, or a `null` mention entry | cant tell (a mention existed, target unknown) | stored as `[]` = "nobody mentioned" -> eligible to hide |
| tag mention (`mentioned.tag`) | owner may be a tag member: cant tell | `[]` -> eligible to hide |
| sender id / mention id with surrounding whitespace (non-parser writer only; the parser trims) | show | hide (configured ids are trimmed, row ids are not) -- latent |

Ordering before AI: confirmed by reading `scripts/action-scan-steps.ts` -- the Teams model loop iterates
`ledger.plan.teams.scan` only; `hiddenUninvolved` is only counted and listed in the HTML.

Secondary (latent, parser output is lower-cased so not live today): `teamsChatsFromLedger` builds its own owner set
without lower-casing `ownerUserId` or trimming configured ids, so with such input the involvement says `owner_sent`
while every message is labelled OTHER, `settled=false`, `ownerMentioned=false` -- the model is told the owner never
replied.

Radius challenge: "never sent" is judged on HELD rows only. Rows whose content is purged (90-day retention,
`purgeContent`) are not loaded, and nothing before ingestion started (or before `notBeforeUtc`) is held. A group chat
where the owner last wrote before that and is quiet now is HIDDEN. Documented in the docstring ("in the data held"),
but the failure direction is hide, against the rule's own "fail toward showing".

### Claim 2 -- resolution exclusion: CONFIRMED

Probe: `VERIFY-report-from-ledger-1.probe2.ts`, 42 of 43 PASS; the 1 non-pass is an INFO row, not a defect.
- approved / completed / dismissed / delegated each resolve up to their own time; a newer message from someone
  else brings the thread back (conv-keyed, message-keyed email, message-keyed Teams, bell email, bell chat).
- proposed / untriaged / replied / owed / drafted / processed / done / pending proposals: nothing. Bell replied /
  owed / drafted / snoozed / open, and `Dismissed` with a capital: nothing. Ledger processing status is never read
  (the loader SELECTs no status column).
- Message-keyed proposals cover only up to the MESSAGE time, never the later decision time (conservative).
- Fail-open cases: decidedAt null, mailbox case mismatch, other mailbox's key, unknown ledger id, transcript ref.
- INFO: a bell email row covers `max(message time, bell received_at)`. If received_at were later than the message,
  newer messages would be hidden. Read `email-replies.server.ts`: email bell rows hold the message's own receipt,
  and a chat bell row's received_at only advances together with a NEW ask, which resets status to `owed`. So a
  dismissed row cannot carry a later time. Not a live defect.
- Low (design): a conversation-keyed decision at T covers every message up to T, including one that arrived after
  the proposal was made and before the decision.

### Claim 3 -- Teams mentions stored, hash unchanged, back-fill writes only on apply: CONFIRMED

- `teamsSourceItem` hash is `stableHash([text, senderId, at, chatName])`. The diff did not touch it, and the
  author's TP-2 test passes. So adding mention fields re-processes nothing.
- `correspondence-backfill.ts` `store()` returns on `!apply` BEFORE both observe and the new `storeContent`. A dry
  run writes nothing.
- `storeContent` SQL writes `content`, `item_at` (only if null) and `last_seen_at`. It never writes hash, status
  or claims, and keeps a purged row NULL (`CASE WHEN content_purged_at IS NOT NULL THEN NULL`). Covered by the
  SQL suite's CT-5 and CP-4 on real PG.
- Live ingest does not refresh unchanged-hash rows, so stored rows gain mention data ONLY through an applied
  back-fill. Until then they read as can't-tell and SHOW (fail open). The live apply state was NOT REACHED.
- Low: the back-fill overwrites content with the newest OneDrive VERSION that still held the message. When that
  version predates the flow writing `mentions`/`ownerUserId`, a row the live ingest had already filled with
  mention data loses it and goes back to can't-tell (fail open, so it shows).

### Claim 4 -- Fireflies date-range listing: CONFIRMED (one low finding)

Probe: `VERIFY-report-from-ledger-1.probe4.ts` (mocked fetch), 6 of 7 PASS.
- 120 in-window meetings: 3 pages (skip 0/50/100). Exactly 100: stops after the empty 3rd page. Duplicate ids
  across pages are kept once. Refused date args (`Unknown argument "fromDate"`): switches to paged_all, restarts
  at skip 0, applies the window and stops on a full page that is entirely older. A non-date error with no data
  throws `fireflies_list_errors`, and the caller logs "known meetings only".
- The union keeps known first, with no duplicates (`a:known, b:both, c:listed`).
- FAIL (low): a known `meeting_id` with surrounding whitespace is not de-duplicated against the trimmed listed id
  (2 entries, not 1). The listed id is trimmed and the known id is not.
- Unverifiable here: the fallback's stop rule assumes Fireflies lists newest first. If the API order differs, the
  paged_all path could stop early. Only the date_args path is order-independent.
- Log lines print mode, pages, counts and ET day keys. An error message is printed only when it matches
  `^[a-z0-9_:.-]{1,60}$` (the module's own codes); anything else prints as "error".
