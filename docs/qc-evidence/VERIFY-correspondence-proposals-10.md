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

- Claim 0 (suites): CONFIRMED
- Claim 1 (email text = main except the three approved changes): REFUTED (1d-new: a cut comment removes the `>` main's tag rule stopped at -> visible ask dropped; 1e: loop-9 shapes fixed, but per-token stack walks under the limit stay linear x ~2000: 810 KB -> 3.3 s)
- Claim 2 (bell, code): PENDING
- Claim 3 (preview-only code + public-log hygiene): PENDING
- Claim 4 (merge readiness, flags off): PENDING

## Claim 0: every suite at 907dade7 -- CONFIRMED

Ran EVERY `scripts/*.test.ts` (107 files) with `bun <file>`, PG 16 binaries on PATH (`/tmp/.../runall.sh`). **97 exit 0.**
The 10 non-zero files are the same 10 loop 9 explained; each re-checked against `origin/main` (`git archive ab6c87a0`):

| file | branch | origin/main |
|---|---|---|
| autowork-lane-starvation / memory-context / raw-create-dedup / timeout-no-rerun | "outside the test runner" under `bun <file>`; under `bun test`: 26/0, 11/0, 30/0, 12/0 | n/a (`bun test` files) |
| fireflies-minutes, focus, memory-mode, model-policy, start-on-approval | rc 1 | rc 1, failure lines **identical** (diffed, timings stripped) |
| confirm-reask-db | rc 2, `REFUSING: LOCAL_PG_ADMIN_URL ...` | rc 2, same refusal (not re-run against a local PG this loop: reduced depth; loop 9 saw the same AC-27 failure on both) |

Named suites, observed: html-visible-loop5 32/0, checklist-tool 6/0, forwarded 22/0, onedrive-feed-truth 11/0,
inbound-email 72/0, needs-you 77/0, redteam-correspondence 77/0, task-proposals 199/0, correspondence-ingest 149/0,
proposals-preview 15/0, feed-staleness 98/0, meeting-triage 69/0, attention all passed (16). SQL: task-proposals-sql 45/0,
correspondence-ledger-sql 50/0, feed-staleness-sql 23/0, meeting-triage-sql 34/0, fireflies-queue-sql all passed.

`npx tsc --noEmit`: exit 0, 0 output lines. `npm run build`: exit 0; parse5 in `.output/server/_libs/parse5.mjs`, absent
from `.output/public`. No suite fails on the branch that passes on main.
