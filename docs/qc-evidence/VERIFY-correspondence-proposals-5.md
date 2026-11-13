<!--
WHAT:          Independent verification (loop 5) of claude_task-proposals @ 03cabacc: re-derivation of every loop-4
               REFUTED / PARTIAL / MINOR item (D1 W1-W4/W7, D2 X1/X2, D3, D5, D6, STALE 4c/4d, 8.3), the 14
               implementer claims, the Chromium truth file, and the flags-OFF live-change table.
WHY:           Tier 1 (model output stored as proposals; live bell + live email screens touched).
SUPERSEDES:    docs/qc-evidence/VERIFY-correspondence-proposals-4.md (origin/claude_verify-correspondence-4)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts scripts/verify3-*.ts, scripts/verify4-*.ts (loops 3-4) and scripts/verify5-*.ts
-->

# VERIFY correspondence-proposals, loop 5

Started 2026-11-13 23:10 UTC, budget 3 h (ends 02:10 UTC). Isolated worktree at detached 03cabacc; compared against
origin/main 502e34e2 (live; 1 commit ahead of 03cabacc, ledger-only). No live system touched; synthetic `.example`
data only.

**Restart note (this run, 23:16 UTC):** the stub above came from a killed earlier start and is treated as unverified.
This run tests the verify branch checkout, whose `src/` is byte-identical to 03cabacc (`git diff 03cabacc HEAD -- src`
is empty; the only differences are this file and `scripts/verify3-*` / `scripts/verify4-*` probe scripts).
origin/main has since moved to 9a22b0cc (3 ledger-only commits ahead of 03cabacc: 502e34e2, 64170e84, 9a22b0cc).
Budget re-based: ends 02:16 UTC.

## Claim 0: full suite re-run at 03cabacc

| suite | implementer | observed (this run) |
|---|---|---|
| task-proposals | 203/0 | 203 passed, 0 failed |
| redteam-correspondence | 75/0 | 75 passed, 0 failed |
| correspondence-ingest | 149/0 | 149 passed, 0 failed |
| inbound-email | 72/0 | 72 passed, 0 failed |
| cross-app-turn-gate | 92/0 | 92 passed, 0 failed |
| feed-staleness | 73/0 | 73 passed, 0 failed |
| onedrive-feed-truth | 11/0 | 11 passed, 0 failed |
| proposals-preview | 5/0 | 5 passed, 0 failed |
| onedrive-feed, attention, attention-focus | -- | all passed |
| confirm-ask-context (main-side file) | -- | 21/21 passed |
| feed-staleness-sql (local PG 16) | 23/0 | 23 passed, 0 failed |
| task-proposals-sql | 45/0 | 45 passed, 0 failed |
| correspondence-ledger-sql | 50/0 | 50 passed, 0 failed |
| fireflies-queue-sql | -- | all passed |

Every implementer count reproduces exactly.

## Claim 0b: the two merges kept main's files intact

- Merge 0cb6d8a0 (parents 2cf5fa8d / main 8972f632, base e710fe27): 13 files touched only by main; all 10 non-ledger ones
  (`autowork.server.ts`, `PolishView.tsx`, `attention/focus.ts`, 2 tests, 2 skill check scripts, 2 workflows, 1 doc)
  are byte-identical to main (`git diff --stat 8972f632 0cb6d8a0 -- <files>` empty). One file touched by both sides,
  `HuddleView.tsx`: `git diff origin/main 03cabacc -- HuddleView.tsx` contains ONLY the branch's proposal-checklist
  code (2 imports, `propIds` reconcile, proposal row render); main's bell-jump `focusStep`/`FOCUS_WAIT_MS` code is
  present unchanged.
- Merge 03cabacc (parents 21928c16 / main aa29eef5, base 8972f632): main side touched only `.claude/actions.md`,
  `.claude/memory.md`, `graph-permission-check.yml`; the workflow is byte-identical to main.
- vs today's origin/main 9a22b0cc: every main-side code/workflow/skill file above is byte-identical. **CONFIRMED.**
