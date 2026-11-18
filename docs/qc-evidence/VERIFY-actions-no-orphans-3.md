# VERIFY loop 3: actions-no-orphans (PR #282, head fab218ee)

WHAT: independent verification of the verify-2 collapse-orphan fix (8f6b2795) plus a reduced-depth re-check of the
loop-2 claims.
WHY: loop 2 found the Teams same-ask collapse picked its winner before the What-shows filters, so a hidden newer twin
could drop a listed older one (an orphan).
SUPERSEDES: nothing (VERIFY-actions-no-orphans-2.md stays as the loop-2 record). SUPERSEDED-BY: nothing -- current.
EVIDENCE: this file; head fab218ee checked out detached; scratch probes under the verifier session scratchpad (v3/).

## Verdict: SHIP

## Fixed defect: full re-derivation

Code read (diff ff328921..8f6b2795): `whatShowsHideReason(s)` in `actions.ts` holds the four What-shows checks in the
order uninvolved, sources, category, sender. `hiddenBySettings` now maps that reason onto the same four counters.
`collapseDuplicateTeamsItems` gains `eligible` (default always true). `beats` ranks eligible first, then newer `at`,
then smaller `itemKey`. `buildCandidates` passes `whatShows(c) === null`. The only server caller
(`actions.server.ts` 418-419) passes the SAME settings object `s` to `buildCandidates` and `selectActionItems`, and
no client code calls either function. So the collapse and the page judge eligibility with identical settings.

### Probe: same cases on base ff328921 and head fab218ee

Loop-2 probe rows 1-9 call the collapse WITHOUT `eligible` (old call shape). Rows E* use the buildCandidates wiring.

| Case | base ff328921 | head fab218ee | Changed? |
|---|---|---|---|
| 1 diff at | B rows | B rows | no |
| 2 same at, A,B | A rows | A rows | no |
| 3 same at, B,A | B rows | A rows | yes: tie fix, intended |
| 4 B dismissed | both gone | both gone | no (owner call) |
| 5 B uninvolved+hide (old call) | both gone | both gone | no (no `eligible` passed) |
| 6 B on board | both gone | both gone | no |
| 7 A legacy held | B rows | B rows | no |
| 8 B legacy held | B held | B held | no |
| 9 B Wrong? | B corrected | B corrected | no |
| E5 uninvolved+hide, wired | both gone, hidden.uninvolved 1 | A rows, hidden 0 | yes: the fix |
| E10 B newer, hidden category | both gone, hidden.meeting_invite 1 | A rows, hidden 0 | yes: the fix |
| E11 both hidden category | B hidden, count 1 | B hidden, count 1 | no |
| E12 A hidden cat, B newer shown | B rows | B rows | no |
| E13 chain: chat X (A older, B newer short quote) + Z newest hidden, same long quote as A | X/B rows, Z hidden 1 | X/B rows, Z dropped, hidden 0 | yes, see note |
| E14 same chain, Z shown | X/B rows, Z rows | same | no |
| E15 same chat, older shown + newer hidden cat | newer hidden 1, older gone | older rows, hidden 0 | yes: the fix (same-chat key) |
| E16 Teams source off | B hidden.sources 1 | same | no |

Note on E13 (observation, not a defect): Z loses its quote key to the eligible A, and A loses its chat key to B. Z
is therefore dropped and not counted. Its ask is still listed once, through B, by transitivity (Z ~ A by quote, A ~ B
by chat). The base behaviour counted Z as hidden while B was also listed. That double-represented the ask, which the
fix's stated rule removes. Behaviour change not listed in the FIX notes, but it follows their rule.

No orphan by argument (inference from the code, high confidence): `beats` never lets an ineligible item beat an eligible
one, and it is a total order (eligible, at, itemKey) shared by every key. A dropped eligible item lost to an eligible
item that is strictly higher in that order. That item either survives or lost to a still higher eligible one. The
chain is finite, so it ends at a surviving eligible item in the same connected group. Owner-call states (dismissed,
on board, Wrong?, held) are outside `eligible`, as the brief kept them.

Fixer's reachability claim, CONFIRMED by reading `threadUnits` (`pipeline.ts` 59-78): uninvolved chats become units only
when `!s.hideUninvolvedChats` (line 75). Teams units exist only when `s.sources.teams`. So through `buildCandidates`
the uninvolved and source forms cannot reach the collapse. The reachable form is a hidden category (E10, R6-15).

### Mutations (mutate.sh, own anchor files)

| # | Mutation | Test | Exit | Result |
|---|---|---|---|---|
| m1 | delete `if (ec !== ew) return ec;` | R6-9 GUARD | 0 | FIRED (control EQUIVALENT) |
| m2 | `return c.itemKey < w.itemKey;` -> `return false;` | R6-11 GUARD | 0 | FIRED (control EQUIVALENT) |
| m3 | drop the `eligible` argument in buildCandidates | R6-15 GUARD | 0 | FIRED (control EQUIVALENT) |

### hiddenBySettings unchanged (shared helper)

- Test diff ff328921..fab218ee touches only `scripts/actions-accuracy.test.ts`, and only by additions (R6-9..R6-15 and
  one import). No existing assertion changed. `actions-view.test.ts` is untouched and passes 264/0.
- Differential: base vs head `selectActionItems` over 180 synthetic candidates (3 sources x uninvolved x 5 categories x
  3 list senders x proposal/no proposal) and 96 settings combinations. The FULL JSON output, including `hidden` by
  reason and the rows, is identical in all 96 (differing=0). Sensitivity check: swapping the category/sender order
  in a scratch copy gives differing=28. So the differential would catch an order change.
- Gap, pre-existing and not a regression: in a scratch copy, swapping uninvolved/sources (m4) or category/sender (m5)
  leaves all four suites green. The reason ORDER has no test guard, at base or at head. The differential above is what
  proves the order is unchanged. Backlog row, not a blocker.

## Loop-2 claims, reduced depth

| Claim | Result | Evidence |
|---|---|---|
| 1-9 (M01, NO-AC12, G-1, G4, D5, counts, old tests, mutations) | PASS | Named guards all PASS in this run: NO-AC1, NO-AC12 (offline + real page read), NO-AC9/10 (offline + real SQL), NO-G4a-1/2/3/S1/S2, NORT-10b, NO-AC25, NORT-9, RT-25, F-2, U-1, U-2, U-3, U-7, F5-3/F5-4, R6-1..R6-15 |
| (a) NORT-7 / F6 | PASS (suite line) | NORT-7 GUARD (real SQL), NORT-7, NORT-7b, NORT-7c PASS. `actions.server.ts` not touched since loop 2 |
| (b) Wrong? refusal C1/C2 | PASS | NO-CORR-1, NO-CORR-2, NO-CORR-S1 PASS. C2 re-run: remove `    proposalCorrection: proposalCorrectionOf,` -> mutate.sh exit 0, FIRED (control EQUIVALENT) on `NO-CORR-S1 GUARD`; restored matches HEAD |
| b2 | Unchanged | Code path not in this diff (`actions.server.ts` untouched). Still the loop-2 inference: would act, no reachable path found |

## Suites at fab218ee

- `bun scripts/actions-view.test.ts`: 264 passed, 0 failed
- `bun scripts/actions-accuracy.test.ts`: 103 passed, 0 failed
- `bun scripts/report-saves-verdicts.test.ts`: 39 passed, 0 failed
- `bun scripts/actions-view-server.test.ts`: 50 passed, 0 failed
- `npx tsc --noEmit`: exit 0
- `npm run build`: exit 0

## Radius challenge

- Callers: `collapseDuplicateTeamsItems` and `selectActionItems` are each called once in `src`, server side, with the
  same settings. There is no client recompute where settings could differ from collapse time. Inside the radius, OK.
- Not checked: the live page (no UAT run; this is pure server logic with no UI change in this diff).
