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
