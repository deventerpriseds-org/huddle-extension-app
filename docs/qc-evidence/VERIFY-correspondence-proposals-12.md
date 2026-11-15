# VERIFY-correspondence-proposals-12

WHAT:       Independent verifier loop 12 for `claude_task-proposals` @ `4d0019a0` (includes a merge of origin/main) vs `origin/main` @ `9783d3fc`.
WHY:        Loop 11 refuted claims 1/4 on Node speed (tag-span loop rebuilt `${PREFIX}${html}` per element). 13bce386 claims the
            hoist fix. New since loop 11: Teams daily load window, Teams owner fallback, one-time backfill script, merge of main.
SUPERSEDES: nothing (VERIFY-correspondence-proposals-11.md stays as the loop-11 record). SUPERSEDED-BY: nothing -- current.
EVIDENCE:   probe scripts `scripts/verify12-*` on this branch; loop 5-11 probes copied unchanged from the loop-11 branch.

Verifier started 2026-11-15 23:14 UTC. Budget 75 min active. All fixtures synthetic. No live systems touched.

## Results (appended per claim as each lands)

- Claim 0 (suites): CONFIRMED

## Claim 0: every suite at 4d0019a0 -- CONFIRMED
Ran EVERY `scripts/*.test.ts` (107 files) with `bun <file>` (PG 16 at /usr/lib/postgresql/16/bin for the SQL suites), plus
`node --experimental-strip-types scripts/html-visible-node-timing.test.mts`, `npx tsc --noEmit`, `npm run build`.
**97 of 107 exit 0; node timing 3/0; tsc exit 0 with 0 lines; build exit 0.** The 10 non-zero files are the same 10 as
loops 10/11, each re-run against `origin/main` @ `9783d3fc` (git archive, same node_modules):

| file | branch | origin/main |
|---|---|---|
| autowork-lane-starvation / memory-context / raw-create-dedup / timeout-no-rerun | rc 1 under `bun <file>`; `bun test` rc 0 | `bun test` rc 0 |
| fireflies-minutes, focus, memory-mode, model-policy, start-on-approval | rc 1 | rc 1, FAIL lines identical (diffed, timings stripped) |
| confirm-reask-db | rc 2 (refuses without LOCAL_PG_ADMIN_URL) | rc 2, identical |

Named suites, observed (all match the implementer's numbers): html-visible-loop5 46/0, checklist-tool 8/0, forwarded 22/0,
onedrive-feed-truth 11/0, inbound-email 72/0, needs-you 77/0, redteam-correspondence 77/0, task-proposals 199/0,
correspondence-ingest 161/0, proposals-preview 15/0, feed-staleness 98/0, meeting-triage 69/0, attention all passed,
onedrive-feed all passed. SQL: task-proposals-sql 45/0, correspondence-ledger-sql 50/0, feed-staleness-sql 23/0,
meeting-triage-sql 34/0, fireflies-queue-sql all passed.
