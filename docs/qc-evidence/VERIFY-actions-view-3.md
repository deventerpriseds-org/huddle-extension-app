---
WHAT: Independent verification, loop 3, of the Actions view (branch claude_actions-view head 5a21fc7b).
WHY: Loop 2 (VERIFY-actions-view-2.md) refuted D1, D2, D4, D5, D6 and left O1, O2, the E-U table, the 96-AC sweep and
     the UI claims NOT REACHED. The builder's loop-2 fix log is BUILD-actions-view.md "## Loop-2 fixes".
SUPERSEDES: nothing (VERIFY-actions-view-2.md is the previous loop, kept as the record of the defects).
SUPERSEDED-BY: nothing -- current.
EVIDENCE: this file; probes in docs/qc-evidence/verify-actions-view-3-probes/.
---

# VERIFY: actions-view, loop 3

Code under test: `git archive 5a21fc7b` unpacked to a scratch dir (node_modules linked from the main checkout).
Started 2026-11-17 02:22 UTC. Budget 60 minutes. Synthetic data only.

## Verdicts (appended as each check completes)

### 0. Named suites on 5a21fc7b

| suite | command | result |
|---|---|---|
| actions-view | `bun scripts/actions-view.test.ts` | exit 0, `82 passed, 0 failed` |
| actions-view-server (real PG 16) | `bun scripts/actions-view-server.test.ts` | exit 0, `26 passed, 0 failed` |
| correspondence-ledger-sql | `bun scripts/correspondence-ledger-sql.test.ts` | exit 0, `79 passed, 0 failed` |
| report-from-ledger | `bun scripts/report-from-ledger.test.ts` | exit 0, `62 passed, 0 failed` |

Matches the builder's counts (82 / 26 / 79 / 62). **CONFIRMED.**

### 1. Every suite in the BUILD log, tsc, build -- on 5a21fc7b and on a test-merge with origin/main 9c1859e1

Runner: `verify-actions-view-3-probes` is not needed; a loop over the 20 suites named in the BUILD log's "Final
checks", then `npx tsc --noEmit`, then `npm run build`. Test-merge: `git merge-tree --write-tree 5a21fc7b 9c1859e1`
-> tree a2d47c8a, no conflict; its only difference from 5a21fc7b is `scripts/proposals-preview.ts` (+16/-1).

| suite | 5a21fc7b | test-merge a2d47c8a |
|---|---|---|
| actions-view | 82 passed, 0 failed | 82 / 0 |
| actions-view-server (real PG 16) | 26 / 0 | 26 / 0 |
| correspondence-ledger-sql | 79 / 0 | 79 / 0 |
| report-from-ledger | 62 / 0 | 62 / 0 |
| task-proposals / -sql | 199 / 45 | 199 / 45 |
| meeting-triage / -sql / -server | 69 / 34 / 7 | 69 / 34 / 7 |
| attention / attention-focus | 16 PASS, "all passed" / 27 PASS, "all passed" | same |
| needs-you | 77 / 0 | 77 / 0 |
| correspondence-ingest | 186 / 0 | 186 / 0 |
| onedrive-feed | 61 PASS, "all passed" | same |
| feed-staleness / -sql | 98 / 23 | 98 / 23 |
| redteam-correspondence | 77 / 0 | 77 / 0 |
| onedrive-feed-truth | 11 / 0 | 11 / 0 |
| fireflies-queue-sql | 14 PASS, "all passed" | same |
| fireflies-minutes | 72 PASS, FAIL G3, G5, G8 (exit 1) | same three |
| `npx tsc --noEmit` | exit 0 | exit 0 |
| `npm run build` | exit 0, nitro "You can deploy this build" | exit 0 |

Baseline: `git archive 9c1859e1` (current main) -> `bun scripts/fireflies-minutes.test.ts` -> `FAIL G3`, `FAIL G5`,
`FAIL G8`, `3 FAILED`. The three failures pre-exist on main. **CONFIRMED** (all suites, typecheck and build, on the
head and on the test-merge).

### 2. D1 (Tier 1): a quote stitched across two pieces -- FULL RE-DERIVATION

Code read (`src/features/huddle/lib/correspondence/action-classify.ts:157-195`): `emailQuoteHaystack` returns
`[latestOther.text, forwardOfThatMessage]` (or one piece, or `[]`); `teamsQuoteHaystack` returns one piece per OTHER
message; `quoteIsVerbatim` folds EACH piece separately and uses `pieces.some(p => canon(p).includes(q))`. Every
caller found by `grep -rn "quoteIsVerbatim(\|admitActionVerdict(\|QuoteHaystack("`: `pipeline.ts:169-171` (passes
the list), `scripts/action-scan-steps.ts:132,141,170,179` (passes the list), `needs-you.ts:395` (passes one string,
`latestOther.text` only -- a single piece, no join). No caller joins.

Loop-2 probe re-run (`bun docs/qc-evidence/verify-actions-view-2-probes/quote.ts`): Q15 (Teams two-message stitch)
`verbatim=false admit=not_checked`; Q21 (email body + forwarded part) `false`. Q1-Q14, Q16-Q20 unchanged from loop 2.

New probe `verify-actions-view-3-probes/d1.ts` (10 rows, all `OK`, "all as expected"): OTHER|OWNER|OTHER stitch ->
not_checked; a quote found only in the OWNER's message -> not_checked; three-message stitch -> not_checked; an OTHER
message with null text does not throw and the next message still admits; a quote in the forward alone -> open; a
forward belonging to a DIFFERENT message is not a piece -> not_checked; no latestOther -> `[]` -> not_checked.

Mutation (own, see section 10): D1-M.

Verdict D1: **CONFIRMED FIXED.**
