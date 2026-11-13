<!--
WHAT:          Independent verification (loop 3) of branch claude_task-proposals @ 8a336404 against
               docs/ac/AC-correspondence-checklist.md, the red-team findings F1-F19/S1-S5, the flag
               contract, the live work-email path (htmlToText / newTextOnly) and the real Teams/Sent/emails shapes.
WHY:           Tier 1 (model output stored as proposals). Loops 1-2 never reached a verdict.
SUPERSEDES:    nothing (loops 1-2 left only a header: origin/claude_verify-correspondence-1 4edb6fd8)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts under scripts/verify3-*.ts on this branch
-->

# VERIFY correspondence-proposals, loop 3

Started 2026-11-13 12:16 UTC. Budget 90 min. Isolated worktree; no live system touched.

## Claim 0: suite re-run (head 8a336404)

| suite | result |
|---|---|
| task-proposals | 174 passed, 0 failed |
| redteam-correspondence | 52 passed, 0 failed |
| correspondence-ingest | 149 passed, 0 failed |
| onedrive-feed | all passed |
| inbound-email | 72 passed, 0 failed |
| cross-app-turn-gate | 92 passed, 0 failed |
| fireflies-minutes | 3 FAILED (implementer says pre-existing on main; re-checked below) |
