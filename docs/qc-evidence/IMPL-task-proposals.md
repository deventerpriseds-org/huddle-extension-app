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
