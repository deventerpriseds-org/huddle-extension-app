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

- Claim 0 (suites): CONFIRMED
- Claim 1 (1d + 1e fixes, loop-8 re-check): PENDING
- Claim 2 (bell "Teams chats" removed): PENDING
- Claim 3 (forwarded.ts + preview scripts): PENDING
- Claim 4 (merge readiness, flags off): PENDING

## Claim 0: every suite at 1c0171d7 -- CONFIRMED

Ran EVERY `scripts/*.test.ts` (106 files) with `bun <file>` (PG 16 binaries on PATH for the self-hosting SQL suites).
96 exit 0. The 10 non-zero files, each re-checked:

| file | on branch | why | on origin/main (ab6c87a0, `git archive`) |
|---|---|---|---|
| autowork-lane-starvation / memory-context / raw-create-dedup / timeout-no-rerun | "Cannot use beforeEach()/describe outside of the test runner" | they are `bun test` files | `bun test`: 26/0, 11/0, 30/0, 12/0 on branch |
| focus | 24/1 (F22 voice call to Iris) | pre-existing | identical 24/1 |
| memory-mode | 2/4 | pre-existing | identical 2/4 |
| model-policy | diff 3 sol-ceiling FAIL | pre-existing | identical |
| start-on-approval | 49/50 (coursework) | pre-existing | identical 49/50 |
| fireflies-minutes | 3 FAILED (G3/G5/G8) | pre-existing (as loop 8 found) | identical 3 FAILED |
| confirm-reask-db | refuses without `LOCAL_PG_ADMIN_URL`; with a local PG 16 URL: 1 failure AC-27 | pre-existing | identical AC-27 failure |

The correspondence/html suites the implementer listed, observed here: html-visible-loop5 29/0, onedrive-feed-truth 11/0,
inbound-email 72/0, needs-you 77/0, redteam-correspondence 77/0, task-proposals 199/0, correspondence-ingest 149/0,
proposals-preview 15/0, feed-staleness 98/0, forwarded 17/0, meeting-triage 69/0, attention + attention-focus all
passed. SQL: task-proposals-sql 45/0, correspondence-ledger-sql 50/0, feed-staleness-sql 23/0, meeting-triage-sql 34/0,
meeting-triage-server 7/0, fireflies-queue-sql all passed. Others of note: cross-app-turn-gate 92/0, onedrive-feed all
passed, inbox-read 68/0, email-self-send 73/0.

`npx tsc --noEmit`: exit 0, 0 lines. `npm run build`: exit 0.
No suite fails on the branch that passes on main.
