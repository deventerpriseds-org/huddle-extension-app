# WHAT:       Independent verification of claim C8 row 7 ("one request makes one task") at loop 7
# WHY:        Loop 4 REFUTED the prefix dedup rule; fix 83e1eb30 adds a description-overlap condition
# SUPERSEDES: nothing (loop 4's C8 section is the predecessor finding, on claude_verify-handoff-confirm-flow-4)
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   docs/qc-evidence/verify-handoff-confirm-flow-7-c8-probe.ts + .probe.out (this branch), base 28d0ab3b

## Status: COMPLETE (wall-clock budget hit; unreached items marked)

## VERDICT C8 row 7: REFUTED

Method: `bun docs/qc-evidence/verify-handoff-confirm-flow-7-c8-probe.ts`. It imports the real
`matchOpenTitle` and `normalizeTaskTitle` from `src/features/huddle/lib/tasks/create-task-core.ts` at
28d0ab3b. Raw output is in `verify-handoff-confirm-flow-7-c8-probe.out`. Totals: 24 rows, 7 UNSAFE
over-matches, 4 under-matches.

### (1) Loop 4 rows re-run with realistic short descriptions: all 11 PASS
UM-Flint, the real case, is blocked as a duplicate. The other 9 distinct rows (gift for Sarah, Denver
for the wedding, and so on) are no longer blocked when the open task's description is a plain
restatement of its own short title. The exact-match row is still blocked.

### (2) UNSAFE over-matches: a distinct request is silently blocked (lost work)
The rule is "the new title starts with the open title, and at least 60% of the extra words, compared by
their first 4 letters, appear in the open task's description." Descriptions share generic words
(schedule, review, team, before, due, date, delivered, appointment). The rule cannot tell those words
apart from the words that make a task distinct, so the distinct word gets outvoted.

| row | open title + description | new request | blocked | why it is a distinct task |
|---|---|---|---|---|
| OV-gift-generic | "Buy birthday gift" / "Buy a birthday gift for Mom and have it delivered before Saturday." | "Buy birthday gift for Sarah and have it delivered before Saturday" | YES | Different person. This is the loop-4 canonical example, still lost when the descriptions share their logistics words. |
| OV-meeting-budget | "Schedule a meeting" / "...with the team to review the project timeline." | "Schedule a meeting with the team to review the budget" | YES | A different meeting topic (budget, not timeline). 2 of 3 extra words found. |
| OV-electric-rental | "Pay the electric bill" / "...online before the due date to avoid a late fee." | "Pay the electric bill for the rental property before the due date" | YES | A different property's bill. 3 of 5 extra words found, which is exactly 0.6. |
| OV-doctor-sarah | "Call the doctor" / "Call Dr. Patel's office to schedule an appointment about the persistent cough." | "Call the doctor to schedule an appointment for Sarah" | YES | A different patient. |
| OV-stem-pres | "Pick up prescription" / "Pick up the prescription at CVS." | "Pick up prescription for the presentation" | YES | 4-letter-stem collision: "presentation" and "prescription" both reduce to "pres", so 1 of 1 matches. |
| OV-long-generic | "Follow up" / a long multi-item description | "Follow up with the landlord to schedule the review" | YES | A 2-word generic open title with a long description absorbs anything. |
| OV-report-q4 | "Send the report" / "...quarterly sales report to the leadership team by Friday." | "Send the report to the leadership team by Monday" | YES | Ambiguous (it may be the same report with a new deadline). Counted here, but not relied on. |

Argued case (the dispatch prompt's example): open "Email John Smith", description "Send John the
signed lease and the deposit receipt", new "Email John Smith the deposit receipt". It is blocked. I
judge this the SAME task, because the open email already carries the deposit receipt, so it is not
counted as unsafe.

### (3) Under-matches on the real UM-Flint shape (the safe direction: one cleanup row)
- "Obtain official transcript and send to UM-Flint": NOT blocked. "send" is not in the description, which uses "sent" (stem "sent" does not equal "send"), so only "flint" matches: 1 of 2 = 0.5. This is near-identical wording.
- "Obtain official transcript and have it mailed straight to UM-Flint so the hold is cleared": NOT blocked (2 of 6).
- "Obtain official transcripts and send them to UM-Flint": NOT blocked, because the prefix test needs "transcript " followed by a space.
- "Request official transcript be sent directly to UM-Flint": NOT blocked, because it has a different first word.
- "Obtain official transcript for UM-Flint": blocked (good).

### Wiring re-check (cheap)
- huddle.functions.ts ~3198: `openTitlesForCreate()` is awaited first, and it fills the per-turn cache
  `existingOpenTitles` (lines 2046-2050). So `.descriptions` and `.ids` are filled before they are read
  at 3199 and 3209. The skip returns the matched `task_id`. CONFIRMED by reading the code.
- huddle.functions.ts ~3477 (the batch create) passes `existingOpenTitles?.descriptions`. CONFIRMED by reading the code.
- realtime-tools.server.ts ~743-761 (voice) passes `load.descriptions`. Its skipped rows carry no
  `task_id`, so a voice duplicate cannot name the open task it matched. Observed; not tested further.
- Summary text in the single-create skip: "an open task with this title already exists — skipped
  duplicate" (read in the code). Its consumer in board-claims (C7) was not re-run: NOT REACHED.

### NOT REACHED (budget)
- The full suite re-run (tsc + 7 suites).
- The `mutate.sh` mutation of a guard in scripts/one-request-one-task.test.ts.
- C7 `isSkippedDuplicateCreate` against the summary text.
- The extra SELECT column in getTasksForUser and its effect on other callers and the scorer.

### Required before C8 row 7 can be CONFIRMED
The description-overlap rule counts generic shared words as proof that two tasks are the same, so a
distinct object word (a person, a property, a topic) is outvoted. The rows above are concrete failing
inputs; each should become a regression test.

LOOP-7-C8-COMPLETE
