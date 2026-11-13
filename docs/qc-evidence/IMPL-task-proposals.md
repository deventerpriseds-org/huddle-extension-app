<!--
WHAT:          Running implementation log for AC section 5: task proposals as a new row kind in the EXISTING
               chat checklist (extraction from email / Teams / Fireflies, a server-side proposal store,
               Approve / Edit / Mark done / Dismiss, delivery in Iris's 1:1).
WHY:           Owner handoff "Huddle Email and Teams Daily Processing" (2026-11-12) + AC
               docs/ac/AC-correspondence-checklist.md section 5 (branch claude_ac-correspondence-checklist).
               Tier 1: it admits model output (extracted to-dos) into stored claims. Written as the work lands
               so a killed session leaves a trail.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      branch claude_task-proposals; scripts/task-proposals.test.ts; scripts/task-proposals-sql.test.ts
-->

# IMPL: task proposals (AC section 5)

Base: `origin/claude_correspondence-ingest` ef86de83 (the data layer; not edited here, only imported).
Branch: `claude_task-proposals`. Nothing is enabled: everything is gated on
`HUDDLE_ONEDRIVE_FEEDS.correspondence.proposals` (the data layer's flag), which defaults OFF. No live DB,
OneDrive, journey, workflow or deploy was touched.

## Owner decisions (binding) and the safe defaults chosen for the open questions

| Question | Decision | Source |
|---|---|---|
| OQ-7 where/when | Posted in IRIS's 1:1 (`dm-iris-chase`) after the 6pm processing pass AND on request ("show my proposed tasks"). No bell item for proposals. | owner |
| OQ-7 re-post | Each posting shows ALL open proposals, not only new ones. | default (reversible) |
| OQ-8 "Mark done" | Closes the proposal (`completed`) and creates NO task. | default (reversible) |
| OQ-9 cross-source | The same to-do (normalized title) from two sources is ONE proposal keeping both source refs. | default (reversible) |

## Step log

### Step 1 -- pure core (AC-5.1, 5.2, 5.18-5.21 validator, OQ-7 timing)

- `src/features/huddle/lib/proposals/proposals.ts` (new, dependency-light): source text from a ledger
  `SourceItem` (email reuses `screenMessage` in "people" mode + `newTextOnly`; Teams skips app senders and
  the owner's own messages; transcripts read Fireflies' action items + overview only), the strict JSON
  schema + instructions for extraction, THE VALIDATOR `validateCandidates`, due-date resolution relative to
  the SOURCE's time in the owner's zone, `prop-` ids, `proposalChecklistRow`, `sanitizeChecklistPayload`
  (the reply-assembly's field-by-field rule, extended for the new kind), and evening-delivery timing.
- Validator rules (model output -> stored claim): evidence must be a verbatim span of the source's NEW
  text (only whitespace collapse and typographic quote/dash straightening are forgiven; case-exact), 8-400
  chars; the task must share a content word with its evidence (blocks a real quote glued to an invented
  task); assignee kept only when the span names that person (pronouns -> null); due words kept only when
  they are in the span, and a date only when they resolve (`next Friday`, `next week`, `soon` -> null);
  in-batch duplicates and anything past 8 per source dropped. Nothing is repaired.
- `scripts/task-proposals.test.ts` sections A-E incl. the spelling table S-P1..S-P18: **69 passed, 0 failed**.

### Step 2 -- proposal store in Azure PG (AC-5.4, 5.5, 5.8, 5.11-5.13, 5.21, OQ-9)

- `lib/proposals/proposals-store.server.ts` (new): `chat.task_proposals` (id CHECK `prop-%`, state CHECK,
  current title + original title + norm title, verbatim evidence, assignee/due only as extracted, source refs
  as jsonb, journey `task_id`, `approve_lease_until`) with a PARTIAL UNIQUE index on (owner, norm_title)
  WHERE state='proposed' (one active proposal per to-do), and `chat.task_proposal_refs` PK (owner, source,
  source_item_id, norm_title) = the dedup memory across every state. Shared pool, lazy idempotent bootstrap.
- upsert: seen (ref exists, any state) -> nothing; same to-do active from another source -> attach ref;
  else create. Unique-index races re-evaluate (max 3 rounds).
- Approve = compare-and-set LEASE (not a state flip), so a killed approve leaves the row `proposed` and
  claimable again after the lease, and a retry then links to the task journey already created (AC-5.10).
  Dismiss / Mark done / Edit refuse while a lease is held, so Approve and Dismiss can't both win.
- `bun scripts/task-proposals-sql.test.ts` (real PostgreSQL 16): **41 passed, 0 failed** (first run 39/2:
  jsonb key order in the returned refs -- fixed by rebuilding refs in a fixed shape -- and a test regex
  that matched `due_text`).

### Step 3 -- engine: processor, transcripts, owner actions, delivery (AC-5.3, 5.7-5.16, 5.18-5.22, 3.3)

- `lib/proposals/engine.ts` (new, I/O injected): `proposeFromSource` (extract -> validate -> skip open board
  titles -> store), `proposalsProcessor` (the data layer's `ItemProcessor` seam, name "proposals"; a failed
  extraction throws the code `proposals:extract_failed` so the ledger marks it failed_retryable, never
  processed), `runTranscriptProposals` (Fireflies meetings the minutes flow already FINISHED, observed into
  the SAME ledger as source `transcript`, keyed by meeting_id; read-only), `approveProposal` (CAS lease ->
  `screenCapabilityMetaTask` -> `screenRawJourneyCreate` against the owner's open titles -> the existing
  journey create; a duplicate links to the open task), `decideProposal`, `editProposal`,
  `proposalChecklistResult` (build_checklist proposals mode), `deliverEveningProposals` (ONE durable turn
  per owner per local weekday, in `dm-iris-chase`, journey disabled, payload carries every open proposal).
- `scripts/task-proposals.test.ts` sections G-J: the processor runs through the data layer's REAL
  `runIngestPass` against its dummy fixtures (adapter -> ledger -> proposals, AC-7.1). **123 passed, 0
  failed**. `tsc --noEmit -p .` clean (node_modules symlinked from the main checkout, untracked).

### Merge -- data layer finished (coordinator, 2026-11-12)

Merged `origin/claude_correspondence-ingest` 5c0b4593 (merge commit 714e7aa6, no conflicts). After merge:
task-proposals 123/0, correspondence-ingest 148/0, task-proposals-sql 41/0. The seam change (optional
`batch` on the processor context) needs nothing from proposals.

### Step 4 -- server binding + wiring (AC-5.7, 5.15, 5.16, 5.22, 6.1/6.3)

- `lib/proposals/proposals.server.ts` (new): `proposalsConfig()` = OFF unless
  `correspondence.proposals === true`; extraction through the EXISTING strict-JSON path `callOpenAIRouter`
  (Responses + json_schema strict) on the `gpt-5.6-luna` tier the minutes flow uses, 20 s bound;
  open titles via `loadOpenTaskTitles`; Approve creates through `invokeJourneyTool quick_create_task` (the
  one journey chokepoint, as the voice/text create paths do) and reads the journey id from its result;
  transcripts via the minutes store's `listRecentMeetings` (finished meetings only, 7 days) + Fireflies
  `fetchTranscript` (read-only); the evening turn via `enqueueTurn` + `runTurnById` (inbound-email shape).
  Optional `correspondence.proposalsDeliverAt` ("HH:MM", default 18:30 ET).
- `lib/proposals/proposals.functions.ts` (new): `getProposalStatesFn` (ONE request for every proposal row of
  a mounted checklist) and `actOnProposalFn` (approve/complete/dismiss/edit). Proposal actions never touch
  `updateBoardTask` (AC-5.3).
- Edits outside lib/proposals, each additive:
  - `lib/correspondence/ingest.server.ts` (data layer file; its header names `processorsForPass` as where
    proposals plug in): appends the proposals processor, and runs processors when `bell || proposals`.
    `activeProcessors` still runs each only under its own flag.
  - `lib/tasks/scheduler.server.ts`: `runProposalsPass()` started alongside Fireflies/ingest, awaited in
    both return paths. No route file touched (G7).
  - `lib/fireflies/fireflies.server.ts`: `fetchTranscript` gains `export` (one word; behaviour unchanged;
    webhook, `saveTranscript`, `TRANSCRIPT_FOLDER` and minutes settings untouched -- AC-6.5).
  - `lib/tasks/tools.ts`: `build_checklist` gets a `proposals` boolean; the dispatcher delegates to
    `proposalChecklistForUser` (not_enabled when OFF). The parameter description is always visible to the
    model; it is inert when OFF.
  - `lib/huddle.functions.ts`: the reply-assembly's inline row mapping now calls the shared pure
    `sanitizeChecklistPayload` (byte-identical output for kind-less rows, proven in test section D); the
    turn Input gains an optional `checklist` (bounded: 500 rows) attached to the TARGET agent's reply like
    `navLink`, with `ensureChecklistDelivered` beside `ensureNavLinkDelivered`; the Lovable
    `build_checklist` schema accepts `proposals`.
- tsc clean; task-proposals 123/0; correspondence-ingest 148/0; cross-app-turn-gate 92/0.

### Step 5 -- the EXISTING checklist UI gets the proposal row kind (AC-5.1-5.3, 5.6, 5.9, 5.17, 5.24, 8.x)

- `data/seed.ts`: `ChecklistRow` gains optional `kind` ("task" | "proposal"; absent = task, unchanged) and
  `proposal` (display detail). `store.ts`: `ChecklistRowState` gains optional `title` / `linkedTaskId`.
- `components/HuddleView.tsx` `ChecklistCard`: stage 2 now reads proposal rows from `getProposalStatesFn`
  (ONE request for all of them) and task rows -- plus any task an approved proposal became -- from
  `getBoardTasks` as before; a checklist without proposal rows makes exactly the one read it always made.
  Rendering: task rows unchanged; an APPROVED proposal renders as an ordinary `ChecklistItem` keyed by its
  journey id (AC-5.9); every other proposal renders `ProposalChecklistItem`.
- `components/ProposalChecklistItem.tsx` (new): dashed approve box + Approve / Edit (inline input) / Mark
  done / Dismiss menu; source, date, due and named owner on a second line; the evidence span as the title's
  tooltip; decided rows inert and labelled. Same optimistic -> server -> rollback contract and `busy` guard
  as task rows; actions go to `actOnProposalFn`, never `updateBoardTask`.
- `lib/stream-context.ts`: proposal rows summarised on their OWN line, "NOT tasks on the board unless
  approved", each with its state (`1. approved: ...`); a task-only checklist produces the identical line.
- AC-5.14 (ContextPanel "Needs your approval"): LEFT UNTOUCHED and documented as a separate feature. It
  lists client-only agent-suggested `Task.suggested` cards (`approveTask` flips a local lane, `skipTask`
  deletes) and never shows server proposals, so there is ONE place proposals are approved: the chat
  checklist. Folding that panel into proposals would change an existing flow -> owner thumbs-up first
  (Huddle hard rule).
- Tests: task-proposals **131 passed, 0 failed** (sections K stream-context + build_checklist OFF, L
  hygiene). context-and-confirm ALL PASS. tsc clean.

### Step 6 -- full suite + mutation proofs

Suites on the branch head (after the data-layer merge): task-proposals **131/0**; task-proposals-sql (real
PG 16) **41/0**; correspondence-ingest **148/0**; correspondence-ledger-sql **50/0**; attention all passed;
attention-focus all passed; cross-app-turn-gate **92/0**; inbound-email **72/0**; onedrive-feed all passed;
context-and-confirm ALL PASS; fireflies-queue-sql all passed; fireflies-minutes **64 PASS / 3 FAIL -- the
same G3/G5/G8 failures recorded on untouched main** (IMPL-correspondence-ingest.md), not caused here.
`tsc --noEmit -p .` clean.

Mutation proofs (`mutate.sh`, every one exit 0, "FIRED (control EQUIVALENT)"):

| # | Guard (file) | Mutation | Named test that failed |
|---|---|---|---|
| M1 | evidence must be verbatim (proposals.ts) | `if (false)` | S-P4 PARAPHRASED evidence |
| M2 | task must share a word with its evidence | `if (false)` | S-P5 invented task on a real quote |
| M3 | assignee only when the span names them | `return a` | AC-5.20 assignee NOT named in the span |
| M4 | due words only when in the span | keep any due_text | AC-5.20 model invents a date not in the span |
| M5 | "next <weekday>" -> no date | line removed | AC-5.20 'next Friday' is ambiguous |
| M6 | proposal row must carry a prop- id | line removed | AC-5.2 a 'proposal' row whose id is a task uuid is DROPPED |
| M7 | owner's own Teams message is not a source | line removed | S-12 owner's own Teams message -> skipped |
| M8 | to-do already open on the board not proposed (engine.ts) | `if (false)` | AC-5.21 to-do equal to an open board title |
| M9 | failed extraction throws a code (never `processed`) | `return out` | AC-3.3/3.8 extraction failure throws a short code |
| M10 | Approve links to an open duplicate | `if (false)` | AC-5.10 title already OPEN on the board |
| M11 | meta-task guard on Approve | line removed | AC-5.7 create-task-core meta-task guard runs on Approve |
| M12 | one evening turn per day | line removed | AC-5.16 a second tick the same evening sends nothing twice |
| M13 | refs "seen" short-circuit (store SQL) | line removed | `FAIL harness` -- CAVEAT: with it gone the refs PRIMARY KEY still refuses the duplicate, so the upsert throws after its 3 retries instead of returning `seen`. Proves the line makes a re-read a clean no-op; duplicates are blocked by the PK either way. |
| M14 | Approve CAS lease condition (store SQL) | lease clause removed | AC-5.8 two concurrent Approve claims |
| M15 | proposals on their own stream-context line | `propRows = []` | AC-5.17 proposal rows are on their own line |

## Handoff (what is needed to turn it on -- NOT done here)

- Config: `HUDDLE_ONEDRIVE_FEEDS.correspondence.proposals: true` (needs `ingest: true` for email/Teams
  sources; transcripts additionally need `FIREFLIES_API_KEY` and `minutesOwner()` inside the owner's scope).
  Optional `correspondence.proposalsDeliverAt: "HH:MM"` (owner zone, default 18:30, weekdays, until 22:00;
  waits up to 60 min for still-due extraction work).
- Migration: none to run; `chat.task_proposals` and `chat.task_proposal_refs` bootstrap lazily (idempotent).
- Model: `gpt-5.6-luna` via `callOpenAIRouter`; real extraction quality is UNVERIFIED (offline tests use a
  stub model; the validator is what guarantees nothing ungrounded is stored).
- Not verified live (forbidden this task): the journey create on Approve, the durable Iris turn, the UI
  ([UI] rows of AC-5.3/5.6/5.9/5.24 timing), and the [DB] checks.
- Not built here: the per-owner Settings toggle (AC-6.2) and the health panel (AC-6.6) -- the data layer
  scoped those to a later pass.

## Red-team fix pass (2026-11-12)

Fixes for `docs/qc-evidence/REDTEAM-correspondence-proposals.md` (F1-F19, S1/S2/S4/S5). Repro suite:
`bun scripts/redteam-correspondence.test.ts` (no red-team assertion was weakened or removed). Rows are
appended as each fix lands.

| finding | change | file | red-team test now passing |
|---|---|---|---|
| F1 | `teams` is OPT-IN: only an object (or literal `true` = default path) enables it; `false`, `"off"`, 0, arrays, null, absent = OFF (`optInFile`). email/appointments keep main's default-on `file()` untouched. | `external-feeds/onedrive-feed.ts` `optInFile` / `teamsFile` | RT-22, RT-22b, RT-22d |
| F2 | `sent` goes through the same `optInFile`. | `onedrive-feed.ts` parseFeedsConfig | RT-22c |
| F18 | Synthetic Sent Items: `RE:/Re:/FW:/Fwd:/AW:/TR:/WG:/SV:/RV:` (repeated, `[n]`) stripped before the prefix test (`stripReplyPrefixes`). | `onedrive-feed.ts` mapSentRecords | RT-23 |
| S1 | `parseUtcMs`: a zone-less ISO date-time is UTC (Sent Items `sentDateTime`, Teams `timestamp`). Main's envelope checks are unchanged. | `onedrive-feed.ts`, `teams-log.ts` | (suspected; no RT test) |
| F8 | `htmlToText` drops `<head>`, comments, `<script>/<style>`, and any element hidden by inline style (`display:none`, `visibility:hidden`, `font-size:0`, `opacity:0`, `max-height:0`, `mso-hide:all`) or the `hidden` attribute, with its whole subtree (nested same-name tags matched; an unclosed hidden element swallows the rest). | `onedrive-feed.ts` `stripHiddenElements` | RT-13, RT-13b |
| F19 | One-pass entity decode: numeric (`&#8217;`, `&#x2019;`) and common named entities (`&rsquo;` etc. -> plain quotes, `&nbsp;`, `&mdash;` ...); `&amp;lt;` -> `&lt;` (never double-decoded). | `onedrive-feed.ts` `decodeHtmlEntities` | RT-14, RT-14b |
| F16 | A Teams message with no sender id -> `fromOwner: null` (can't tell), never `false`. | `teams-log.ts` parseTeamsLog | RT-16, RT-16b |
| F17 | URLs removed before the ask heuristic in `chatMessageAsks` (any source path), and plain-text Teams bodies get the HTML path's `[link]` rule. | `correspondence/bell.ts`, `teams-log.ts` bodyText | RT-17 |
| S2 | Owner presence decided PER CHAT (AC-4.6 "for that chat"). Two existing `correspondence-ingest.test.ts` checks encoded the old cross-chat rule and were updated: AC-7.1 charlie row is now `owner_messages` (can't tell, fixture has no owner message in that chat); AC-4.13's owner message moved into the SAME chat (before the ask), so the two-pass settle is still proved with a certain row. Recall cost: a chat where the owner has never posted is listed "can't tell", not counted. | `bell.ts` makeBellProcessor | (suspected) + updated AC-7.1 / AC-4.13 |
| F9 | `newTextOnly` cuts non-English reply headers (FR `De :`/`Envoyé :`, DE `Von:`/`Gesendet:`, ES `De:`/`Enviado:`, IT, NL, PT, Nordic, PL, RU, TR) -- a From-line still needs a Sent/Date-line within 4 lines --, translated "On ... wrote:" attributions and "Original Message" separators, and a Gmail attribution wrapped over two lines. | `email/inbound-email.ts` newTextOnly | RT-12, RT-12b, RT-12c (RT-12d still passes) |
| F3 | `validYmd` round-trips every date (ISO, month-day, day-month); an impossible date -> no due date, the to-do kept. `proposeFromSource` isolates each candidate's store write: a failure is counted, the others are still stored, and the item then throws `proposals:store_failed` so the ledger retries (refs make the stored ones `seen`). | `proposals/proposals.ts` resolveDueDate/validYmd; `proposals/engine.ts` proposeFromSource | RT-8, RT-8b; new `F3` checks in task-proposals.test.ts |
| F4 | `titleGrounding`: every digit-bearing token of the title (amounts, accounts, `Q3`) must be a whole token of the evidence, and a STRICT MAJORITY of the title's content words must be grounded. New reject reason `task_number_not_grounded`. | `proposals.ts` titleGrounding | RT-1 |
| F5 | Evidence needs >= 15 characters AND >= 4 words (was 8 chars). (20 chars was tried first; it refused the realistic 19-char span "send me the Q3 deck", which the red-team's own RT-7/RT-25 rely on.) | `proposals.ts` EVIDENCE_MIN / EVIDENCE_MIN_WORDS | RT-2 |
| F6 | Whole-word match with a light suffix strip (`s/es/ed/ied/ing`), no 5-letter prefix stem. | `proposals.ts` lightStem/contentWords | RT-3 |
| F7 | The stored + displayed evidence is the full enclosing sentence (`enclosingSentence`; falls back to the span if the sentence exceeds 400 chars). A span whose lead-in clause negates the action (`do not / don't / never / no need to / not / shouldn't / must not / won't / cannot / stop / hold off / no longer`) is refused as `evidence_negated`; "don't forget/hesitate to", "not only", "if not" are not negations; the clause is cut at `, ; :` and "but". | `proposals.ts` enclosingSentence/negatesAction | RT-4 |
| F10 | `due_text` kept only when every word is a date word (weekdays, months, numbers/ordinals, ISO, "by/on/before/until/end of day/..."), <= 8 words. | `proposals.ts` isDateWords | RT-10 |
| F11 | Month = whole word (full name, 3-letter abbreviation, "sept"); day-month order ("14 November", "3rd of December") added; every date term found, a term right after a negation dropped, earliest remaining wins. | `proposals.ts` resolveDueDate | RT-9, RT-9b, RT-9c |
| F12 | Assignee only for a capitalized 1-3 word name (not weekday/month/greeting) that is the subject ("Dana will/to/should ..."), addressee ("Dana, ...", "..., Dana?", "@Dana") or hand-off target ("ask Dana to ..."); a requester ("Bob asked me ...") -> null. | `proposals.ts` groundedAssignee | RT-11, RT-11b |
| F13 | `sanitizeTitle` (NFKC, invisible/Cf chars removed, Cyrillic/Greek look-alikes folded inside mixed-script words only) on every model title; `titleKey` = sanitizeTitle + the UNCHANGED `normalizeTaskTitle`, used for proposal dedup, the on-board check (board titles mapped through it too) and Approve's duplicate screen. `normalizeTaskTitle` itself is not touched. | `proposals.ts` sanitizeTitle/titleKey; `engine.ts` | RT-7, RT-7b, RT-25, RT-25b |
| F14 | New store read `priorRelated(owners, ref, normTitle)` (rows of ANY state referencing this source item + dismissed rows with this exact key). The engine suppresses a candidate that is a reworded version of a to-do already recorded from the SAME item (`similarTitleKeys`: content-word Jaccard >= 0.6 AND identical number tokens). Store `upsert` is unchanged. | `proposals.ts` ProposalStore/similarTitleKeys; `proposals-store.server.ts` priorRelated; `engine.ts` | RT-24; `F14` over-match negative (Q3 vs Q4 still proposed); SQL checks in task-proposals-sql.test.ts |
| F15 | **Decision taken (reversible):** a DISMISSED to-do (exact key) is not proposed again from ANY source. Consistent with OQ-9 "one proposal, many source refs". To revert: drop the `dismissed` clause in `proposeFromSource` (engine.ts). The store-level SQL test "AC-5.21 same text from a NEW source item after a dismissal -> a new proposal" still passes because the store contract is unchanged; the suppression is the engine's. | `engine.ts` | RT-24b |
| S4 | After a successful create, `finishApprove` is retried once; if it still fails the lease is released at once, so the owner's retry re-reads the board and links the task just created (`alreadyOnBoard`) instead of waiting out the 90s lease. | `engine.ts` approveProposal | `S4` checks in task-proposals.test.ts |
| S5 | `[onedrive-feed] teams state write failed` logs only `pg_<SQLSTATE>` or the error class, never `err.message`. The two older lines in the same file (main code) are unchanged. | `onedrive-feed.server.ts` | (suspected; no RT test) |

Red-team fixture note: `scripts/redteam-correspondence.test.ts` `memStore` gained ONE method, `priorRelated`, an
in-memory model of the new store contract (same as task-proposals.test.ts's twin). No assertion, input or expected
value in that file was changed. Without the method RT-24/24b cannot be satisfied by any engine change, because the
fixture's `upsert` keys on the exact title and has no read of decided rows.

### Fix-pass suite results (head `1abbce6b`, 2026-11-13, isolated worktree)

| suite | runner | result |
|---|---|---|
| redteam-correspondence.test.ts | bun | **49 passed, 0 failed** (was 16/33 at `8475140c`) |
| task-proposals.test.ts | bun | **164 passed, 0 failed** |
| correspondence-ingest.test.ts | bun | **148 passed, 0 failed** |
| task-proposals-sql.test.ts | bun, real PostgreSQL 16 (`/usr/lib/postgresql/16`, throwaway initdb) | **45 passed, 0 failed** |
| correspondence-ledger-sql.test.ts | bun, real PostgreSQL 16 | **50 passed, 0 failed** |
| onedrive-feed.test.ts | bun | **all passed** (the one "FAIL" grep hit is the section title "I. EDS FAILS, FEED LOADS") |
| inbound-email.test.ts | bun | **72 passed, 0 failed** |
| attention.test.ts | tsx@4.19.2 | **15 PASS, 0 FAIL**, rc 0 |
| attention-focus.test.ts | tsx@4.19.2 | **all passed** (19 PASS) |
| cross-app-turn-gate.test.ts | bun | **92 passed, 0 failed** |
| fireflies-minutes.test.ts | bun | 64 PASS / **3 FAIL: G3, G5, G8** -- the same three recorded on untouched main (IMPL-correspondence-ingest.md); not from this branch |
| `npx tsc --noEmit -p .` | tsc | **clean** (rc 0, no output) |

No production fix was needed in this step. (After the F5 isolating checks below, task-proposals is **166 passed, 0 failed**.)

### Fix-pass mutation proofs (`mutate.sh`, controlled; anchors generated from the live source lines, never typed)

Exit 0 = FIRED with an equivalent comment-only control (the failure is about behaviour, not the file's
identity). 1 = INERT. 3 = NOT-APPLIED (nothing tested). Every run restored the file to HEAD and re-ran the
test command clean. Rows are in run order, and every non-0 row is kept.

| guard | file | mutation | test that failed | exit code |
|---|---|---|---|---|
| F1 teams opt-in (optInFile) | `external-feeds/onedrive-feed.ts` | `` if (!v \|\| typeof v !== "object" \|\| Array.isArray(v)) return { enabled: false, ... `` -> `` if (false) return { enabled: false, path: fallback }; `` | `` RT-22 `"teams": false` `` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| F2 sent opt-in (optInFile) | `external-feeds/onedrive-feed.ts` | `` sent: optInFile(j.sent, SENT_PATH_DEFAULT, file), `` -> `` sent: file(j.sent, SENT_PATH_DEFAULT), `` | `RT-22c` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| F8 hidden-HTML strip | `external-feeds/onedrive-feed.ts` | `` const visible = stripHiddenElements( `` -> `` const visible = String( `` | `RT-13` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| F19 numeric entity decode | `external-feeds/onedrive-feed.ts` | `` return String.fromCodePoint(cp); `` -> `` return whole; `` | `RT-14` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| F18 reply-prefix strip | `external-feeds/onedrive-feed.ts` | `` const next = s.replace(/^\s*(re\|fw\|fwd\|aw\|tr\|wg\|sv\|rv\|antw)(\[\d+\])?\s*:\s*/i, ""); `` -> `` const next = s; `` | `RT-23` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| F9 non-English header cut | `email/inbound-email.ts` | `` const HDR_FROM = /^\s*(From\|De\|Von\|Van\|Da\|Od\|...)\s*:\s/i; `` -> `` const HDR_FROM = /^\s*(From)\s*:\s/i; `` | `RT-12` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| F16 null sender -> fromOwner null | `external-feeds/teams-log.ts` | `` fromOwner: owners.size && who.id ? owners.has(who.id) : null, `` -> `` fromOwner: owners.size ? owners.has(who.id) : null, `` | `RT-16` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| F17 URL strip before ask test | `correspondence/bell.ts` | `` bodyText: m.text.replace(/\b(?:https?:\/\/\|www\.)\S+/gi, "[link]") `` -> `` bodyText: m.text `` | `RT-17` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| S2 per-chat owner presence | `correspondence/bell.ts` | `` const ownerMessagesExported = thread.some((m) => m.fromOwner === true); `` -> `` ... = teams.some(...) `` (the old cross-chat rule) | `AC-7.1 fixture: exactly ONE open row` (correspondence-ingest.test.ts) | **0** FIRED (control EQUIVALENT) |
| F3 validYmd round-trip | `proposals/proposals.ts` | `` return utcToYmd(ymdToUtc(ymd)) === ymd ? ymd : null; `` -> `` return ymd; `` | `RT-8` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| F3 per-row write isolation | `proposals/engine.ts` | `` out.failed++; `` -> `` throw code("proposals:store_failed"); `` | `F3 ...and the OTHER to-do` (task-proposals.test.ts) | **0** FIRED (control EQUIVALENT) |
| F4 number grounding | `proposals/proposals.ts` | `` if (/\d/.test(w) && !evTokens.has(w)) return "task_number_not_grounded"; `` -> `` if (false) return ...; `` | `F4 numbers:` (task-proposals.test.ts) | **0** FIRED (control EQUIVALENT) |
| F4 strict majority | `proposals/proposals.ts` | `` return hit * 2 > tw.length ? "ok" : "task_not_grounded"; `` -> `` return hit > 0 ? "ok" : ...; `` | `F4 majority:` (task-proposals.test.ts) | **0** FIRED (control EQUIVALENT) |
| F5 min evidence words -- BEFORE the isolating checks | `proposals/proposals.ts` | `` evidence.length < EVIDENCE_MIN \|\| words(evidence).length < EVIDENCE_MIN_WORDS `` -> `` evidence.length < EVIDENCE_MIN `` | `F5 size:` (task-proposals.test.ts) | **1** INERT (see notes) |
| F6 whole-word stem (no 5-letter prefix) | `proposals/proposals.ts` | `` if (/\d/.test(w)) return w; `` -> `` ...; if (w.length > 5) return w.slice(0, 5); `` (main's prefix stem) | `F6 a prefix collision` (task-proposals.test.ts) | **0** FIRED (control EQUIVALENT) |
| F5 min evidence words (>= 4) | `proposals/proposals.ts` | words floor removed (as above) | `F5 size (words)` (task-proposals.test.ts) | **0** FIRED (control EQUIVALENT) |
| F5 min evidence chars (>= 15) | `proposals/proposals.ts` | `` evidence.length < EVIDENCE_MIN \|\| `` removed | `F5 size (chars)` (task-proposals.test.ts) | **0** FIRED (control EQUIVALENT) |
| F7 negation refusal | `proposals/proposals.ts` | `` if (negatesAction(sentence.text, at - sentence.start, evidence, title)) { `` -> `` if (false) { `` | `RT-4` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| F10 due_text date-words only | `proposals/proposals.ts` | `` dueRaw && isDateWords(dueRaw) && ... `` -> `` dueRaw && ... `` | `RT-10` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| F11 negated date term dropped | `proposals/proposals.ts` | `` terms.filter((t) => !negated(t)) `` -> `` terms.filter((t) => true) `` | `F11 every date term negated` (task-proposals.test.ts) | **0** FIRED (control EQUIVALENT) |
| F12 assignee role -- wrong test named | `proposals/proposals.ts` | `` return roles.some((r) => re(r).test(ev)) ? a : null; `` -> `` return a; `` | `RT-11b` (redteam-correspondence.test.ts) | **1** INERT (see notes) |
| F12 assignee role required | `proposals/proposals.ts` | same mutation | `F12 a name that is only the RECIPIENT` (task-proposals.test.ts) | **0** FIRED (control EQUIVALENT) |
| F12 requester veto ("Bob asked me") | `proposals/proposals.ts` | `` if (re(...REQUESTER_VERBS...).test(ev)) return null; `` -> `` if (false) return null; `` | `RT-11b` (redteam-correspondence.test.ts) | **1** INERT -- NOT PROVEN (see notes) |
| F13 sanitizeTitle (NFKC + invisible strip) | `proposals/proposals.ts` | `` String(raw ?? "").normalize("NFKC").replace(INVISIBLE, "") `` -> `` String(raw ?? "") `` | `RT-7` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| F13 titleKey uses sanitizeTitle | `proposals/proposals.ts` | `` normalizeTaskTitle(sanitizeTitle(title)) `` -> `` normalizeTaskTitle(title) `` | `F13 titleKey folds` (task-proposals.test.ts) | **0** FIRED (control EQUIVALENT) |
| F14 reworded re-extraction suppressed | `proposals/engine.ts` | `` const reworded = prior.find(...similarTitleKeys...) `` -> `` const reworded = undefined as any; `` | `RT-24` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| F15 dismissed suppressed cross-source | `proposals/engine.ts` | `` const dismissed = prior.find(...) `` -> `` const dismissed = undefined as any; `` | `RT-24b` (redteam-correspondence.test.ts) | **0** FIRED (control EQUIVALENT) |
| S4 lease release after finishApprove fails | `proposals/engine.ts` | `` await deps.store.releaseApprove(id).catch(() => {}); `` -> `` void 0; `` | `S4 ...and the lease is RELEASED` (task-proposals.test.ts) | **3** NOT-APPLIED (anchor matched 2 places) |
| S4 lease release after finishApprove fails | `proposals/engine.ts` | `` if (!done) { await deps.store.releaseApprove(id)... `` -> `` if (!done) { void 0; `` (unique 2-line anchor) | `S4 ...and the lease is RELEASED` (task-proposals.test.ts) | **0** FIRED (control EQUIVALENT) |

Notes on the non-0 rows (none of them is a broken guard):
- **F5 INERT -> split.** The only F5 test ("send the deck") is 3 words AND 13 characters, so each floor
  masked the other and neither could be proved alone. Two isolating checks were added to
  `task-proposals.test.ts`: `F5 size (chars)` (4 words, 13 chars) and `F5 size (words)` (22 chars, 2 words).
  No existing check was changed. Both floors then FIRED.
- **F12 role mutation INERT against RT-11b.** The wrong test was named: "Bob asked me ..." returns at the
  requester check before the role check runs. Re-run against `F12 a name that is only the RECIPIENT`: FIRED.
- **F12 requester veto: INERT, NOT PROVEN.** Removing the line changes no tested answer, because on "Bob asked
  me ..." / "Bob asked Dana ..." no role pattern matches either. The line IS reachable. Probed directly,
  `groundedAssignee("Bob", "Ask Bob to send the deck, Bob said he can.")` returns null, where the hand-off role
  alone would give "Bob". So today it only vetoes inputs where a role did match: a recall loss (no
  assignee shown, display-only), not a safety gain. Observation only; not changed in this pass.
- **S4 NOT-APPLIED -> re-run.** The release line appears twice in `engine.ts` (lines 242 and 283). Re-anchored
  on the unique `if (!done) {` + release block: FIRED.
