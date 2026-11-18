<!--
WHAT:          build notes for the Tier 1 fix "no Actions item is ever left with no home" (AC-actions-no-orphans.md).
WHY:           owner report "items are being orphaned and never checked" (open verdicts with no proposal sat in the
               read-only "Not checked yet" group forever).
SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:      the four suites named below; mutation table at the end. Synthetic data only (public repo).
-->

# BUILD: actions no-orphans

Base: branch `claude_actions-no-orphans` at 58fa4f92 (on origin/main 04e17dad).

## Baseline (before any change, 2026-11-18 04:30Z)

| suite | result |
|---|---|
| scripts/actions-view.test.ts | 221 passed, 0 failed |
| scripts/actions-accuracy.test.ts | 96 passed, 0 failed |
| scripts/report-saves-verdicts.test.ts | 39 passed, 0 failed |
| scripts/actions-view-server.test.ts (real local PostgreSQL 16) | 36 passed, 0 failed |

## Decisions taken on the gaps

- G-1: ADDITIVE `ProposeResult.suppressedBy` (id + reason per suppressed candidate). Reworded (F14) links the prior
  proposal's id; dismissed (F15) keeps `onBoard:true` plus the marker `suppressedBy:"dismissed"`.
- G-2: `noTaskRecordKinds` on `ActionVerdict`, only with `notCheckedReason:"no_task_record"`.
- G-3: the file's sentence and label, verbatim.
- G-4: IN SCOPE (owner). ACs G4-a / G4-b added to the AC file.
- G-5: S-17 observed in the real-PostgreSQL suite.
- G-6: `no_task_record` counts in `ClassifyResult.notChecked`.

## Log
