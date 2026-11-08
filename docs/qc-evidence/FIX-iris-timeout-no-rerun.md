# FIX — a timed-out agent attempt keeps what it dispatched, and its re-run does not dispatch it again

# WHAT:       Huddle turn-engine fix: task creates an agent attempt sends to journey are recorded AT DISPATCH
#             in a turn-scoped ledger that rides the resume state; a timed-out attempt's result carries
#             them; the re-queued attempt is told exactly which titles it already sent and cannot re-send
#             a batch create; the batch create also forwards the user's own message as `context`.
# WHY:        2026-11-07 dm-iris-chase turn u-1794062312621: 23 requested tasks became 43 journey rows.
#             `runBounded` resolved each timed-out attempt with `toolUses: []`, the in-flight journey call
#             still wrote, and `mergeAgentResult` re-queued Iris blind 6 times (paraphrased re-creates).
#             The turn ended with replies=[] toolUses=[], so Iris later said "only one added".
# SUPERSEDES: nothing.
# SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   journey-voice docs/qc-evidence/FINDINGS-iris-bulk-task-categories.md (branch
#             claude_iris-task-category-findings), sections 1d, 2b, 2f-1, 3c. Base: huddle origin/main 09731f8f.

Status: IN PROGRESS

## Plan (extends existing mechanisms; nothing parallel)

| piece | existing mechanism extended | change |
|---|---|---|
| dispatch ledger | `createdTaskTitles` + `buildResumeState` / `TurnResumeState` | new turn-scoped `dispatchedCreates` array, round-tripped in resume state like `createdTaskTitles` |
| record at dispatch | `createBatchTasksFromTool`, `createSuggestedTaskFromTool`, `guardRawJourneyCreate` | push an entry BEFORE `invokeJourneyTool`; stamp the result if the call returns |
| timed-out result | `runBounded` timeout branch | synthetic result's `toolUses` = this attempt's dispatched creates (ok:true), so they merge into `toolUses` → resume state → final result → `ensureNotSilentOnRealWork` |
| re-queue | `mergeAgentResult` skip branch (unchanged re-queue) + scene directives (`handoffDirective` slot) | a `priorDispatchDirective` naming the titles already sent |
| no re-dispatch | same three create sites | a batch create by an EARLIER attempt of the same agent blocks a new batch create (create_huddle_tasks or raw parse_and_create_tasks) in that turn |
| context | `createBatchTasksFromTool` journey args | `context: data.text` trimmed to 1500 chars |

Pure helpers live in `src/features/huddle/lib/tasks/create-task-core.ts` (the existing shared create core).

## Steps

1. **Helpers** (`create-task-core.ts`): `DispatchedCreate`, `recordDispatchedCreate`, `priorAttemptDispatches`,
   `priorBatchDispatch`, `dispatchedToolUses`, `priorDispatchDirective`, `alreadyDispatchedResult`,
   `journeyCreateContext`. Baseline `npx tsc --noEmit -p .` on origin/main 09731f8f: 0 errors; after: 0.
   (Deps installed with `npm ci --ignore-scripts`: `bun install` 403s on bun.lock's private registry.)
