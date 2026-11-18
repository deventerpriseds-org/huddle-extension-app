<!--
WHAT:          fixes for the loop-1 verifier findings on "no Actions item is ever left with no home" (Tier 1).
WHY:           VERIFY-actions-no-orphans-1.md: FIX FIRST -- (1) NORT-7 GUARD (real SQL) passed for the wrong reason
               (its click was refused at the plan lookup, so the server proposalState wiring was untested, F6 INERT);
               (2) the held click acted on a kept proposal the owner had corrected with "Wrong?" on this item version.
SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch claude_actions-no-orphans, base 7ee020a7. Synthetic data only. No model calls, no dispatches.
-->

# FIX verify-1: actions-no-orphans

Base: `7ee020a7`. Input: `VERIFY-actions-no-orphans-1.md`.

## Fix 1: NORT-7 GUARD (real SQL) reaches the state check

- Observed cause (read, `report-from-ledger.ts` ~466-510 + `.server.ts` ~57): the old fixture DISMISSED the kept
  proposal through the held click, so its `task_proposal_refs` row on the SAME thread made the thread resolved
  (`RESOLVED_PROPOSAL_STATES`), and the unit left the plan. `actOnHeldItemFor` then refused at `if (!u)`.
- New fixture (`scripts/actions-view-server.test.ts`, NORT-7 GUARD): a fresh synthetic Teams chat; its kept proposal is
  upserted with its only ref on ANOTHER thread, verdict = open + that id + `kind:"none"` (G4-b: no section). The test
  first asserts the item is listed `held` while the proposal is `proposed`, then sets it `dismissed` in SQL and
  asserts: unit still in the plan (`threadUnits` finds the key), in no group, click (`dismiss`) refused with the exact
  not-in-list error, 0 new proposals, ledger verdict byte-identical, proposal row (state, updated_at, correction)
  byte-identical.
- Suite: actions-view-server 49 passed, 0 failed.
- F6 via `mutate.sh` (anchor `orph-V1/F6.anchor` = `    proposalState: proposalStateOf,` in `actions.server.ts`,
  replaced by a comment): **exit 0, FIRED (control EQUIVALENT)** on `NORT-7 GUARD (real SQL)`.

## Fix 2: the held click refuses a kept proposal corrected with "Wrong?" on this item version

- `pipeline.ts`: new optional dep `HeldActDeps.proposalCorrection(id)` (the stored `owner_correction` column). In the
  kept-id re-use branch, after the NORT-7 state check: `correctionHides(correctionFor(stored, u.itemKey), u.itemKey)`
  -> `not_held` (the same rule `selectActionItems`' `ownerDecided` uses). A throw -> the fixed error, nothing stored.
- `actions.server.ts`: the ONE owner-scoped read per id now selects `state, owner_correction`; `proposalState` and
  `proposalCorrection` both read it (no extra query).
- Tests: offline `NO-CORR-1 GUARD` (this version / pre-D4 single shape -> refused; withdrawn / other version / none ->
  acted on; both the G4-b open and no_task_record shapes) and `NO-CORR-2` (failing read -> fixed error). Real SQL
  `NO-CORR-S1 GUARD`: a legitimate G4-b held item (held while proposed), then the per-item correction is stored ->
  page lists it only under `corrected`, unit still in the plan, click refused exactly, 0 proposals, verdict and
  proposal row byte-identical, state still `proposed`.
- Found on the way: the first version of NO-CORR-S1 failed 2 of 3 runs (the item in NO group, not even held before the
  correction). Its fixture reused NORT-7's exact message text and to-do on a second thread. Giving each fixture its own
  text and to-do: 4/4 green, and 50/50 on every later run. Inference only (not traced): two threads with identical
  text tie somewhere in the plan / page assembly. Recorded as NOT traced.

## Mutation table (all via `mutate.sh`, anchors in `scratchpad/orph-V1/`)

| id | file : mutation | test | exit | verdict |
|---|---|---|---|---|
| F6 | actions.server.ts : remove `proposalState: proposalStateOf,` | NORT-7 GUARD (real SQL) | 0 | FIRED (control EQUIVALENT), run twice (before and after fix 2) |
| C1 | pipeline.ts : remove the correction check line | NO-CORR-1 GUARD (offline) | 0 | FIRED (control EQUIVALENT) |
| C1s | pipeline.ts : same | NO-CORR-S1 GUARD (real SQL) | 0 | FIRED (control EQUIVALENT) |
| C2 | actions.server.ts : remove `proposalCorrection: proposalCorrectionOf,` | NO-CORR-S1 GUARD (real SQL) | 0 | FIRED (control EQUIVALENT) |

C1s / C2 first returned exit 7 / 6 (UNINFORMATIVE / TREE-NOT-CLEAN): that was the flaky fixture above, not the guard.
Re-run after the fixture fix: exit 0.

## Final gates (head after this commit)

- `bun scripts/actions-view.test.ts`: 264 passed, 0 failed
- `bun scripts/actions-accuracy.test.ts`: 96 passed, 0 failed
- `bun scripts/report-saves-verdicts.test.ts`: 39 passed, 0 failed
- `bun scripts/actions-view-server.test.ts`: 50 passed, 0 failed (real PostgreSQL 16)
- `npx tsc --noEmit`: exit 0
- `npm run build`: exit 0

## NOT DONE

- Why two threads with identical text / to-do intermittently drop one off the page (not traced; fixtures avoid it).
- A real-SQL held click from another owner (still code read only, as in VERIFY-1).
- The propose branch (no kept id): if `proposeFromSource` returns an EXISTING id the owner corrected on this version,
  the click would act on it. Not probed; no evidence it happens.
- `.claude/` ledgers not touched (brief); pushes used `LEDGER_OPT_OUT` for that reason.
