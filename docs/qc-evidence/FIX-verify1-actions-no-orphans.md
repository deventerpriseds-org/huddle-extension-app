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
