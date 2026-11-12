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
