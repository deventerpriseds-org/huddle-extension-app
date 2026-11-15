# VERIFY-correspondence-proposals-9

WHAT:       Independent verifier loop 9 for `claude_task-proposals` @ `1c0171d7` vs `origin/main` (`ab6c87a0`).
WHY:        Loop 8 (`claude_verify-correspondence-proposals-8` @ `4857ac27`) refuted claim 1d (quote-aware tag regex
            dropped visible text after an apostrophe in an unquoted attribute) and observed 1e (parse5 quadratic on
            deep block nesting). Commit 1c0171d7 claims to fix both. This loop re-derives them, re-checks loop 8's
            confirmed probes, and covers claims 2-4 that loop 8 did not reach.
SUPERSEDES: nothing (VERIFY-correspondence-proposals-8.md stays as the loop-8 record). SUPERSEDED-BY: nothing -- current.
EVIDENCE:   probe scripts `scripts/verify9-*` on this branch; loop 5-8 probes copied unchanged from the loop-8 branch.

Verifier started 2026-11-15 17:36 UTC. Budget 2 h of active time. All fixtures synthetic. No live systems touched.

## Results (appended per claim as each lands)

- Claim 0 (suites): PENDING
- Claim 1 (1d + 1e fixes, loop-8 re-check): PENDING
- Claim 2 (bell "Teams chats" removed): PENDING
- Claim 3 (forwarded.ts + preview scripts): PENDING
- Claim 4 (merge readiness, flags off): PENDING
