# VERIFY actions-accuracy, loop 4

WHAT: independent verification of `main` @ 30898bae (#268 squash) for the actions-accuracy work, D-1..D-7 + C0-C9.
WHY: loop 3 was cut by an owner interrupt; the work was merged as #268. This loop checks main after the merge.
SUPERSEDES: VERIFY-actions-accuracy-3.md (partial, interrupted). SUPERSEDED-BY: nothing -- current.
EVIDENCE: commands + outputs inline. Synthetic data only. Scratch: /tmp/claude-0/-home-user/ed70a92b-1b9b-5829-ab72-8eca54030362/scratchpad/v4/

Started 2026-11-17 05:57 UTC. Budget 25 min. The tests ran on a checkout whose src/ and scripts/ are main 30898bae
(this branch has origin/main merged in; `git diff origin/main HEAD` shows only docs/qc-evidence files).

## Baseline: main is the loop-3 head, byte for byte
```
git diff --quiet 7561f19a 30898bae; echo rc=$?   -> rc=0
git rev-parse 7561f19a^{tree} 30898bae^{tree}    -> d577eb90... d577eb90... (identical)
```
So every loop-3 probe result on 7561f19a also describes main.

## C0 suites on main 30898bae -- CONFIRMED
`bun scripts/<suite>.test.ts`:
```
actions-accuracy 55/0, actions-view 90/0, actions-view-server 28/0, report-from-ledger 103/0,
correspondence-ingest 186/0, meeting-triage 69/0, meeting-triage-sql 34/0, meeting-triage-server 7/0,
task-proposals 199/0, task-proposals-sql 45/0, needs-you 77/0, ai-quota-alert 50/0, ai-quota-alert-sql 12/0
```
All rc=0. Counts match the brief exactly.
