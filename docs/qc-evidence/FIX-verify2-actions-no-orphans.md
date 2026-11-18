# FIX verify-2 finding: Teams same-ask collapse orphan (actions-no-orphans)

WHAT: fix notes for the loop-2 verifier finding "collapse picks its winner before What-shows filters".
WHY: VERIFY-actions-no-orphans-2.md, probe case 5: a newer twin hidden by Hide uninvolved chats left the older,
involved twin in no group and no hidden count.
SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
EVIDENCE: this file; base head ff328921 on claude_actions-no-orphans.

## Log

- Base: `ff328921`. Defect re-read in code: `pipeline.ts` `collapseDuplicateTeamsItems` picks a winner per key with
  `>` on `at` (ties fall to input order) across ALL open Teams items, before `selectActionItems` applies What-shows.

## The fix (commit 8f6b2795)

- `actions.ts`: new pure `whatShowsHideReason(settings)` holds THE What-shows rule in its one order: uninvolved chat
  with Hide uninvolved on, then source off, then hidden category, then hidden list sender. `selectActionItems`'s
  `hiddenBySettings` now counts using it. There is no second copy.
- `pipeline.ts`: `collapseDuplicateTeamsItems(cands, senderIdOf, eligible = () => true)`. Within one key the winner
  is chosen in this order: an eligible item beats an ineligible one, then the newest `at`, then the smaller
  `itemKey`. Input order no longer decides. `buildCandidates` passes `(c) => whatShows(c) === null`.
- A choice the brief did not spell out: two ineligible twins still collapse with EACH OTHER. So "both twins hidden"
  is still counted as ONE hidden ask (R6-12), as it was before. If ineligible items never collapsed at all, that count
  would go from 1 to 2. An ineligible item can only beat another ineligible item, so it never drops an item the page
  lists. When an eligible twin wins, the hidden twin is dropped and is not counted as hidden either: the ask is
  already listed once.
- Behaviour changes, all intended: (1) probe case 5, where A is now listed (was: orphan) and B is gone (was:
  hidden.uninvolved 1); (2) the tie case with input order B,A, where A now wins (was: B). Every other probe row is
  unchanged (R6-14).

## Reachability (observation from reading the code)

`threadUnits` (`pipeline.ts` ~59) does not create units for uninvolved chats when Hide uninvolved is on. A source that
is switched off also creates no units, and Teams `listSender` is always null. So through `buildCandidates`, the
uninvolved form of this orphan cannot be reached on the live page. The reachable form is a **hidden category**:
the newer twin is judged e.g. `meeting_invite`, which is hidden by default. R6-15 shows this end to end. R6-9 keeps
the uninvolved form covered at the function level, as the verifier's probe did.

## Probe re-run (verifier's probe/collapse.ts, pointed at this worktree)

| Case | without `eligible` (old call) | with `eligible` (buildCandidates wiring) |
|---|---|---|
| 1 diff at | A gone, B rows | same |
| 2 same at, A,B | A rows | same |
| 3 same at, B,A | A rows (was B rows on ff328921: tie fix) | same |
| 4 B dismissed | both gone | same (unchanged) |
| 5 B uninvolved + hide | A gone, B gone | **A rows**, B gone |
| 6 B on board | both gone | same (unchanged) |
| 7 A legacy held | B rows | same |
| 8 B legacy held | B held | same |
| 9 B Wrong? | B corrected | same (unchanged) |

## Mutations (mutate.sh, anchors in scratchpad orph-V2/)

| # | Mutation | Test | Exit | Verdict |
|---|---|---|---|---|
| m1 | remove the eligible-first rank (`if (ec !== ew) return ec;`) | R6-9 GUARD | 0 | FIRED (control EQUIVALENT) |
| m2 | tie-break `return c.itemKey < w.itemKey;` -> `return false;` (input order) | R6-11 GUARD | 0 | FIRED (control EQUIVALENT) |
| m3 | drop the `eligible` argument in `buildCandidates` | R6-15 GUARD | 0 | FIRED (control EQUIVALENT) |

## Suites (after the fix)

- `bun scripts/actions-view.test.ts`: 264 passed, 0 failed
- `bun scripts/actions-accuracy.test.ts`: 103 passed, 0 failed (96 before + 7 new: R6-9..R6-15)
- `bun scripts/report-saves-verdicts.test.ts`: 39 passed, 0 failed
- `bun scripts/actions-view-server.test.ts`: 50 passed, 0 failed
- `npx tsc --noEmit`: exit 0, no output
- `npm run build`: exit 0

## Not done / open

- Owner call, unchanged on purpose: if the newer twin's OWN proposal was dismissed (probe case 4), or it is on the
  board or was marked Wrong?, the older twin is still hidden ("same ask"). The brief said to keep this.
