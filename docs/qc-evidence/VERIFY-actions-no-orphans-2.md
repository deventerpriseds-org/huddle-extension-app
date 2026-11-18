<!--
WHAT:          independent verification, loop 2, of the Tier 1 change "no Actions item is ever left with no home".
WHY:           loop 1 (VERIFY-actions-no-orphans-1.md) said FIX FIRST; this loop re-derives both fixes and re-checks the rest.
SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch claude_actions-no-orphans at 222806f2, checked out detached. Synthetic data only (public repo).
               No billed model calls and no workflow dispatches. Local PostgreSQL 16 (the server suite's own).
-->

# VERIFY actions-no-orphans, loop 2

Head under test: `222806f2`. Started 05:11 UTC. Written as each claim landed.

## Suites (claim 8)

| Suite | Result |
|---|---|
| `bun scripts/actions-view.test.ts` | 264 passed, 0 failed |
| `bun scripts/actions-accuracy.test.ts` | 96 passed, 0 failed |
| `bun scripts/report-saves-verdicts.test.ts` | 39 passed, 0 failed |
| `bun scripts/actions-view-server.test.ts` x3 | 50/0, 50/0, 50/0 (real PG) |
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | (see below) |

## New: identical text drops one item (traced)

Mechanism: `collapseDuplicateTeamsItems` (`pipeline.ts` ~776, called at the end of `buildCandidates`). Two OPEN Teams
items from different chats with the SAME sender id and the SAME folded quote of >= 40 characters are "one ask"; only the
newest by `at` is kept. On a tie the FIRST in input order wins (`>` not `>=`). The real-SQL fixtures used the same
synthetic sender and the same 80-character quote on two chats, so one was collapsed. That is the whole flake.

Pure probe (scratchpad `probe/collapse.ts`), A = older 1:1 item with its own open proposal, B = newer twin:

| Case | A | B |
|---|---|---|
| different `at` | gone | rows |
| same `at`, order A,B / B,A | rows / gone | gone / rows |
| B's own proposal dismissed | **gone** | gone |
| B in an uninvolved group chat + Hide uninvolved on | **gone, counted nowhere** | hidden.uninvolved |
| B on board | gone | gone |
| B corrected Wrong? | gone | corrected |

- Nondeterministic? Deterministic for a given input; a tie on `at` falls to input order.
- Real orphan path? Yes, narrowly: the winner is picked BEFORE selection, so when the newer twin is then hidden by a
  What-shows switch (uninvolved chat) the older, involved twin appears in no group and in no hidden count.
- Pre-existing? Yes. The same probe run against main `04e17dad` gives identical results (only case "B legacy held"
  differs: unchecked on main, held here, which is this PR's intended change). The function is unchanged by the PR.

`npm run build`: exit 0.

## Re-derived fixes

| # | Claim | Result | Evidence |
|---|---|---|---|
| a | NORT-7 GUARD (real SQL) now exercises the server `proposalState` wiring | PASS | Own anchor: remove `    proposalState: proposalStateOf,` in `actions.server.ts`. `mutate.sh` exit 0, **FIRED (control EQUIVALENT)** on `NORT-7 GUARD (real SQL)`. Loop 1 got INERT on the same mutation, so the rebuilt fixture now reaches the state check. |
| b | Held click refuses a kept proposal corrected Wrong? on this item version | PASS | Code: the click uses `correctionHides(correctionFor(stored, u.itemKey), u.itemKey)`; the page uses `correctionHides(c.correction, c.itemKey)` with `c.correction = correctionFor(p.correction, u.itemKey)` (`pipeline.ts` ~636) and `c.itemKey = u.itemKey`. Same rule, same key. One owner-scoped query selects `state, owner_correction`; both deps read it through one cached promise per id. C1 (remove the check line, offline `NO-CORR-1 GUARD`) exit 0 FIRED/EQUIVALENT. C2 (remove `proposalCorrection: proposalCorrectionOf,`, real SQL `NO-CORR-S1 GUARD`) exit 0 FIRED/EQUIVALENT. NO-CORR-2 (read throws -> fixed error) PASS. |
| b2 | Fixer's untested note: no kept id, `propose` returns an existing id corrected on this version | Would act (code read); not reachable found | After `deps.propose` returns `p.id` there is no state or correction check: stored and acted. Reachability: a Wrong? entry for this item key is written only on a row that has that proposal id at this key, and `keepId` (`pipeline.ts` ~298) keeps the id on every re-judge of the same key, so a no-id verdict at the same key with a corrected proposal needs the id to vanish, which no path I found does. Inference, medium confidence. Backlog row, not a blocker. |

## Prior claims, reduced depth

| # | Claim | Result | Evidence |
|---|---|---|---|
| 1 | Invariant (M01) | PASS | `NO-AC1 GUARD` PASS. M01 (own anchor: `verdictAfterPropose` -> `{...v, proposalId: p.id ?? null}`) exit 0 FIRED/EQUIVALENT. |
| 2 | Legacy rows held (M09, NO-AC12) | PASS | `NO-AC12 GUARD` PASS offline and real SQL. M09 (`pushHeld(... no_task_record)` -> `pushUnchecked`) exit 0 FIRED/EQUIVALENT on the real-SQL suite. |
| 3 | G-1 | PASS | `NO-AC9 GUARD`, `NO-AC10 GUARD` PASS (real SQL). |
| 4 | G4-a / NORT-10b / G4-b | PASS | `NO-G4a-S1`, `NO-G4a-S2`, `NORT-10b GUARD` PASS. F2 (always `proposalMissing`) exit 0 FIRED/EQUIVALENT. |
| 5 | D5 exactness | PASS | `NO-AC25 GUARD`, `NORT-9`, `RT-25` PASS. M22 (widen the IN list with `bad_shape`) exit 0 FIRED/EQUIVALENT. |
| 6 | No double listing, counts | PASS | Suites green; collapse probe above: every candidate lands in at most one group. |
| 7 | Changed old tests | PASS | `F-2`, `U-1`, `U-2`, `U-3`, `U-7`, `F5-3/F5-4` PASS; no further edits to them since loop 1 (fix diff touches only new tests + NORT-7 fixture). |
| 9 | Mutations | PASS 7/7 | F6, C1, C2, M01, M09, M22, F2 all exit 0 FIRED (control EQUIVALENT). |

## Collapse orphan: smallest fix (not implemented)

In `collapseDuplicateTeamsItems`, a candidate that the page will NOT list must not compete for the winner slot. Smallest
version: `buildCandidates` already has `a.settings`; pass an `eligible(c)` predicate (false when a What-shows switch
hides it, e.g. `c.uninvolved && settings.hideUninvolvedChats`) and skip ineligible candidates in the winner loop and in
the final filter. Then the hidden twin keeps its hidden count and the involved twin is listed. Whether a decided twin
(case "B dismissed") should also stop hiding a twin with its OWN still-open proposal is an owner call.

## Verdict

FIX FIRST: the Teams same-ask collapse can hide an involved item with no group and no count when its newer twin is
hidden by Hide uninvolved chats. It is PRE-EXISTING on main `04e17dad` (identical probe result) and not introduced by
this PR; every claim of this PR passes. If the owner prefers, it can ship as is with this as a backlog row.
