# VERIFY ownership-judge-delete, loop 2

- WHAT: independent re-verification of the loop-1 fixes (508970d) plus focus_on toggle (cf2305e, AC8), huddle-extension-app
- WHY: Tier-1 (ownership decides who works a task; delete is destructive). Loop 1 refuted AC3 and parts of AC1/AC2/AC5.
- SUPERSEDES: docs/qc-evidence/VERIFY-ownership-judge-delete-1.md (on origin/claude_verify-ownership-judge-delete-1) for the claims re-checked here
- SUPERSEDED-BY: nothing -- current
- EVIDENCE: this file; every command run in an isolated worktree at detached 508970d. journey side read from the local journey-voice checkout (branch claude/intelligent-hawking-qj88qu, fetched 20:42 UTC 2026-10-28), not from deployed main.

## Suite run (observed at 508970d)

| command | result |
|---|---|
| `npx tsc --noEmit -p .` | exit 0 |
| `bun scripts/ownership-judge.test.ts` | ALL PASS (13 checks incl. 4 new), exit 0 |
| `bun scripts/board-delete.test.ts` | ALL PASS, exit 0 |
| `bun scripts/assign-on-create.test.ts` | ALL PASS, exit 0 |
| `bun scripts/ask-shape.test.ts` | ALL PASS, exit 0 |
| `bun scripts/verdict-memory.test.ts` | ALL PASS, exit 0 |
| `bun scripts/router-winners.test.ts` | 20 passed, 0 failed |
| `bun scripts/priority-lane.test.ts` | 10 passed, 0 failed |

The 4 new ownership-judge checks are regexes over source. They prove the text is present, not the behaviour. For AC5 I added a behavioural probe (below).

`git diff --quiet e56147d 508970d -- src/features/huddle/components src/features/huddle/lib/routing.ts src/features/huddle/lib/openai-responses.server.ts .claude/skills` → no diff. So AC4, the AC5 UI and AC7 are byte-identical to what loop 1 confirmed.

## AC3 — grooming never writes a batch pick over an assigned task: CONFIRMED

groom.ts at 508970d:
- :312-315: before the judge's `try`, every assignment whose id is in `slice` is set to `incumbentOwner(t.assigned_agent, a.assigned_agent)`, which is the current owner when that owner is a roster id (:148-150).
- :316 / :340: if the judge import fails, the outer catch leaves those incumbent values.
- :323: the budget skip `return`s and leaves the incumbent.
- :326 `const incumbent = a.assigned_agent` (already the incumbent); :337 `a.assigned_agent = judged ?? incumbent`. A per-call failure or the 5s timeout gives `.catch(() => null)` → incumbent.
- :394-400 `updates` reads `a.assigned_agent` only after `await mapLimit(...)`, and mapLimit awaits every worker (:153-159). A late judge resolution after `withTimeout` rejected cannot write, because the assignment line runs only once, after the race.

So the only ways an ASSIGNED task's owner changes are (a) the judge returns another roster id, or (b) the current `assigned_agent` is not a roster id (incumbentOwner treats it as unassigned, which is the intended design).

Residual edge (low): an assignment id NOT in `slice` (a hallucinated id) misses `byId` and keeps the batch pick. The model only sees slice ids, so this needs a hallucination.

Worst-case in-chat time, recomputed from the code's own deadlines (not measured):
- judge phase: budget 8s, checked at task START (:323), per call 5s → at most ~13s. With the in-chat cap of 25 and 16 in flight it is 2 waves, about 10s.
- total: classify 15s (:281) + judge ~13s + write 18s (:64) + wait 2.5s (:65) + autowork 15s (:66) = **~63.5s** (loop 1: ~68.5s; before the PR: 50.5s). Still over the ~45s ceiling in the worst case. Typical time is UNPROVEN, not measured.
