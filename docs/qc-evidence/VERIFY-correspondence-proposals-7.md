<!--
WHAT:          Independent verification (loop 7) of claude_task-proposals @ 3b3f0c42: loop-6 refuted items re-derived,
               part A (AI conversation judge) and part B (meeting triage) derived in full, the two merges checked,
               and the flags-OFF live-change table rebuilt.
WHY:           Tier 1 (model output decides what is flagged and is stored as proposals; live work-email screen touched).
SUPERSEDES:    docs/qc-evidence/VERIFY-correspondence-proposals-6.md (origin/claude_verify-correspondence-proposals-6 @ 9afa8eb6)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts scripts/verify7-*.ts (this loop), scripts/verify6-*.ts copied from loop 6
-->

# VERIFY correspondence-proposals, loop 7

Started 2026-11-14 03:32 UTC, budget 3 h (ends 06:32 UTC). Isolated worktree; branch
`claude_verify-correspondence-proposals-7` started from the target **3b3f0c42** (no src change; additions are this
file and probe scripts). origin/main at start: 7ba8f7a4. No live system touched; synthetic `.example` data only.

## Claim 0: full suite re-run at 3b3f0c42 -- CONFIRMED

| suite | implementer | observed |
|---|---|---|
| needs-you | 77/0 | 77/0 |
| meeting-triage | 69/0 | 69/0 |
| meeting-triage-server | 7/0 | 7/0 |
| meeting-triage-sql (local PG 16) | 34/0 | 34/0 |
| proposals-preview | 15/0 | 15/0 |
| task-proposals | 199/0 | 199/0 |
| redteam-correspondence | 77/0 | 77/0 (exit 0) |
| inbound-email | 72/0 | 72/0 |
| correspondence-ingest | 149/0 | 149/0 |
| feed-staleness | 98/0 | 98/0 |
| html-visible-loop5 | 16/0 | 16/0 |
| onedrive-feed-truth | 11/0 | 11/0 |
| cross-app-turn-gate | 92/0 | 92/0 |
| onedrive-feed / attention / attention-focus / confirm-ask-context / artifact-preview | -- | all passed / all passed / all passed / 21/21 / 28/0 |
| feed-staleness-sql / task-proposals-sql / correspondence-ledger-sql / fireflies-queue-sql | -- | 23/0 / 45/0 / 50/0 / all passed |
| fireflies-minutes | G3/G5/G8 fail on base | G3, G5, G8 FAIL -- **the same three fail on origin/main 7ba8f7a4** (run from a `git archive` of main) |
| `npx tsc --noEmit` | -- | exit 0, no output |
| `npm run build` | -- | exit 0 |

Bundle spot check: `parse5` is only in `.output/server/_libs/parse5.mjs` (+ the server onedrive-feed chunk); `grep parse5
.output/public` = nothing. The judge prompt (`conversation_judgement`, "You judge ONE email") is only in the server
chunk. **Observation (pre-existing pattern, non-blocking):** `proposals-store.server.ts` and `proposals.server.ts`
are emitted as client chunks too (`.output/public/assets/proposals-store.server-*.js` holds the bootstrap DDL; no
secret -- `{}.AZURE_PG_URL` is empty). 41 `*.server-*` chunks are in `public/assets`, so this is how the app's build
already treats every server module, not something this branch introduced.
