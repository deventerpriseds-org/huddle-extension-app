# VERIFY-correspondence-proposals-11

WHAT:       Independent verifier loop 11 for `claude_task-proposals` @ `90af5f3a` vs `origin/main`.
WHY:        Loop 10 (`claude_verify-correspondence-proposals-10`) refuted 1d-new (a cut comment removed main's stopping `>`),
            1e (per-token stack walks ~2000x main) and claim 4 (Lovable build_checklist offered `proposals` with flags off).
            90af5f3a claims fixes for all three plus a NEW owner-approved tag-span rewrite. This loop re-derives each.
SUPERSEDES: nothing (VERIFY-correspondence-proposals-10.md stays as the loop-10 record). SUPERSEDED-BY: nothing -- current.
EVIDENCE:   probe scripts `scripts/verify11-*` on this branch; loop 5-10 probes copied unchanged from the loop-10 branch.

Verifier started 2026-11-15 22:38 UTC. Budget 90 min active. All fixtures synthetic. No live systems touched.

## Results (appended per claim as each lands)

- Claim 0 (suites): CONFIRMED

## Claim 0: every suite at 90af5f3a -- CONFIRMED
Ran EVERY `scripts/*.test.ts` (107 files) with `bun <file>`, PG 16 on PATH. **97 exit 0.** The 10 non-zero files are the
same 10 as loop 10, each re-checked against `origin/main` @ `e546e4c2` (`git archive`):

| file | branch | origin/main |
|---|---|---|
| autowork-lane-starvation / memory-context / raw-create-dedup / timeout-no-rerun | rc 1 "outside the test runner"; `bun test` rc 0 | `bun test` rc 0 |
| fireflies-minutes, focus, memory-mode, model-policy, start-on-approval | rc 1 | rc 1, failure lines identical (diffed, timings stripped) |
| confirm-reask-db | rc 2 `REFUSING: LOCAL_PG_ADMIN_URL ...` | rc 2, same refusal |

Named suites, observed: html-visible-loop5 46/0, checklist-tool 8/0, forwarded 22/0, onedrive-feed-truth 11/0, inbound-email
72/0, needs-you 77/0, redteam-correspondence 77/0, task-proposals 199/0, correspondence-ingest 149/0, proposals-preview 15/0,
feed-staleness 98/0, meeting-triage 69/0, attention all passed (16), onedrive-feed all passed (61). SQL: task-proposals-sql
45/0, correspondence-ledger-sql 50/0, feed-staleness-sql 23/0, meeting-triage-sql 34/0, fireflies-queue-sql all passed.
`npx tsc --noEmit` exit 0, 0 lines. `npm run build` exit 0; `parse5.mjs` in `.output/server/_libs`, 0 files in `.output/public`
mention parse5. The main reference copy `scripts/verify5-main/` was re-diffed against `origin/main` @ e546e4c2: `htmlToText`
and `inbound-email.ts` identical, so every main column below is current main.

