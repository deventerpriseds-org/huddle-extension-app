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
