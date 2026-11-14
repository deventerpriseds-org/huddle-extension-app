<!--
WHAT:          Implementation log for part B of the correspondence redesign: meeting-minutes TRIAGE (AC section R5,
               spelling rows S-C, and the R9 flag / zero-call ACs that apply to R5).
WHY:           Owner 2026-11-14: "a ping when I receive meeting minutes with a drop list ... pick it, type who the
               action items are for or skip it. Then and only then can they go in the meeting action item queue."
SUPERSEDES:    the automatic Fireflies-transcript -> proposals path (engine.ts runTranscriptProposals), which the
               owner rejected. Its tests (scripts/task-proposals.test.ts section H) are replaced, see below.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch claude_redesign-meeting-triage (from claude_task-proposals @ b7ddbdca);
               ACs: docs/qc-evidence/AC-correspondence-redesign.md on claude_ac-correspondence-redesign @ 5b8ba7d3.
-->

# IMPL: meeting-minutes triage (R5)

Written as the work happens. Synthetic fixtures only.

## Baseline (before any change, at b7ddbdca)

| Suite | PASS | FAIL |
|---|---|---|
| scripts/task-proposals.test.ts | 204 | 0 |
| scripts/task-proposals-sql.test.ts (PG16) | 45 | 0 |
| scripts/redteam-correspondence.test.ts | 77 | 0 |
| scripts/correspondence-ingest.test.ts | 149 | 0 |
| scripts/fireflies-minutes.test.ts | 64 | **3 (pre-existing: G3, G5, G8)** |
| scripts/fireflies-queue-sql.test.ts | 14 | 0 |
| scripts/proposals-preview.test.ts | 6 | 0 |
| scripts/correspondence-ledger-sql.test.ts | 50 | 0 |
| `npx tsc --noEmit -p .` | clean | |

The 3 fireflies-minutes failures exist before any change in this branch (subject wording G3, concurrency G5,
update email G8). Not touched by this work.
