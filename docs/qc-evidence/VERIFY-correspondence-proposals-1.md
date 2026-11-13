<!--
WHAT:          Independent verification of branch claude_task-proposals (head db0fb18a) against
               docs/ac/AC-correspondence-checklist.md and the red-team findings F1-F19.
WHY:           Tier 1 (model output stored as proposals; the bell names who owes a reply). Verifier pass,
               no shared context with the implementer.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      probe tests in scripts/verify-correspondence-probes.test.ts on branch claude_verify-correspondence-1
-->

# VERIFY: correspondence + task proposals, round 1

Branch under test: `origin/claude_task-proposals` @ `db0fb18a`. Verifier branch: `claude_verify-correspondence-1`.
Written incrementally, one section at a time.

## 1. Suites re-run (observed, this worktree)

| suite | result |
|---|---|
| `bun scripts/task-proposals.test.ts` | 174 passed, 0 failed |
| `bun scripts/redteam-correspondence.test.ts` | 49 passed, 0 failed |
| `bun scripts/correspondence-ingest.test.ts` | 148 passed, 0 failed |
| `bun scripts/onedrive-feed.test.ts` | all passed |
| `bun scripts/inbound-email.test.ts` | 72 passed, 0 failed |
| `bun scripts/cross-app-turn-gate.test.ts` | 92 passed, 0 failed |
| `bun scripts/task-proposals-sql.test.ts` (real PG 16, throwaway initdb) | 45 passed, 0 failed |
| `bun scripts/correspondence-ledger-sql.test.ts` (real PG 16) | 50 passed, 0 failed |
| `npx tsc --noEmit -p .` | rc 0, no output |

Matches the counts claimed in IMPL-task-proposals.md.
