<!--
WHAT:          red-team pre-pass findings (Tier 1, before the PR) for AC-actions-no-orphans: one row per attack.
WHY:           Tier 1 rule: an adversarial pass from the spelling table S-1..S-17 / propose table P-1..P-17 before the PR.
SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch claude_actions-no-orphans, base 454f3f90. Tests NORT-1..NORT-8 in scripts/actions-view.test.ts,
               NORT-9 / NORT-10a / NORT-10b in scripts/actions-view-server.test.ts (local PostgreSQL 16). Synthetic data only.
-->

# Red-team: Actions items never orphaned

Source was NOT changed. A BROKEN row has a test that asserts the correct behaviour and FAILS now.

| # | Attack (input) | Expected | Actual | Verdict | Test |
|---|---|---|---|---|---|
| 1 | Held click + selection with `notCheckedReason` `No_Task_Record`, `"no_task_record "`, `no-task-record`, `["no_task_record"]`, `true`, `{r:...}` | click refused, 0 proposals; selection unchecked | same | held | NORT-1 |
| 2 | `onBoard:"true"` (string) on an open no-id verdict (S-6) | held; click accepted | same | held | NORT-2 |
| 3 | `storedRejectKinds` with `__proto__`, `constructor`, wrong case, a number, null, a duplicate | only `["evidence_not_in_source"]` | same | held | NORT-3 |
| 4 | Try 1 rejected then try 2 suppressed-dismissed; suppression naming no proposal; reworded with an empty id | onBoard + `dismissed` marker, no kinds; the other two hidden WITHOUT the marker | same | held | NORT-4 |
| 5 | `verdictAfterPropose` with a numeric id; with an id AND onBoard + dismissed | numeric: held no_task_record; id wins: open + id, no onBoard, no marker | same | held | NORT-5 |
| 6 | Store write of the held verdict throws (P-15 variant: the failure is in the store, not in propose) | failures 3, notChecked 0, still pending | same | held | NORT-6 |
| 7 | G4-b verdict (`open` + id + `kind:"none"`) whose proposal is DECIDED; held click on its key (selection lists it nowhere, NO-AC17) | refused "That item isn't in your list.", act() not called | accepted: `act("approve", prop-decided)` runs. `isHeldVerdict` has no proposal-state input. Backstop in real use: `approveProposal` answers `alreadyDone` on a non-`proposed` row, so a decided proposal is not revived, but the click reports ok. Same shape pre-exists for a `quote_not_found` / `no_task_record` verdict with a decided written-back id. | BROKEN (low impact) | NORT-7 (FAILS) |
| 8 | Mixed: proposalMissing + onBoard; deleted rescue on a no_task_record; decided no-section; `""` id; none + answered | onBoard hides; rescue held (no_task_record); decided hidden; `""` held; answered only answered; one group each | same | held | NORT-8 |
| 9 | D5 SQL with reason JSON `true`, array, object; status `Not_Checked` | false for all | false for all | held | NORT-9 (real SQL) |
| 10a | Page-read fallback: `chat.task_proposals` unreadable (renamed); click Add as task on the item it shows as held | nothing written; click fails | stored verdict unchanged; `ok:false` (the existence check throws, giving the fixed error) | held | NORT-10a (real SQL) |
| 10b | Same fallback; read the page for an item the owner already DISMISSED | in no group | `["held"]`: `loadProposalsById` swallows EVERY error and returns an empty map, so the dismissed item looks "deleted" (G4-a) and comes back as held `proposal_gone`. Before this change it came back read-only as "Not checked yet". Now it is shown as actionable. The click is safe (row 10a), but the page tells the owner a dismissed item is waiting. | BROKEN | NORT-10b (FAILS) |

Targets with no break found: no item in two groups (NORT-8, plus the existing NO-AC16 property test); no second proposal when one
exists (the existing NO-AC23 / NO-G4a-3 tests; the existence check is owner-scoped, `owner_email = ANY(owners)`, the same scope as the
page read); D5 spellings (NORT-9 plus the existing NO-AC25); heartbeat and report counts (NORT-6, NO-AC1); a store failure never
permanent (NORT-6, NO-AC8); the dismissed marker never hides an item on its own (nothing reads `suppressedBy`; hiding is `onBoard ===
true` only; NORT-4 / NORT-5).
