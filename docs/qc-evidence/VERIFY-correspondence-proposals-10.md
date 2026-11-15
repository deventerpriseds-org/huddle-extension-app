# VERIFY-correspondence-proposals-10

WHAT:       Independent verifier loop 10 for `claude_task-proposals` @ `907dade7` vs `origin/main` (`ab6c87a0`).
WHY:        Loop 9 (`claude_verify-correspondence-proposals-9` @ `f669c0b5`) refuted 1d (line-474 quote-aware tag regex
            dropped visible asks), 1e (depth estimate bypassable -> 7-32 s parses) and claim 4 row 6 (build_checklist
            `proposals` parameter model-visible with flags off). Commit 907dade7 claims to fix all three. This loop
            re-derives them with new shapes, re-checks loop 5-9 probes at reduced depth, and re-sweeps the whole diff.
SUPERSEDES: nothing (VERIFY-correspondence-proposals-9.md stays as the loop-9 record). SUPERSEDED-BY: nothing -- current.
EVIDENCE:   probe scripts `scripts/verify10-*` on this branch; loop 5-9 probes copied unchanged from the loop-9 branch.

Verifier started 2026-11-15 18:21 UTC. Budget 90 min of active time. All fixtures synthetic. No live systems touched.

## Results (appended per claim as each lands)

- Claim 0 (suites): PENDING
- Claim 1 (email text = main except the three approved changes): PENDING
- Claim 2 (bell, code): PENDING
- Claim 3 (preview-only code + public-log hygiene): PENDING
- Claim 4 (merge readiness, flags off): PENDING
