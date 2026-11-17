# VERIFY: report-saves-verdicts, loop 2

WHAT:          Independent re-verification of branch `claude_report-saves-verdicts` @ a3b55799 against origin/main @ 23c04496.
WHY:           Loop 1 (VERIFY-report-saves-verdicts-1.md, branch claude_verify-report-saves-verdicts-a5d3) returned FIX FIRST
               on AC4 + AC8 + three out-of-list findings; this pass re-derives those and re-confirms the rest.
SUPERSEDES:    VERIFY-report-saves-verdicts-1.md (for head a3b55799). SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file, written per claim as each lands; adversarial files alongside (`*.txt`, synthetic data only).

PUBLIC REPO: counts only. No names, addresses, ids or message content.

## Suites (re-run by this pass, worktree @ a3b55799)

| command | result |
|---|---|
| `bun scripts/report-saves-verdicts.test.ts` | 29 passed, 0 failed, exit 0 |
| `bun scripts/actions-accuracy.test.ts` | 60 passed, 0 failed, exit 0 |
| `bun scripts/actions-view.test.ts` | 96 passed, 0 failed, exit 0 |
| `bun scripts/actions-view-server.test.ts` (throwaway local PostgreSQL 16) | 29 passed, 0 failed, exit 0 |
| loop-1 adversarial file, RETARGETED to this head (see note) | 22 passed, 0 failed, exit 0 |
| `npx tsc --noEmit` | (pending) |

Note on the loop-1 adversarial file: it hard-codes the loop-1 worktree path (`agent-a5d3...`), so run unchanged it
tests the OLD code (543df6af) -- and it hung there on V5-4 (the NaN case), which is the loop-1 bug, not this head.
Retargeted to this worktree, plus `sortingOn: true` on its 10 `runReportClassify` calls (a new required input; without
it every call takes the sorting-off path). Result 22/0, and `INFO V5-4 maxCalls=NaN -> done calls=0`.

## Results per claim

(written as each lands)
