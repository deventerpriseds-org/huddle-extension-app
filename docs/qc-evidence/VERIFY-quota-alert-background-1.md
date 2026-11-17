# VERIFY-quota-alert-background-1

<!--
WHAT:       Independent verification of branch claude_quota-alert-background (head 457356ac), loop 1.
WHY:        The change wraps every scheduled route and every agent turn in a job context; regressions there
            matter most. Builder evidence: docs/qc-evidence/BUILD-quota-alert-background.md.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   commands and output quoted below, run 2026-11-17 in an isolated worktree.
-->

Verifier: independent subagent, no shared context with the builder. Started 04:35 UTC, budget 40 min.
Branch under test: `origin/claude_quota-alert-background` @ `457356ac`; merge base with main `80a7cf0e`;
`origin/main` @ `27146c4d` (#266).

## Claims (written as each one is checked)

### C3 Dedupe / clear / dismiss / non-quota (builder suites) -- CONFIRMED
- `bun scripts/ai-quota-alert.test.ts` -> `49 passed, 0 failed`, exit 0.
- `bun scripts/ai-quota-alert-sql.test.ts` (real local PostgreSQL 16) -> `12 passed, 0 failed`, exit 0, including
  `D1 concurrent raise (4 instances) -> exactly one alerted`, `D6 dismissed row is not reopened`,
  `D7 concurrent successes -> exactly one cleared`, `D8 next outage reopens the SAME row`.
- `bun scripts/router-winners.test.ts` (branch) -> `39 passed, 0 failed`.
