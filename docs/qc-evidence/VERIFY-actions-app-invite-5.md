# VERIFY actions-app-invite, loop 5

WHAT:       Independent re-check of the app_invite / hideable-category / re-judge claims on current origin/main.
WHY:        Loop 5 of the verify loop. Loop 4 gave SHIP on 5cc1eb76; this loop re-confirms that at reduced depth.
SUPERSEDES: docs/qc-evidence/VERIFY-actions-app-invite-4.md (branch claude_verify-app-invite-4). It is still correct; this file re-confirms it.
SUPERSEDED-BY: nothing (current)
EVIDENCE:   the suite output quoted below, run 2026-11-18 on a detached checkout of origin/main.

## Base

- `git fetch origin main && git checkout --detach origin/main` puts HEAD at **5cc1eb76** ("Accuracy log: dinner invite mis-listed; ...").
- **origin/main has not moved since loop 4.** It is still 5cc1eb76, so `git diff --stat 5cc1eb76 origin/main -- src scripts` is empty
  (exit 0, no output) and the whole-tree diff is empty too.
- Challenge to the radius: none is needed. With zero commits between the two SHAs the radius is empty, not just "`.claude/` and `docs/` only".
  The brief said origin/main had moved in `.claude/` and `docs/`. That is not true as of this fetch, but nothing follows from it.

## Suites (synthetic data; local throwaway PG for the server suite)

| command | expected | observed |
|---|---|---|
| `bun scripts/actions-view.test.ts` | 221/0 | `221 passed, 0 failed`, rc=0 |
| `bun scripts/actions-accuracy.test.ts` | 96/0 | `96 passed, 0 failed`, rc=0 |
| `bun scripts/report-saves-verdicts.test.ts` | 39/0 | `39 passed, 0 failed`, rc=0 |
| `bun scripts/actions-view-server.test.ts` | 36/0 | `36 passed, 0 failed`, rc=0 |
| `npx tsc --noEmit` | exit 0 | exit 0, 0 output lines |

## Claims

| # | claim | result | evidence (suite line, verbatim prefix) |
|---|---|---|---|
| 1 | app_invite category + strict schema enum (AI-1) | PASS | `PASS AI-1 GUARD: app_invite is a hideable category, labelled for What shows`; `PASS AI-9 GUARD: app_invite is in the strict schema enum (else every app_invite answer is bad_shape)` |
| 2 | hideable, hidden by default (H-3, AI-2) | PASS | `PASS H-3 settings defaults: four noise categories (app_invite added 2026-11-17) ...`; `PASS AI-2 GUARD: hidden by DEFAULT -- ...counted hidden` |
| 3 | knownHideCategories merge (H-4) | PASS | `PASS H-4 settings: junk falls back field by field; cap clamped`; `PASS AI-6`, `PASS AI-7`, `PASS AI-8`; server `PASS APPINV-S1 GUARD (real SQL): settings saved before app_invite existed -> hidden by default, saved cap kept` |
| 4 | share-note carve-out (AI-15) | PASS | `PASS AI-15 GUARD: a share notice carrying the person's OWN request is never app_invite (email category, step 2, Teams)` |
| 5 | re-judge keeps its proposal (RK-1, RK-2) | PASS | report-saves: `PASS RK-1 GUARD: re-judge of the SAME item version ... keeps its proposal`; `PASS RK-2 a NEW message (different item key) is proposed afresh` |
| 6 | decided threads not re-judged / not re-listed | PASS (reduced depth) | `PASS XF-1 GUARD: a NOT-CHECKED item whose kept proposal the owner already decided ... is not listed`; `PASS XF-2`; `PASS F-1 GUARD: decided proposals / on-board items are not listed`; `PASS RT-28`. The server suite is 36/0, but **no server-suite line is named for this claim**; loop 4 also rested it on a code read. The code it read (`actions.ts` `ownerDecided`, `report-from-ledger.ts` `RESOLVED_PROPOSAL_STATES`) is byte-identical because the diff is empty. |
| 7 | #278 lost nothing (X-5, X-5b, XF-4) | PASS | `PASS X-5 GUARD: prior {not_checked, proposalId P}, re-judge -> quote_not_found: P stays attached, 0 proposals made`; `PASS X-5b ...P stays attached`; `PASS XF-4 GUARD: ... re-uses it at Add / Dismiss: 0 new proposals`; `PASS RT-31` |

FAIL lines across the four suites: 0.

## Not in scope / not run

- No browser UAT, no deploy check, no workflow dispatch, no model calls (rules for this loop). This loop has no UI claim beyond what the unit and server suites cover, so a UAT verdict is not given here.

## Verdict

SHIP
