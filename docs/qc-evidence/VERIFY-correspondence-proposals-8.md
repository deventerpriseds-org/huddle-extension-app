# VERIFY-correspondence-proposals-8

WHAT:       Independent verifier loop 8 for `claude_task-proposals` @ `07f5f6d3` vs `origin/main` (`d56e90f8`).
WHY:        Loop 7 (branch `claude_verify-correspondence-proposals-7` @ `46ff73f8`) returned FIX FIRST on claim 1
            (malformed HTML flipped the live ask decision) and the "Teams chats" checkbox. This loop re-derives both
            fixes and reviews `scripts/reply-scan-preview.ts`.
SUPERSEDES: nothing (VERIFY-correspondence-proposals-7.md stays as the loop-7 record). SUPERSEDED-BY: nothing -- current.
EVIDENCE:   probe scripts under `scripts/verify8-*.ts` on this branch; loop-7 probes restored from the loop-7 branch.

Verifier started 2026-11-14 04:42 UTC. Budget 2 h (ends 06:42 UTC). All fixtures synthetic. No live systems touched.

Main copies used for comparison: `scripts/verify5-main/{onedrive-feed,inbound-email}.ts` -- checked byte-identical to
`origin/main` except the one import path line.

## Results (appended per claim as each lands)

## Claim 0: full suite re-run at 07f5f6d3 -- CONFIRMED (reduced depth)

| suite | implementer | observed |
|---|---|---|
| html-visible-loop5 | 20/0 | 20 passed, 0 failed (prints "exact 83/88") |
| onedrive-feed-truth | 11/0 | 11/0 |
| attention / attention-focus | all passed | all passed / all passed |
| truth | 11/0 | 11/0 (= onedrive-feed-truth) |
| task-proposals | 199/0 | 199/0 |
| redteam-correspondence | 77/0 | 77/0 |
| inbound-email | 72/0 | 72/0 |
| needs-you | 77/0 | 77/0 |
| correspondence-ingest | 149/0 | 149/0 |
| proposals-preview | 15/0 | 15/0 |
| feed-staleness | 98/0 | 98/0 |
| meeting-triage / -server / -sql (local PG 16) | 69/0, 7/0, 34/0 | 69/0, 7/0, 34/0 |
| feed-staleness-sql / task-proposals-sql / correspondence-ledger-sql / fireflies-queue-sql | -- | 23/0 / 45/0 / 50/0 / all passed |
| cross-app-turn-gate / onedrive-feed / confirm-ask-context / artifact-preview | -- | 92/0 / all passed / 21/21 / 28/0 |
| fireflies-minutes | -- | G3, G5, G8 FAIL -- identical three FAIL on a `git archive` of origin/main d56e90f8 (pre-existing, not this branch) |
| `npx tsc --noEmit` | -- | exit 0, no output |
| `npm run build` | -- | exit 0 |

Loop-6 and loop-7 shape probes re-run against 07f5f6d3: `verify7-screen-probes` **rows=39 differ=0 ask-decision-flips=0**;
`verify6-screen-probes` **rows=8 differ=0** (was 11/39 flips at 3b3f0c42).
