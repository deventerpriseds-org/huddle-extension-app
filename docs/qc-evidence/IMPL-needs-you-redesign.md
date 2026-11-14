<!--
WHAT:          Implementation evidence for part A of the correspondence "needs you" redesign: what was built, the
               tests (observed counts), the mutation proofs (mutate.sh verdict + exit code), what is NOT done, and the
               owner's scope change mid-pass.
WHY:           Owner 2026-11-14 redesign; AC docs/qc-evidence/AC-correspondence-redesign.md (branch
               claude_ac-correspondence-redesign @ 5b8ba7d3) sections R1-R4, R6, R7, R9 + their R8 rows.
SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch claude_redesign-needs-you from claude_task-proposals @ b7ddbdca; commits 84ad6008, 81766c3f,
               633d672c, a5f253c2 (+ this file). All fixtures synthetic (.example / .test).
-->

# IMPL: correspondence "needs you" redesign, part A

Nothing here is live: no deploy, no workflow, no Graph, no database. Everything new is OFF unless
`correspondence.conversations` is literally `true` (the preview script is a manual one-off and always uses it).

## Owner scope change received mid-pass (2026-11-14) and what was done about it

| Owner instruction | What I did |
|---|---|
| Report is EMAIL ONLY for now | `scripts/proposals-preview.ts` no longer reads the Teams log at all; the three lists and the counts are email conversations only (PV-11). |
| Teams classification out of scope; do not build @mention / chat-size / meeting-chat rules; leave Teams ledger/bell unchanged | **Backed OUT, not left unused.** `teams-log.ts` and `source-item.ts` are byte-identical to `b7ddbdca` again (the `mentions` parse, `mentionsOwner`/`mentionsOther`, `statedOwnerIds` are gone); `chatKind`, `chatAskAimedAtOwner`, `classifyChat(s)` removed from `needs-you.ts`; `bell.ts` never touched. With `conversations` ON, Teams items go to the ORIGINAL per-message proposals processor unchanged (test "SCOPE Teams items go to the ORIGINAL per-message path"). |
| CC-only counts only when the latest other message (a) names the owner, (b) addresses the whole group, (c) asks him directly | `ccCallsOnOwner` + `addressesGroup` in `needs-you.ts`; otherwise verdict `not_addressed`, reason `cc_only_not_called_on`. To (alone or with others) unchanged. Tests CC-1..CC-9; mutation-proved (3 branches). |
| Owner names config-driven, default first token of each `ownerLogins` local part, capitalised | `correspondence.ownerNames` (optional list) + `effectiveOwnerNames(cfg)`; whole-word, case-insensitive (ON-1..ON-3). |
| Spelling rows for group-address phrases with over-match negatives | Table S-F in `scripts/needs-you.test.ts`: 16 positives, 10 negatives ("everyone agreed last week", "All the files", "The Platform Team will ship", "Team Phoenix shipped", "Allison, can you check?", "The folks at the vendor"...). |

## Deferred

- **Teams (owner direction for later):** judge each chat from its CONTEXT, using the speaker-tagged thread (the
  owner's own messages vs others'), not with @mention rules. Nothing of the OQ-5 heuristics remains in code.
- **OQ-5 (owner open question, recorded as asked):** "Teams group/meeting chats with no @mention: a question counts
  only in chats with 2 or fewer other people; meeting chats only with an @mention or the owner's first name." It was
  built, then backed out by the scope change above; the owner's newer direction supersedes it.
- AC-R2.10-2.12, R3.10-3.13, R7.8, S-D, S-E (all Teams) -- deferred with Teams.
- AC-R9.4 `emailBell`: the switch is parsed (OFF unless literally `true`) but NOTHING reads it; email bell rows and
  Iris's live alerts are exactly as today (owner OQ-2: "not now").
- Part B (R5, meeting triage) belongs to the parallel agent. The report's third list renders "none triaged yet"
  (PV-9) until part B stores "Mine" items; the `meetingTriage` flag (R9.1) and R9.3 are left to part B to avoid
  colliding edits to `engine.ts` / `onedrive-feed.ts`.

## Per AC: files, tests, mutation proof

Test counts are as observed on the final tree (`a5f253c2` + this doc): `bun scripts/needs-you.test.ts` **147 passed,
0 failed**; `bun scripts/proposals-preview.test.ts` **13 passed, 0 failed**.

| AC | Status | Files | Tests (all in needs-you.test.ts unless named) | Mutation (mutate.sh) |
|---|---|---|---|---|
| R1.1 live symbols unchanged | DONE vs the base | `inbound-email.ts` NOT edited: `git diff b7ddbdca HEAD -- inbound-email.ts` is empty. NOTE: at the base it already differs from `origin/main` (pre-existing multi-language `newTextOnly` work on `claude_task-proposals`); this pass adds nothing. | -- | -- |
| R1.2 pin of the live screen | DONE | `scripts/fixtures/needs-you-pin.json` (98 synthetic messages, generated from the UNCHANGED file) | "AC-R1.2 PIN ..." (screenMessage x3 modes, asksSomething, newTextOnly, inboundEmailDirective) | n/a (snapshot) |
| R1.3 inbound watch identical when ON | DONE by construction | the watch (`onedrive-feed.server.ts:361`) only gains extra optional fields on mapped messages; no flag is read there | "AC-R1.4 the optional mapper fields change NO live verdict, ask or directive" | -- |
| R1.4 recipients from the original record | DONE (owner-approved form) | `mapFeedMessage` returns `FeedInboundMessage extends InboundMessage` with OPTIONAL `toRecipients`/`ccRecipients`/`contentClass`, present only when the record has them. `InboundMessage` itself unchanged. | "mapFeedMessage: a record without the new fields maps with NO new keys" + R1.4 pin | -- |
| R1.5 never screenMessage; subject never to asksSomething | DONE | `needs-you.ts` | "AC-R1.5 ..." (grep) + "AC-R1.5 subject 'Re: quick invite question'..." | -- |
| R1.6 preview uses the classifier | DONE | `scripts/proposals-preview.ts` | "AC-R1.6 ..." (grep) | -- |
| R2.1-2.9, 2.13 one item per conversation | DONE (email) | `classifyEmailConversation(s)` | AC-R2.1..2.8, 2.13 | latest_message FIRED exit 0; sent_settles FIRED exit 0 |
| R3.1-3.9, S-A1..A13 | DONE | `parseRecipients`, `ownerAddressing`, `automatedReason` | S-A1..S-A13, AC-R3.2..3.9 | whole_address FIRED exit 0; not_addressed FIRED exit 0; automated FIRED exit 0; fail_closed_owner **INERT exit 1** (see below) |
| CC-only rule (owner) | DONE | `ccCallsOnOwner`, `addressesGroup` | CC-1..CC-9, S-F (26 rows) | cc_rule FIRED exit 0; cc_names FIRED exit 0; cc_group FIRED exit 0; group_overmatch FIRED exit 0 |
| R4.1-4.8, S-B1..B13 | DONE | `isCalendarItem` (Exchange calendar headers from probe P-1, Content-Class, colon-form subjects) | S-B*, AC-R4.1/4.4/4.6/4.7 | invite FIRED exit 0 |
| R5 classification part (minutes never reply/to-do) | DONE | `isMinutesEmail`, `directAsk` | S-C1..C7, AC-R5.1, forwarded-minutes rows | minutes FIRED exit 0; minutes_direct_ask FIRED exit 0 |
| R6.1-6.10 owner as doer | DONE (email) | `engine.ts` `conversationSourceFor`, `conversationDoer`, `conversationProposalsProcessor`; `proposeFromSource` optional `doer` seam; `proposals.ts` 3 new reject reasons; `proposals.server.ts` builds it only under `conversations === true` | section Q (R6.1/6.2/6.3/6.6/6.8/6.9/6.10, CC-only to-do rows) | assignee_filter FIRED exit 0; todo_source FIRED exit 0 |
| R7.1-7.7 preview three lists | DONE (email) | `scripts/proposals-preview.ts`, new `scripts/proposals-preview-render.ts`, stub captures PUT bodies | proposals-preview.test.ts PV-7..PV-13 + "AC-R7.5/7.6" | privacy_log FIRED exit 0; preview_per_conversation FIRED exit 0 |
| R7.8 bell == report for chats | DEFERRED (Teams) | -- | -- | -- |
| R7.9 performance | NOT measured | -- | -- | -- |
| R9.1 flags | DONE (`conversations`, `emailBell`, `ownerAliases`, `ownerNames`) | `onedrive-feed.ts correspondenceFlags` | "AC-R9.1 ..." | -- |
| R9.2 zero-call when OFF | DONE (structural) | the conversation processor is built only inside `if (cfg.correspondence.conversations === true)`; else the original processor, byte-identical call | "AC-R9.2 ..." (source grep) | -- |

All 17 mutation runs: 16 FIRED with control EQUIVALENT (exit 0), 1 INERT (exit 1). One run first returned exit 4
(cc_names: the named test did not fail because CC-2's text "will review them" also triggered branch (c) via the word
"review"); the fixture was fixed in `a5f253c2` and the re-run FIRED exit 0.

**fail_closed_owner INERT -- honest reading: behaviourally equivalent, not proven.** Removing the early
`no_owner_address` return still yields `cant_tell` because `ownerAddressing` itself returns `unknown` for an empty
owner set; the guard is enforced twice. AC-R3.9's behaviour is tested; this particular line is redundant.

## Existing tests changed (none weakened)

- `scripts/correspondence-ingest.test.ts` "AC-6.1 correspondence switches all OFF by default": the expected default
  shape gained the four new keys, all OFF/empty -- the same pattern used when `staleAlerts` was added.
- `scripts/proposals-preview.test.ts`: PV-1..PV-6 unchanged and green; PV-7..PV-13 added.
- No existing test encodes a rule the owner rejected in this pass, so none was rewritten.

## Suites run on the final tree (observed)

needs-you 147/0, task-proposals 204/0, redteam-correspondence 77/0, inbound-email 72/0, correspondence-ingest
149/0, feed-staleness 96/0, proposals-preview 13/0, onedrive-feed-truth 11/0, html-visible-loop5 9/0,
cross-app-turn-gate 92/0, onedrive-feed "all passed", `npx tsc --noEmit -p .` clean. No SQL touched.

## ACs I believe are wrong or under-specified

1. **CC rule (c) "asks the owner directly" overlaps (a) "names the owner".** On CC, "you" usually means the To
   person, so (c) was implemented as "an asking sentence that names the owner" -- a subset of (a). If the owner
   meant something wider, (c) needs a definition that does not re-admit every "can you" aimed at the To person.
2. **AC-R1.1 compares with `origin/main`,** but the branch base already changed `newTextOnly` vs main. The pin is
   taken against the base (the code the owner calls "already good"), and this pass leaves the file untouched.
3. **AC-R4 subject spellings (S-B3..B9) are unverified and probe P-2 counted 0 of them;** the real invite signal is
   the Exchange calendar headers (probe P-1). The subject rows are kept as tests but carry the real load only if a
   non-Exchange sender appears.
4. **`x-ms-exchange-organization-bulkcategory` is treated as broadcast on PRESENCE** (probe P-1 counted names, not
   values). If Exchange stamps it with a "not bulk" value on person mail, that would be a false `automated`.
   A counts-only probe of its values would settle it.
5. **AC shared-definition "owner Teams ids from ownerUserId" was NOT moved into the live parser** (Teams out of scope).
