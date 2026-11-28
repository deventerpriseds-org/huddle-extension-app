# FIX — red-team findings RTL-3, RTL-4, RTL-6 (actions label auto-task)

<!--
WHAT:       Fix notes for the three red-team attacks that succeeded against the Outlook-label auto-task pass.
WHY:        REDTEAM-actions-label-autotask.md: RTL-3, RTL-4, RTL-6 failed (attack succeeded) at 35b1f154.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   scripts/actions-view.test.ts RTL- block; mutation table below.
-->

Baseline at 35b1f154: `bun scripts/actions-view.test.ts` -> **331 passed, 3 failed** (RTL-3, RTL-4, RTL-6).

