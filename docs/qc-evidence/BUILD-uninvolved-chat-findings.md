# BUILD-uninvolved-chat-findings

WHAT:       Fixes for the verifier's findings on the UNINVOLVED-CHAT rule and the Fireflies union (PR #257, ece03e60):
            @Everyone / non-user mentions, malformed stored mention fields, empty / null / tag mentions, one shared
            owner-id normaliser, and trimmed known meeting ids.
WHY:        docs/qc-evidence/VERIFY-report-from-ledger-1.md (branch claude_verify-report-from-ledger-1) REFUTED claim 1:
            an @Everyone ask in a group chat was HIDDEN before any AI step, and a non-array stored mention field threw
            and aborted the whole report. The rule is owner-approved to FAIL OPEN (any doubt shows the chat).
SUPERSEDES: nothing (extends docs/qc-evidence/BUILD-report-from-ledger.md).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; scripts/report-from-ledger.test.ts, scripts/fireflies-list.test.ts; mutate.sh runs below.

Public repo: synthetic ids and text only. No message bodies are logged by any change here.

## Baseline (origin/main 046ec493, before any change)

| suite | result |
|---|---|
| bun scripts/report-from-ledger.test.ts | 39 passed, 0 failed |
| bun scripts/fireflies-list.test.ts | 7 passed, 0 failed |
| bun scripts/correspondence-ingest.test.ts | 186 passed, 0 failed |

## Findings and fixes

(appended as each lands)

### Finding 1 (HIGH) -- @Everyone / chat-wide and other non-user mentions hid the chat: FIXED

- `teams-log.ts`: `mentionUserIds` became `mentionFacts(mentions, rawBody)`. It returns the user ids (unchanged
  meaning) AND `unresolved`: true when any entry names no comparable user -- a conversation/chat (@Everyone), tag,
  application, team or channel mention, an entry that is not an object or has no `mentioned`, or a user whose id is
  empty or not a string -- or when the raw body has an `<at id="N">` tag whose N is not a resolved user mention
  (or has no id). The parser stores it as `unresolvedMention` whenever it stores `mentionedUserIds`.
- `source-item.ts`: `TeamsMessage` / `TeamsContent` gain `unresolvedMention?: boolean`; `teamsContent` copies it.
  The content hash (`stableHash([text, senderId, at, chatName])`) is NOT touched (test VF1-8).
- `report-from-ledger.ts`: new exported `maybeMentionsOwner(m)`; `chatInvolvement` returns
  `{hide:false, reason:"owner_maybe_mentioned"}` after the owner_sent / owner_mentioned checks. Rows stored before
  the flag existed: an `<at` tag left in the stored text (only an escaped `&lt;at&gt;` survives htmlToText; checked
  with a scratch run: `<at id="0">Everyone</at> please` -> `"Everyone please"`, `&lt;at&gt;x&lt;/at&gt;` -> `"<at>x</at>"`)
  with no stored user mention counts as maybe-mentioned. The verifier's PASS case (`<at>` tag, NO mentions array ->
  absent -> `cant_tell_no_mention_data`) is unchanged.
- Facts sent to the model: `ownerMentioned` is `null` (unknown), not `false`, when a maybe-mention exists.
  `planLedgerReport` counts `owner_maybe_mentioned` in `teams.cantTell`.
- Tests: VF1-1 .. VF1-9 (scripts/report-from-ledger.test.ts). Suite 39 -> 48 passed, 0 failed.
  correspondence-ingest 186 passed. `npx tsc --noEmit` rc=0.
- RESIDUAL (not fixed, by the brief's chosen legacy rule): a row stored by #257 code BEFORE this flag, holding
  `mentionedUserIds: []` for a real @Everyone whose `<at>` tag the HTML-to-text step already removed, still reads
  as "nobody mentioned" and can hide. It gains the flag only when an applied back-fill rewrites its content (live
  ingest does not refresh unchanged-hash rows -- verifier claim 3). The stricter alternative (treat any row with
  `mentionedUserIds` but no `unresolvedMention` as can't-tell) would show every #257-era row until back-fill.

### Finding 2 (MEDIUM) -- a non-array stored mention field threw and aborted the report: FIXED

- `chatInvolvement` checks `Array.isArray(m.mentionedUserIds)` BEFORE `.some`; a string / number / object field is
  "no mention data" -> `cant_tell_no_mention_data` -> SHOWS.
- `chatInvolvement` is now a never-throwing wrapper around `chatInvolvementOf`: anything unexpected returns
  `{hide:false, reason:"cant_tell_malformed"}` (new reason, counted in `plan.teams.cantTell`).
- `teamsChatsFromLedger` builds each chat in its own try/catch (`chatFacts`); a chat whose facts throw is returned by
  `malformedChatFacts` (typeof-guarded, cannot throw), which SHOWS it with `cant_tell_malformed`, every message OTHER
  unless explicitly `fromOwner: true`, owner-mentioned unknown. The other chats are unaffected. Its `ownerMentioned`
  line also guards with `Array.isArray`.
- Tests: VF2-1 (string / object / number field), VF2-2 (a null message -> malformed, shows), VF2-3 (three chats, one
  with a string field and one whose text throws on String(): all three come back, the bad ones show, the good
  uninvolved one is still hidden). Suite 48 -> 51 passed, 0 failed. tsc rc=0.

### Finding 4 (LOW) -- empty user id, null mention entry, tag mention stored as "nobody mentioned": FIXED

- Parser side: done by finding 1's `mentionFacts` -- a user id that is empty, whitespace or not a string, a null /
  non-object entry, an entry with no `mentioned`, and a tag mention all set `unresolvedMention: true` (they are no
  longer silently dropped into `[]`).
- Stored side (rows from an older or other writer): `maybeMentionsOwner` returns true when `mentionedUserIds` holds
  an entry that is not a non-empty string ("", whitespace, null, a number). A list of real non-owner ids still hides.
- Tests: VF4-1 (parser, six shapes), VF4-2 (parser -> stored -> rule shows), VF4-3 (five stored shapes show),
  VF4-4 (real non-owner ids still hidden). Suite 51 -> 55 passed, 0 failed.
