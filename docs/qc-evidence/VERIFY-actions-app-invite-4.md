# VERIFY actions-app-invite loop 4

WHAT:       Independent re-check, loop 4, of the app_invite work (PR #277, e0120b93) on CURRENT origin/main after #278.
WHY:        #278 (6226392c) changed the same files (versions email 3 / teams 4; keep-proposal widened to any new status).
SUPERSEDES: VERIFY-actions-app-invite-3.md (verdict SHIP at 04242df2).  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   detached checkout of origin/main 5cc1eb76 (contains 6226392c); commands and outputs below. No model calls,
            no workflow dispatches, synthetic data only (local throwaway PostgreSQL 16 for the server suite).

## Suites on origin/main 5cc1eb76

| suite | expected | observed |
|---|---|---|
| bun scripts/actions-view.test.ts | 221/0 | 221 passed, 0 failed |
| bun scripts/actions-accuracy.test.ts | 96/0 | 96 passed, 0 failed |
| bun scripts/report-saves-verdicts.test.ts | 39/0 | 39 passed, 0 failed |
| bun scripts/actions-view-server.test.ts (local PG 16) | 36/0 | 36 passed, 0 failed |
| npx tsc --noEmit | exit 0 | exit 0, 0 lines of output |

## Claims (reduced depth, code read on origin/main)

| # | claim | evidence | result |
|---|---|---|---|
| 1 | app_invite in category list + schema enum | action-classify.ts:164 `"app_invite"` in ACTION_CATEGORIES; :188 schema `enum: [...ACTION_CATEGORIES]`; :493 admit rejects unknown categories | PASS |
| 2 | hideable, hidden by default | actions.ts:21 HIDEABLE_CATEGORIES includes app_invite; :113 default hideCategories = all four; test H-3, AI-1, AI-2 PASS | PASS |
| 3 | knownHideCategories merged into saved settings | actions.ts:141-144: known = stored field or HIDEABLE_CATEGORIES_V1 (no app_invite), so an older saved list gains app_invite; test H-4 expects `["timekeeping","app_invite"]` and PASSes | PASS |
| 4 | share notice with the person's own request is not app_invite | instructions keep "sharing person's OWN note asking him to do" in step 2, step 3 and Teams; test AI-15 (4 booleans) PASS | PASS |
| 5 | re-judge keeps the earlier proposal | pipeline.ts:243 keepId = prior same key + non-empty proposalId; RK-1 / RK-2 PASS | PASS |
| 6 | dismissed / completed threads not re-judged | #278 hunks in pipeline.ts are only @218, @232 (keepId), @361 (new held actions), @525 (buildCandidates field); threadUnits untouched; report-from-ledger RESOLVED_PROPOSAL_STATES (approved/completed/dismissed/delegated) unchanged by #278; server suite 36/0 | PASS (reduced depth: code-diff + suites, the loop-3 real-SQL probe was not re-run) |
| B | #278 did not lose any app-invite guarantee | see radius below | PASS |

## Radius challenge (#278 widened keepId from `open && keepId` to `keepId`)

- Risk: a stale open item with proposal P re-judged `none` / `not_checked` now carries P on a non-open verdict.
  Selection (actions.ts:499-560): `none` is never a listed row (answered list only when answeredByReply);
  `not_checked` / held go through `ownerDecided` first: a proposal outside LISTED_STATES is dropped (decision
  stands), a Wrong? keeps it in Corrected; then `hiddenBySettings` still applies, so an app_invite item kept as
  held/not-checked stays hidden by the default switch (RT-30 analogue for meeting_invite PASS; same hiddenBySettings path).
- Keep path never calls propose -> no second proposal (X-5, X-5b, RT-31, F5-14, XF-4 PASS).
- Loop-3 observation C4 (orphaned `proposed` row when re-judged `none`) is now attached rather than orphaned: an
  improvement, not a regression.
- Version bump (email 3 / teams 4) only forces re-judges; the keepId path above is what governs them.

Not covered this loop: the loop-3 real-SQL re-judge probe (not committed in the repo) was not re-run; claim 6 rests
on the unchanged code path plus the committed suites.

SHIP
