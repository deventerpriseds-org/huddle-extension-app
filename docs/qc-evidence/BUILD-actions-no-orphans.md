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

### 2. Guards added

- `scripts/actions-view.test.ts`: 31 offline checks `NO-*` (write time AC-1..AC-11, the P-table, spelling table
  S-1..S-16 + G4-b at selection AND click, AC-12..AC-19, AC-16 reconciliation, held click AC-21..AC-26, G4-a / G4-b).
- `scripts/actions-view-server.test.ts`: 9 real-PostgreSQL checks: NO-AC9, NO-G4a-S1, NO-G4a-S2, NO-AC10, NO-AC12,
  NO-AC22, NO-AC25 (incl. S-13 spellings and another owner), NO-S17 (observed: `->>` on a JSON null IS NULL and
  `NULL IN (...)` is NULL), NO-AC7 (held-click log line).
- Harness note: two Teams chats from the same sender with the same >=40-char quote are collapsed by the existing
  loop-2 D-2 de-dup; the legacy-row chat was given its own synthetic ask (first run failed for that reason, not a bug).

### 3. Mutation table (mutate.sh, anchors in the session scratchpad `orph-B/`)

| id | file | mutation (defect reinstated) | must-fail test | verdict |
|---|---|---|---|---|
| M01 | pipeline.ts | no-id outcome stored `open` again | NO-AC1 | FIRED, control EQUIVALENT |
| M02 | pipeline.ts | held verdict drops the model's to-do | NO-AC2 | FIRED, control EQUIVALENT |
| M03 | pipeline.ts | `""` id accepted as a home | NO-AC3c | INERT first (adapter pre-filters `""`); NO-AC3c added; then FIRED, control EQUIVALENT |
| M04 | pipeline.ts | created outcome carries a kinds field | NO-AC5 | FIRED, control EQUIVALENT |
| M05 | pipeline.ts | kinds not filtered to RejectReason | NO-AC6 | FIRED, control EQUIVALENT |
| M06 | pipeline.ts | propose throw stored as held | NO-AC8 | FIRED, control EQUIVALENT |
| M07 | pipeline.ts | reworded link removed | NO-AC9 (offline) | FIRED, control EQUIVALENT |
| M08 | pipeline.ts | dismissed suppression not hidden | NO-AC10 (offline) | FIRED, control EQUIVALENT |
| M09 | actions.ts | open-no-id back to unchecked | NO-AC12 | FIRED, control EQUIVALENT |
| M10 | actions.ts | `no_task_record` not a held reason | NO-AC13 | FIRED, control EQUIVALENT |
| M11 | actions.ts | open + id + no section back to unchecked | NO-G4b-1 | FIRED, control EQUIVALENT |
| M12 | actions.ts | deleted-proposal reason lost | NO-G4a-1 | FIRED, control EQUIVALENT |
| M13 | actions.ts | held ignores the owner's decision | NO-AC17 | FIRED, control EQUIVALENT |
| M14 | actions.ts | `bad_shape` made held | NO-AC19 | FIRED, control EQUIVALENT |
| M15 | pipeline.ts | click ignores `onBoard:true` | NO-S | FIRED, control EQUIVALENT |
| M16 | pipeline.ts | click uses truthy `onBoard` (S-6) | NO-S | FIRED, control EQUIVALENT |
| M17 | pipeline.ts | click refuses G4-b | NO-G4b-2 | FIRED, control EQUIVALENT |
| M18 | pipeline.ts | click never treats a deleted proposal as held | NO-G4a-2 | FIRED, control EQUIVALENT |
| M19 | pipeline.ts | click skips the existence check | NO-G4a-3 | FIRED, control EQUIVALENT |
| M20 | pipeline.ts | click refuses the legacy rows | NO-AC22 (offline) | FIRED, control EQUIVALENT |
| M21 | actions.ts | a G4-b item lands in two groups | NO-AC16 | FIRED, control EQUIVALENT |
| M22 | actions.server.ts | D5 SQL without `no_task_record` | NO-AC25 (real SQL) | FIRED, control EQUIVALENT |
| M23 | pipeline.ts | builder drops `proposalMissing` | NO-G4a-S1 (real SQL) | FIRED, control EQUIVALENT |
| M24 | actions.server.ts | the real adapter tries no titles | NO-AC9 (real SQL) | FIRED, control EQUIVALENT |

### 4. Final gates (2026-11-18 ~05:22Z)

| gate | result |
|---|---|
| scripts/actions-view.test.ts | 252 passed, 0 failed (baseline 221) |
| scripts/actions-accuracy.test.ts | 96 passed, 0 failed (unchanged) |
| scripts/report-saves-verdicts.test.ts | 39 passed, 0 failed (unchanged) |
| scripts/actions-view-server.test.ts (real PostgreSQL 16) | 45 passed, 0 failed (baseline 36) |
| npx tsc --noEmit | exit 0, no output |
| npm run build | exit 0 |

### 5. NOT DONE / not proven (budget reached)

- AC-4 (no_task_record write goes through `tx.store`): no new test. The write path is the same `tx ? tx.store : storeVerdict`
  line as `open`; NO-AC9/NO-AC10 run through the real lock, but no check names the writer.
- AC-18: has a test (NO-AC18), NOT mutation-proved. The open branch's `if (c.onBoard) continue` is backed up by
  `pushHeld`'s own `onBoard` return, so removing either alone is behaviour-equivalent.
- AC-21 real SQL with Add as task: NOT run (it reaches journey's create). Offline NO-AC21 + real Dismiss (NO-AC22, NO-G4a-S2) only.
- AC-23, AC-27..AC-29 for the new kinds: no new tests; the existing F5-DEL / XF-4 / RK tests cover the shared code.
- AC-30: no call counter test (two tries max by construction in `proposeOpenVerdict`).
- AC-7: checked by a code read of the heartbeat line and a captured held-click log; the heartbeat line was not captured live.
- `scripts/report-saves-verdicts.test.ts` NOT extended. Behaviour note for the owner: with report saving OFF,
  `inMemoryWrites` proposes nothing, so the report now shows those items as held `no_task_record` (in memory only)
  where it used to show them as open with no proposal. No stored data changes.
