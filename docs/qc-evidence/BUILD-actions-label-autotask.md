<!--
WHAT:       Build log for the Outlook-label -> automatic board task change (contract: AC-actions-label-autotask.md).
WHY:        Owner request 2026-11-28; Tier 1. Appended incrementally so a killed build leaves a trail.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; branch claude_actions-label-autotask. THIS REPO IS PUBLIC: synthetic data only.
-->

# BUILD: actions label auto-task

## 0. Setup (2026-11-28)
- Branch `claude_actions-label-autotask` at 5ec0cae3, merged `origin/main` dbf7ab05 (lock fix + probe P-8) -> 0f5540ef. Clean merge.
- Baseline, before any change: actions-view 264/0, actions-accuracy 103/0, report-saves-verdicts 39/0, onedrive-feed all passed,
  correspondence-ingest 186/0, correspondence-ledger-sql 79/0, forwarded-store 83/0, needs-you 77/0, actions-view-server (real PG) 50/0.
- AC-1.11 measured (probe run 46110175163): array of strings; 3 x ["Action Needed"], 2 x []; all 5 status "pending". Recorded in the AC file.
