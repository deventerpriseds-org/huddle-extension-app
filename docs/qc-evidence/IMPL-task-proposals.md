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
