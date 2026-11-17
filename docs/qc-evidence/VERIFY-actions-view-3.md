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
