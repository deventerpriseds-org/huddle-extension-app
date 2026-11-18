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

### 1. Source change (write-time invariant, selection, click, D5)

- `engine.ts`: additive `ProposeResult.suppressedBy[] = {id, reason: reworded|dismissed}` (absent when nothing suppressed).
- `proposals.ts`: runtime `REJECT_REASONS` with a compile-time check that it equals the `RejectReason` union.
- `action-classify.ts`: `notCheckedReason` gains `no_task_record`; new optional `noTaskRecordKinds`, `suppressedBy`.
- `pipeline.ts`: pure `proposeOpenVerdict` (the adapter's try loop, now testable offline), `storedRejectKinds`,
  `verdictAfterPropose` (the ONE place `finish` turns a propose outcome into the stored verdict). `isHeldVerdict` widened
  to HELD_REASONS + open-with-no-home (no id and not `onBoard === true`; or id + null section, G4-b), section computed
  with the SAME `actionSectionFor` call the builder makes. `isOpenWithIdVerdict` + `proposalExists` decide G4-a inside
  the thread lock. `buildCandidates` sets `proposalMissing` when a current verdict's id is absent from the proposal read.
- `actions.ts`: `HELD_REASONS` += `no_task_record`; read-time held reasons `proposal_gone` (G4-a) and `no_section`
  (G4-b); per-reason sentence and quote label (`HELD_QUOTE_LABELS`, AC-14); the open branch routes no-home items to
  `pushHeld` instead of `pushUnchecked`.
- `actions.server.ts`: the classify adapter delegates to `proposeOpenVerdict`; D5 SQL widened with
  `IN ('quote_not_found','no_task_record')` (exact strings).
- `ActionsView.tsx`: the held quote label reads `row.heldQuoteLabel` (falls back to the F5 label).

Existing tests whose expectation WAS the orphaning behaviour, changed (owner-directed scope, not silent): F-2, U-1,
U-2, U-3, U-7 (u-nobacking moves unchecked -> held), "F5 a verdict that is not held (open)" and RT-25 (now an open
verdict WITH a live proposal id is the refused shape), F5-3/F5-4 (label expression). After: actions-view 221/0, tsc clean.

Known edge (recorded, not changed): when the proposal read itself FAILS (`loadProposalsById` catch), every open
verdict with an id reads as `proposal_gone` held instead of unchecked. The click still re-checks with `proposalExists`
(a throw fails the click, nothing stored; a live id is refused), so nothing wrong is written.
