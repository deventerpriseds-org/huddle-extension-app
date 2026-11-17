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

## Loop-2 fixes

Source of the defects: `docs/qc-evidence/VERIFY-actions-accuracy-2.md` on `claude_verify-actions-accuracy-1`
(e4588d3c). Synthetic data only. Each fix is committed and pushed on its own.

### D-1 (HIGH): old verdicts are re-judged

- CHANGE: `CLASSIFIER_INPUT_VERSION = { email: 1, teams: 2 }` (action-classify.ts). Every new verdict stores
  `inputVersion`. `verdictIsCurrent(v, itemKey, source)` = same key AND same version (absent = 1). The classify
  pass skips only `currentlyJudgedKeys(verdicts)`; the page shows only a current verdict.
- BEHAVIOUR: a Teams verdict judged before this fix is not shown (counted "not checked yet") until the heartbeat
  re-judges it, then the corrected verdict shows. Re-judging rides the existing cap (500/day, 6 per pass,
  one pass per 10 min): about 36 re-judges an hour, so a few dozen Teams threads clear in about an hour.
- JUDGEMENT CALL (reversible, one line): email NOT bumped. The email labelling did not change on this branch
  (only the GROUNDED prompt text and the settled guard), and re-judging every email thread would hide correct
  email rows for hours. Set `email: 2` to re-judge email too.
- RESIDUAL (not changed): the stale verdict's backing proposal row is left as it was (it is no longer referenced
  by a current verdict, so Actions never shows it).
- TESTS: actions-accuracy R7-1..R7-7 (stale not judged; stale not shown; re-judged at the current version; the
  corrected sender and the OTHER person's quote win; settled guard on the re-judge; current reused; email kept).

### D-2 (MEDIUM): different asks no longer collapse into one row

- CHANGE: `collapseDuplicateTeamsItems(cands, senderIdOf)` treats two OPEN Teams items as the same ask ONLY when
  (a) they come from the same chat (chat id parsed from the item key), or (b) the same sender ID quoted the same
  folded sentence of at least `DEDUP_MIN_QUOTE_CHARS` = 40 characters (25 was tried first: the verifier's
  counter-example "Can you take a look at this?" is 28 characters and R6-5 failed at 25). A shared backing proposal is no longer a
  key (the store attaches different senders' to-dos to one proposal by title). A display name is never an id; an
  unknown sender id never matches. `buildCandidates` supplies the latest OTHER sender's id from the stored rows.
- BEHAVIOUR: the verifier's two counter-examples now give two rows (F2 short generic sentence; F4 shared
  proposal). The real duplicate (same person, same long ask, 1:1 + group chat) still gives one row, the newest.
- TESTS: R6-1 (rewritten: sender id instead of name), R6-2 (expectation REVERSED by this defect: shared proposal
  -> two rows), R6-5 short generic quote -> two rows, R6-6 name without id -> two rows, R6-7 same chat -> one,
  R6-8 end to end through buildCandidates (Pat's two copies -> one; Sam's identical ask on the same proposal stays).

### D-3 (MEDIUM): owner name matching uses FULL names from config, never a bare first name

- CHANGE: `ownerFullNames(cfg)` (needs-you.ts): every configured `correspondence.ownerNames` entry with two or more
  name words, plus each owner login / the mailbox whose local part is `first.last` -> "First Last". Config only; no
  identity in code. `assembleLedgerPlan` puts it on `ctx.ownerFullNames`; the Teams display-name last resort
  (`ownerTeamsIdsAcross`) and the "Teams group chat" label (`teamsSourceLabel`) read it, and both ignore any
  one-word name. Folding ("Last, First" -> "first last") makes both forms match.
- BEHAVIOUR: with no `ownerNames` configured, "Last, First" of the owner now matches (login first.last); a sender
  named only by the owner's first name, or with his first name and another last name, is never the owner; a chat
  named after a bare first name keeps its name. `effectiveOwnerNames` (model context, meeting headings) unchanged.
- TESTS: R8-1..R8-5 (derivation; default config recognises "Last, First"; bare / same-first-name never owner;
  label; label end to end with the default config).

### D-4 (MEDIUM, latent): one bad `ownerUserId` row can no longer promote a sender everywhere

- CHANGE: `ownerTeamsIdsAcross` takes a row's `ownerUserId` ACROSS chats only when that id is on rows of 2+
  different chats; when none is, the single most frequent id (2+ rows, strictly ahead, no tie) is taken.
  Configured ids always count; within its own chat a row's `ownerUserId` still counts (unchanged from main).
- BEHAVIOUR: a one-off wrong id affects at most its own chat (as before this branch), never every chat. Risk kept:
  if the owner's id were on exactly one stored row, it is no longer taken across chats (the name fallback, D-3,
  then applies). The probe (counts only) saw one distinct id on the older rows; not re-measured here. The real fix
  is the capture flow writing `ownerUserId` again (owner is on it) or `teams.ownerSenderIds` configured.
- TESTS: R9-1..R9-4. Fixture change: the R1 fixture now carries the owner's id on a second older chat (`older2`),
  because one row in one chat is by design no longer enough.

### D-5 (LOW): the uninvolved-chat rule hides no more than before the cross-chat lookup

- CHANGE: `chatInvolvement(chatId, messages, configuredOwnerIds, crossChatOwnerIds)`. The cross-chat ids (D-4
  filtered) are used only to SHOW (owner sent / owner mentioned). "Owner ids known" for HIDING is the configured
  ids plus the chat's own rows only, as on main, so a chat with no owner id of its own stays
  `cant_tell_owner_unknown` (shown) even when its rows carry `fromOwner: false`.
- BEHAVIOUR: hides exactly what main hid; can additionally SHOW a chat where the owner's id (learned elsewhere) sent.
- TESTS: R10-1 (the verifier's A5 shape -> shown), R10-2 (configured id -> uninvolved, unchanged), R10-3.

### D-6 (LOW): the settled guard scrubs the to-do as well as the reason

- CHANGE (settled threads only, action-classify.ts): `scrubOwnerStateTodo` removes a to-do clause that only claims
  the owner has not replied / "you still ..." and keeps the action part; nothing left -> null (the proposal then
  uses the verbatim quote as its title, the existing path). "You still ..." in `reason` is now dropped like
  "you have not replied".
- BEHAVIOUR: "You have not replied to Pat: send the deck" -> "Send the deck"; "You still need to resubmit the
  form" -> "Resubmit the form"; a pure claim -> null. Someone else's state ("Pat still needs ...") and unsettled
  threads are unchanged. Applies to verdicts judged from now on (Teams re-judges via D-1; email verdicts do not).
- TESTS: R11-1..R11-4.

### D-7 (LOW-MEDIUM): a real meeting item written "Label: action" is no longer lost

- CHANGE (meeting-triage.ts `splitActionItems`): a labelled line is a DETAIL only when (a) its label is pure
  metadata (Responsible person / Owner / Assignee / Assigned to / Timestamp / Timing / Due / Deadline) and its
  value carries no action verb (`isMetadataDetail`), or (b) it is indented under a kept item. Otherwise it stays
  an item. Pure metadata with no item above is dropped and counted (as before).
- BEHAVIOUR: "- Note: Owen to send pricing to the client" and "- **Deadline**: submit the grant application by Dec 1"
  are items again (title keeps the label text, ** stripped). The owner's real examples ("Responsible person: Not
  stated.", "Timestamp: (01:01-01:32).", "Timing: Beyond two weeks, inferred because ...") still attach.
  An unindented "Notes:" alone is a heading again (as on main).
- TESTS: R12-1..R12-3; R4-1..R4-4 unchanged and green; meeting-triage 69 / -sql 34 / -server 7 green.

### UI (minor): the "More" control

- CHANGE (ActionsView.tsx): "More" is a 44px touch target (`-my-2.5 inline-flex min-h-11 items-center`, the
  existing pattern in ProposalChecklistItem / JourneyWidgets; negative margins keep the row's look). It shows only
  when the title, meta line or summary is actually cut off (scroll size > box, re-measured by a ResizeObserver),
  and stays while expanded so "Less" folds it back. Tokens only (no new colours).
- UAT (actions-view-checks.mjs ACC-5, updated, NOT run here: no dispatch allowed): a row without More shows its
  whole title; the More control is >= 44px tall; expanded rows wrap / unclamp as before.
- Verification here: tsc + build only. Rendered result is MERGE-PENDING-UAT.

### Loop-2 mutation proofs (`mutate.sh`, anchors in files, exit code read)

| # | file | mutation (defect reinstated) | test | outcome | exit |
|---|---|---|---|---|---|
| L2-M1 | pipeline.ts | `verdictIsCurrent` ignores the version | R7-1 | FIRED (control EQUIVALENT) | 0 |
| L2-M2 | pipeline.ts | `buildCandidates` shows any verdict with the same key | R7-2 | FIRED (control EQUIVALENT) | 0 |
| L2-M3 | pipeline.ts | min quote length 1 (was 40) | R6-5 | first run INERT (the test used two different sentences: test bug, fixed); then PRE-DIRTY at 25 (the constant was too low: raised to 40); then FIRED (control EQUIVALENT) | 1, 5, 0 |
| L2-M4 | pipeline.ts | shared proposal is a de-dup key again | R6-2 | FIRED (control EQUIVALENT) | 0 |
| L2-M5 | pipeline.ts | display name used when no sender id | R6-6 | FIRED (control EQUIVALENT) | 0 |
| L2-M6 | report-from-ledger.ts | name fallback accepts one-word names | R8-3 | FIRED (control EQUIVALENT) | 0 |
| L2-M7 | report-from-ledger.ts | Teams name fallback reads `ctx.ownerNames` (first name) | R8-2 | FIRED (control EQUIVALENT) | 0 |
| L2-M8 | report-from-ledger.ts | an id on one chat is taken across chats | R9-1 | FIRED (control EQUIVALENT) | 0 |
| L2-M9 | report-from-ledger.ts | hiding uses the cross-chat ids | R10-1 | FIRED (control EQUIVALENT) | 0 |
| L2-M10 | action-classify.ts | settled guard leaves `todo` as is | R11-1 | FIRED (control EQUIVALENT) | 0 |
| L2-M11 | action-classify.ts | "you still ..." not treated as an owner-state claim | R11-2 | FIRED (control EQUIVALENT) | 0 |
| L2-M12 | meeting-triage.ts | every labelled line is a detail again | R12-1 | FIRED (control EQUIVALENT) | 0 |

One D-4 attempt first reported NOT-APPLIED (exit 3) because the file was uncommitted; re-run after the commit: FIRED.

### Loop-2 final runs (after merging origin/main 9bc4c4fb, #267)

actions-accuracy 55/55 (was 25), actions-view 90/90, actions-view-server 28/28, report-from-ledger 103/103,
correspondence-ingest 186/186, meeting-triage 69/69, meeting-triage-sql 34/34, meeting-triage-server 7/7,
task-proposals 199/199, task-proposals-sql 45/45, needs-you 77/77, ai-quota-alert 50/50, ai-quota-alert-sql 12/12;
tsc rc=0 (no output); vite build rc=0. Merge conflict: `.claude/actions.md` only (both ACT sections kept);
`actions.server.ts` auto-merged with `currentlyJudgedKeys` intact.

Open / not done here: UAT (ACC-3/4/5) not run (no dispatch in this brief); live effect of D-1 needs the deploy
(Teams rows judged before it show as "not checked yet" until the heartbeat re-judges them, ~36 an hour).
