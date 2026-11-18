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
