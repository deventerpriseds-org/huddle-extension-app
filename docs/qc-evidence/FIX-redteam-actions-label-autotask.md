# FIX — red-team findings RTL-3, RTL-4, RTL-6 (actions label auto-task)

<!--
WHAT:       Fix notes for the three red-team attacks that succeeded against the Outlook-label auto-task pass.
WHY:        REDTEAM-actions-label-autotask.md: RTL-3, RTL-4, RTL-6 failed (attack succeeded) at 35b1f154.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   scripts/actions-view.test.ts RTL- block; mutation table below.
-->

Baseline at 35b1f154: `bun scripts/actions-view.test.ts` -> **331 passed, 3 failed** (RTL-3, RTL-4, RTL-6).

## RTL-3 — cap without the gaveUp flag (FIXED, commit e9f3dc91)

- New pure `recordIsTerminal(r)` = `done || gaveUp || attempts >= AUTO_TASK_MAX_ATTEMPTS`; both the pass's skip check
  and `wouldAutoTaskCount` call it. Added `RTL-3b` (a test, additive) so the count path has its own guard.
- After: `actions-view` 333 passed, 2 failed (RTL-4, RTL-6 still open).

| mutation (scratchpad label-RT/) | test | exit | verdict |
|---|---|---|---|
| drop ` \|\| r.attempts >= AUTO_TASK_MAX_ATTEMPTS` in recordIsTerminal | RTL-3 | 0 | FIRED (control EQUIVALENT) |
| same | RTL-3b | 0 | FIRED (control EQUIVALENT) |
| pass skip check back to `done \|\| gaveUp` only | RTL-3 | 0 | FIRED (control EQUIVALENT) |
| wouldAutoTaskCount back to `done \|\| gaveUp` only | RTL-3b | 0 | FIRED (control EQUIVALENT) |

