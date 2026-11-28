# FIX — red-team findings RTL-3, RTL-4, RTL-6 (actions label auto-task)

<!--
WHAT:       Fix notes for the three red-team attacks that succeeded against the Outlook-label auto-task pass.
WHY:        REDTEAM-actions-label-autotask.md: RTL-3, RTL-4, RTL-6 failed (attack succeeded) at 35b1f154.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   scripts/actions-view.test.ts RTL- block; mutation table below.
-->

Baseline at 35b1f154: `bun scripts/actions-view.test.ts` -> **331 passed, 3 failed** (RTL-3, RTL-4, RTL-6).

## RTL-3 — cap without the gaveUp flag (FIXED, commit e9f3dc91)

- New pure `recordIsTerminal(r)` = `done || gaveUp || attempts >= AUTO_TASK_MAX_ATTEMPTS`; both the pass's skip check
  and `wouldAutoTaskCount` call it. Added `RTL-3b` (a test, additive) so the count path has its own guard.
- After: `actions-view` 333 passed, 2 failed (RTL-4, RTL-6 still open).

| mutation (scratchpad label-RT/) | test | exit | verdict |
|---|---|---|---|
| drop ` \|\| r.attempts >= AUTO_TASK_MAX_ATTEMPTS` in recordIsTerminal | RTL-3 | 0 | FIRED (control EQUIVALENT) |
| same | RTL-3b | 0 | FIRED (control EQUIVALENT) |
| pass skip check back to `done \|\| gaveUp` only | RTL-3 | 0 | FIRED (control EQUIVALENT) |
| wouldAutoTaskCount back to `done \|\| gaveUp` only | RTL-3b | 0 | FIRED (control EQUIVALENT) |

## RTL-4 — create + record write both failing (FIXED, commits a9d4c140, RTL-4b test)

- Record-then-act: immediately before `approveProposal` (the only path to createTask) the pass writes
  `{proposalId, attempts: attempts+1, done:false, outcome:"attempting"}`. If that write throws: counted as
  `autotask:record_failed` + `failed`, and `continue` -- **no create this pass**. The later `fail()` writes the same
  attempts value (no double count); `finish()` on success overwrites with `done:true`.
- New outcome kind `attempting` (kind code only, never text). A crash mid-create reads as one used attempt; a
  create that DID land is caught next pass by the proposal being `approved` (`alreadyDone`).

**Contradiction found and how it was resolved (read this).** The brief's "no create when the write fails" makes the
OLD RTL-5 (`saveRecord` ALWAYS throws, create succeeds, expected exactly 1 create) impossible: with the ledger always
down, record-then-act creates 0. RTL-5's name states its scenario as "record write fails AFTER a successful create".
RTL-5 was changed to exactly that (writes fail only once a create has happened); its expectation (1 task over 3
passes) is unchanged. The always-down case is now RTL-5b, pinned to **0 creates, proposal still proposed**. No
assertion was loosened; RTL-5b is stricter than the old RTL-5 for the always-down case.

| mutation | test | exit | verdict |
|---|---|---|---|
| drop the `continue` after a failed pre-create write (fall through to create) | RTL-5b | 0 | FIRED (control EQUIVALENT) |
| same | RTL-4 | 0 | FIRED (control EQUIVALENT) |
| remove the pre-create write (`void nextAttempts`) | RTL-4 | 0 | FIRED (control EQUIVALENT) |
| same | RTL-4b | 0 | FIRED (control EQUIVALENT) |

After: `actions-view` 336 passed, 1 failed (RTL-6).

## RTL-6 — once per conversation (FIXED, commit 36543582)

- Owner-facing default (orchestrator-chosen, safe, reversible): **once per conversation**. Recorded as the dated
  "AC-3.21 note" row in AC-actions-label-autotask.md.
- At pass start, the pass maps each conversation key to the proposal ids its sibling emails' persisted records point
  at. Per email (after the on-board check, before the verdict-proposal check), `store.getMany` on those ids; ANY in
  `approved | completed | dismissed | delegated` -> outcome `decided`, no proposal, no create, any title. The judge's
  conversation-key proposals were already covered by the existing `priorRelated(conversationKey)` + `sameItem`.
- Only records as read at pass START feed the map, so AC-6.3 (a sibling tasked earlier in the SAME pass links as
  `on_board`) is unchanged.
- Added `RTL-6b` (additive): a sibling decided under ANOTHER title, one case per decided state -> 0 creates; a still
  `proposed` sibling, or another conversation -> 1 create (no over-match).
- Limit (by design, not a defect of this fix): the sibling must still be a loaded row (labelled, content not purged,
  in the plan window so it has a conversation key). A sibling whose content was purged no longer contributes.

| mutation | test | exit | verdict |
|---|---|---|---|
| `if (false && convDecided)` (check disabled) | RTL-6 | 0 | FIRED (control EQUIVALENT) |
| same | RTL-6b | 0 | FIRED (control EQUIVALENT) |
| sibling check also requires the same title | RTL-6b | 0 | FIRED (control EQUIVALENT) |
| sibling check accepts only `approved` | RTL-6b | 0 | FIRED (control EQUIVALENT) |
| conversation map never filled | RTL-6 | 0 | FIRED (control EQUIVALENT) |

After: `actions-view` 338 passed, 0 failed.

