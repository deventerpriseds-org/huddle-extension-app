# VERIFY-report-from-ledger-1

WHAT:       Independent verification (loop 1) of PR #257, merged as ece03e60 (report from the Azure ledger,
            uninvolved-chat rule, resolution rule, Teams mentions stored, Fireflies date-range back-fill).
WHY:        Tier-1 gate path (decides what the owner's report hides). Builder claims need a cold read.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; base origin/main 046ec493 (contains ece03e60).

Public repo: no content, names, ids or addresses below. Synthetic fixtures only.

## Suites (run on 046ec493, worktree)

| suite | result |
|---|---|
| bun scripts/report-from-ledger.test.ts | 39 passed, 0 failed, rc=0 |
| bun scripts/fireflies-list.test.ts | 7 passed, 0 failed, rc=0 |
| bun scripts/correspondence-ingest.test.ts | 186 passed, 0 failed, rc=0 |
| bun scripts/correspondence-ledger-sql.test.ts (real local PG 16/17 via initdb) | 76 passed, 0 failed, rc=0 |
| npx tsc --noEmit | rc=0 |

## Claims

(filled per claim below)
