# FIX verify-2 finding: Teams same-ask collapse orphan (actions-no-orphans)

WHAT: fix notes for the loop-2 verifier finding "collapse picks its winner before What-shows filters".
WHY: VERIFY-actions-no-orphans-2.md, probe case 5: a newer twin hidden by Hide uninvolved chats left the older,
involved twin in no group and no hidden count.
SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
EVIDENCE: this file; base head ff328921 on claude_actions-no-orphans.

## Log

- Base: `ff328921`. Defect re-read in code: `pipeline.ts` `collapseDuplicateTeamsItems` picks a winner per key with
  `>` on `at` (ties fall to input order) across ALL open Teams items, before `selectActionItems` applies What-shows.
