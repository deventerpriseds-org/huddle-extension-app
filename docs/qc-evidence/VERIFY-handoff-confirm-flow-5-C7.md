# WHAT:       Loop-5 single-claim verification of C7 (F6 board-claim honesty) against fix c94d1085
# WHY:        Loop 4 REFUTED C7 (docs/qc-evidence/VERIFY-handoff-confirm-flow-4.md on claude_verify-handoff-confirm-flow-4)
# SUPERSEDES: nothing (loop 4 report stays as the C7 refutation record)
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   base origin/claude/modest-brown-2hdt5n @ 00f2b0c4; probe docs/qc-evidence/verify-handoff-confirm-flow-5-c7-probe.ts

## VERDICT: C7 REFUTED

Probe: `bun docs/qc-evidence/verify-handoff-confirm-flow-5-c7-probe.ts`. 37 rows, 14 misses.

### (1) Loop-4 rows: 19/19 pass against the fix
All 7 keep rows and 12 rewrite rows from loop 4 now give the expected result.

### (2) NEW false rewrites (a TRUE statement replaced with "Nothing was changed on the board for that.")
| row | input | toolUses | why it is true |
|---|---|---|---|
| N-U1 | "I've moved the task to Review with the write-up attached." | create_artifact ok, detail /artifacts/abc | create_artifact with a taskId runs `ensureReviewFlip` (huddle.functions.ts:4183) and tells the agent "this is now in the user's review queue" (:4199). That is a real DOING->IN_REVIEW write, but create_artifact is not in TASK_WRITE_TOOLS. |
| N-U3 | "I've completed the analysis for that task." | create_artifact | The work was done; "analysis" is not in OFF_BOARD_RE, so it is judged as a status claim. The loop-4 row only passes because "research"/"brief" happen to be in the list. Synonyms like analysis, comparison, write-up, summary, plan and itinerary all fail. |
| N-U4 | "I've put the comparison on the task card for you." | create_artifact | The board card shows artifact chips (BoardView). |
| N-U5 | "I've set the priorities across your backlog." | groom_backlog "groomed the backlog" | groom ranks the backlog and chains `runScheduledAutoWork({promoteOnly})` (groom.ts:504). groom_backlog is not a task-write tool. |
| N-U6 | "I moved three tasks into Up next." | groom_backlog | promoteOnly fills Up next. |
| N-U7 | "I've put Finn on that task." | delegate_to_specialist | This describes a delegation, not a board write, but "put" + "task" makes it a status claim and only TASK_WRITE_TOOLS can back one. |

Observation: N-U1, N-U5 and N-U6 are writes made through Huddle-native tools, not journey tools. Interpretation: TASK_WRITE_TOOLS covers journey's catalog only, so the radius "board-claims.ts only" misses the Huddle tools that move tasks (create_artifact->ensureReviewFlip, groom_backlog->promoteOnly).

### (3) NEW under-matches (a FALSE claim with no tool use, passed unchanged)
| row | input | cause |
|---|---|---|
| N-M1 | "I've marked it done, let me know if you need anything else." | NOT_A_CLAIM_RE ("let me"/"if you") exempts the whole sentence. This is a very common LLM sign-off. |
| N-M2 | "I moved it to Done so it's off your plate if you were worried." | same ("if you") |
| N-M3 | "I've updated the task to Done." | "updated" is not a claim verb |
| N-M4 | "Your task is now marked done." | CLAIM_SUBJECT has no "is (now)" form |
| N-M5 | "I marked the task done and set a reminder for Friday." | OFF_BOARD_RE ("reminder") wins over the status claim |
| N-M6 | "I've checked that task off." | "checked off" is not a claim verb |
| N-M7 | "That one's handled — marked it complete." | the em-dash is not a split point and "marked" is not at the start |
| N-M8 | "I've scheduled the task for 3pm tomorrow." | "scheduled" is not a claim verb |

### (4) Mutation: NOT PROVEN
`mutate.sh board-claims.ts` removing `"move_task_to_day"` from TASK_WRITE_TOOLS was run against the test `true statement kept: "I moved the task to Thursday."` (`bun test scripts/board-claims-f6.test.ts`, with and without `2>&1`). Under the mutation the suite FAILED (rc=1). The restore matched HEAD and the clean tree passed again. But mutate.sh reported UNDETERMINED (exit 4) because it could not find the test name in bun's failure output. The guard is likely real, but the run does not prove it.

### NOT REACHED
I did not re-run `npx tsc --noEmit` or `npm run -s test:handoff-lane-a` this pass. I did not check the real `create_artifact` toolUse detail format, and the probe assumes `/artifacts/...`. N-U1 and N-U5..7 fail whatever the detail is, because their status claims only check isPerformedTaskChange.

LOOP-5-C7-COMPLETE
