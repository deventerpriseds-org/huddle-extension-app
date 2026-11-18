<!--
WHAT:          independent verification, loop 1, of the Tier 1 change "no Actions item is ever left with no home".
WHY:           Tier 1 change: an independent verifier is required before merge.
SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch claude_actions-no-orphans at 888bd4c5, checked out detached. Synthetic data only (public repo).
               No billed model calls and no workflow dispatches. Local PostgreSQL 16 (the server suite's own).
-->

# VERIFY actions-no-orphans, loop 1

Head under test: `888bd4c5`. Contract: `AC-actions-no-orphans.md`.

## Verdict

**FIX FIRST**: (1) the real-SQL guard `NORT-7 GUARD` passes for the wrong reason, so F6 is INERT because the TEST is broken, not because the check is redundant. (2) Recommended: the held click still acts on a kept proposal the owner marked "Wrong?". This already happened before the change.

## Claims

| # | Claim | Result | Evidence |
|---|---|---|---|
| 1 | Invariant in `finish`. No id and not on the board gives `not_checked` / `no_task_record` with kinds only. A store failure stays retryable. | PASS | `verdictAfterPropose` is called at `pipeline.ts` ~305, inside the existing `try`. A throw returns `"failed"` and nothing is stored. `proposeFromSource` throws `proposals:store_failed` whenever `failed>0` (`engine.ts` ~143), so a store failure never reaches `rejectedKinds`. Probe: `{id:""}`, `{id:0}` and `{id:null}` all store `not_checked`/`no_task_record`/`proposalId:null`. The kinds input `["evidence_not_in_source","SECRETWORD","task_not_grounded","evidence_not_in_source"]` was stored as `["evidence_not_in_source","task_not_grounded"]` with no leak. M01 FIRED, control EQUIVALENT (exit 0). |
| 2 | Legacy `open` rows with no proposal are held on page load, with no re-judge. | PASS | `selectActionItems` sends `!c.proposalId` to `pushHeld(... "no_task_record")`. Real SQL `NO-AC12 GUARD` passes with model calls +0. M09 FIRED, control EQUIVALENT (exit 0). |
| 3 | G-1: a reworded to-do links its earlier proposal. Dismissed-elsewhere stays hidden. | PASS | Code: `engine.ts` adds the additive `suppressedBy`, and `proposeOpenVerdict` maps reworded to the prior id and dismissed to `onBoard:true` plus a marker. Real SQL `NO-AC9 GUARD` (one row, the earlier id) and `NO-AC10 GUARD` (in no group) both pass. |
| 4 | G4-a / NORT-10b / G4-b. | PASS | G4-a: `proposalMissing` is set only when `proposalsRead !== false`. Real SQL `NO-G4a-S1`/`S2` pass. In the probe the click is refused while the proposal is live, refused when the `proposalExists` dep is absent, and on a gone proposal makes a fresh id that it writes back (status stays `open`). **NORT-10b `["unchecked"]` is correct against the brief.** Before the change, `loadProposalsById` swallowed the error into an empty map, so the candidate had `proposalId:null`, and selection's old `!c.proposalId` branch called `pushUnchecked`. Read-only "Not checked yet" is therefore exactly the pre-change behaviour, and `[]` was a wrong red-team expectation. F2 FIRED, control EQUIVALENT (exit 0). G4-b: probe Teams open + id + `kind:null` gives held, the click re-uses the id, and the decided state is in no group. |
| 5 | Held click: D5 exact set, listed-state refusal, re-use, owner scope, F6. | **PARTIAL (FAIL on F6)** | D5 SQL is `status='open' OR (status='not_checked' AND reason IN ('quote_not_found','no_task_record'))`. Real SQL `NO-AC25` / `NORT-9` cover bad_shape, JSON null, case/space/dash, JSON true/array/object and another owner (all false). M22 FIRED, control EQUIVALENT (exit 0). Listed states come from `proposalStateListed` (`proposed`, `untriaged`), and the pure guard F5/F7 holds. Re-use: probe `acts=["dismiss:prop-g"]`, no propose. Owner scope: `ownedScope` plus an owner-scoped state query (code read; no real-SQL test of another caller on the held click). **F6, traced:** I removed `proposalState: proposalStateOf` and added debug prints. The real `NORT-7` click prints `no-unit`, which means it is refused at `actions.server.ts:644` (`if (!u)`): the thread unit is not in the plan after the test rewrites the verdict, so `actOnHeldItem` never runs. **The fixer's inference that D5 refuses it is wrong.** The test still passes with `kind:null` and the mutation applied. So the server wiring of `proposalState` is untested, and `g7 = []` is not evidence that `ownerDecided` hides G4-b. |
| 6 | No double listing, counts right, decided never re-listed, `onBoard` never listed. | PASS | Probe: 20,000 candidates over 14 shapes in 10 ms, 0 items in two groups. `notChecked === unchecked.length`, `heldCounts.all === held.length`, tab all = rows + unchecked + held, and email + teams + meeting = all. Per shape: decided gives `-`, `onBoard` gives `-`, corrected gives `corrected` only, unread gives `unchecked`, and `No_Task_Record` / bad_shape give `unchecked`. The page read adds no query per item (one `loadProposalsById`). |
| 7 | Regressions; the changed old tests are not weakened. | PASS | F-2, U-1, U-2 and U-3 each move `u-nobacking` (open, nothing backs it) from unchecked to held. That is AC-12 exactly, and U-1 now also asserts the held key. U-7 keeps 6 because held is now passed to `tabCounts`. "F5 ... not held (open)" and RT-25 now use open WITH a proposal, which is still the refused shape: open with no id is held by design. F5-3/F5-4 change only the label expression (AC-14). All F1-F5 / X / RK tests in both suites pass. |
| 8 | Suites. | PASS | actions-view 262/0, actions-accuracy 96/0, report-saves-verdicts 39/0, actions-view-server 49/0 (real PG), `npx tsc --noEmit` exit 0, `npm run build` exit 0. |
| 9 | Mutations re-run with `mutate.sh`. | PASS (4/4) | M01 `NO-AC1 GUARD` exit 0 FIRED/EQUIVALENT. M09 `NO-AC12 GUARD` exit 0 FIRED/EQUIVALENT. M22 `NO-AC25 GUARD` (real DB) exit 0 FIRED/EQUIVALENT. F2 `NORT-10b GUARD` (real DB) exit 0 FIRED/EQUIVALENT. |

## Adversarial extras

| Probe | Observed |
|---|---|
| Teams legacy orphan | held, `heldCounts.teams` 1, tab teams 1, `no_task_record` sentence. |
| Held item corrected with "Wrong?" (rescue proposal still `proposed`) | Page: in `corrected` only. Held click: `{ok:true}`, `act approve:prop-c`. **The click acts on an item the page does not show as held.** This behaviour predates the change (there was no state check before). The new NORT-7 check does not cover it, because the state stays `proposed`. |
| Open + answeredByReply + no proposal | held only (`admitActionVerdict` never sets answeredByReply on `open`, so this is defensive). |
| Burst of orphans | No new query per item on the page read. The classify pass still makes at most two `proposeFromSource` tries per open verdict, as before. |

## Required before done

1. Repair `NORT-7 GUARD (real SQL)` so its click reaches `actOnHeldItem`: the unit must stay in the plan. Then re-run F6 (remove `proposalState: proposalStateOf`). It must FIRE.
2. (Recommended) Make the held click refuse a kept proposal that has a correction on this item version, using the same rule as `ownerDecided` / `correctionHides`. Otherwise record it as a backlog row.

## Not checked

- Why the NORT-7 unit leaves the plan after the verdict rewrite (assembly not traced). Only the refusal site was observed.
- A real-SQL held click from another owner (code read only).
- Live UI rendering of the per-reason quote label (code read of `ActionsView.tsx` only).
