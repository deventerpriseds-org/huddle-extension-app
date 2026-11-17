# VERIFY actions-accuracy, loop 3

WHAT: independent verification of `claude_actions-accuracy` @ 7561f19a (loop-2 fixes D-1..D-7 + UI "More").
WHY: loop 2 returned FIX FIRST (VERIFY-actions-accuracy-2.md, e4588d3c).
SUPERSEDES: nothing (loop 2 stays as the record of the defects). SUPERSEDED-BY: nothing -- current.
EVIDENCE: commands + outputs inline below. Synthetic data only. Scratch: /tmp/claude-0/-home-user/ed70a92b-1b9b-5829-ab72-8eca54030362/scratchpad/l3/

Started 2026-11-17 05:45 UTC. Budget 40 min.

## C0 suites -- CONFIRMED
`bun scripts/<suite>.test.ts` for each, then `npx tsc --noEmit -p .`, `npx vite build` on 7561f19a:
```
actions-accuracy 55/0, actions-view 90/0, actions-view-server 28/0, report-from-ledger 103/0,
correspondence-ingest 186/0, meeting-triage 69/0, meeting-triage-sql 34/0, meeting-triage-server 7/0,
task-proposals 199/0, task-proposals-sql 45/0, needs-you 77/0, ai-quota-alert 50/0, ai-quota-alert-sql 12/0
tsc rc=0, build rc=0
```
Matches the builder's counts exactly.

