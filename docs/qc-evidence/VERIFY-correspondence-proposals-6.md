<!--
WHAT:          Independent verification (loop 6) of claude_task-proposals @ d849f0da: full re-derivation of the
               loop-5 REFUTED items (6.4 / F1-F3 class via parse5 html-visible.ts, claim 16 U1/U4, X3-X6) plus a
               reduced-depth re-check of everything loop 5 confirmed, and the flags-OFF live-change table.
WHY:           Tier 1 (model output stored as proposals; live work-email screen + main-mailbox newTextOnly touched).
SUPERSEDES:    docs/qc-evidence/VERIFY-correspondence-proposals-5.md (origin/claude_verify-correspondence-proposals-5 @ b4e76df7)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts scripts/verify3-5-*.ts (earlier loops) and scripts/verify6-*.ts (this loop)
-->

# VERIFY correspondence-proposals, loop 6

Started 2026-11-14 02:16 UTC, budget 2.5 h (ends 04:46 UTC). Isolated worktree, branch
`claude_verify-correspondence-proposals-6` started from the target **d849f0da** (`git diff d849f0da HEAD -- src` is empty;
the only additions are this file, loop 5's report and the loop 3-5 probe scripts copied from b4e76df7).
origin/main at start: 90e84d1c (the target is 6 commits behind main, 83 ahead). No live system touched; synthetic
`.example` data only.

**Restart note (02:17 UTC):** the stub above came from a stopped earlier start; this run continues the same branch
(fetched 1469ff19) and keeps the budget end at 04:46 UTC. `node_modules` is a symlink to the main checkout's tree
(parse5 7.3.0 present there; ignored by git).

## Claim 0: full suite re-run at d849f0da

| suite | implementer | observed |
|---|---|---|
| task-proposals | 204/0 | 204 passed, 0 failed |
| redteam-correspondence | 76/0 | 76/0 |
| inbound-email | 72/0 | 72/0 |
| correspondence-ingest | 149/0 | 149/0 |
| cross-app-turn-gate | 92/0 | 92/0 |
| feed-staleness | 96/0 | 96/0 |
| proposals-preview | 6/0 | 6/0 |
| onedrive-feed-truth | 11/0 | 11/0 |
| html-visible-loop5 | 9/0 | 9/0 |
| onedrive-feed / attention / attention-focus / confirm-ask-context | -- | 61 PASS lines "all passed" / all passed / all passed / 21/21 |
| feed-staleness-sql (local PG 16) | 23/0 | 23/0 |
| task-proposals-sql | 45/0 | 45/0 |
| correspondence-ledger-sql | 50/0 | 50/0 |
| fireflies-queue-sql | -- | all passed |
| fireflies-minutes | -- | 3 FAIL (G3, G5, G8) -- **identical on origin/main 90e84d1c** (run from a `git archive` of main); pre-existing |
| `tsc --noEmit` | -- | exit 0, no output |

Every implementer count reproduces exactly.
