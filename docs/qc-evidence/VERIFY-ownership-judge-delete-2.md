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

## AC2 — the 1:1 create-time judge is time-boxed: CONFIRMED

huddle.functions.ts at 508970d:
- :2898-2905: `laneOwner = await Promise.race([resolveOwnerLLM(title, winner.id, …).catch(() => null), new Promise(r => setTimeout(() => r(null), 5_000))])`.
  - A rejection gives null, and so does a timeout. Null falls back to `winner.id` on the card (:2911) and in `pickCreatedTaskAssignee` (:2955).
  - The order `namedOwner → capabilityOwnerFor → judge → responder` is unchanged.
  - The card and the assignee still agree (assign-on-create.test passes).
- Added latency is now bounded at 5s per created task.
- Notes, not defects:
  - (a) The 5s timer is never cleared, so it holds a pending timer for up to 5s after the race resolves.
  - (b) The judge runs BEFORE the `agentBackend.journey?.enabled` check, so a journey-off harness turn still pays up to 5s per create for an assignment it never writes.
  - (c) A turn that creates N tasks through N sequential tool calls can pay up to N×5s.

## AC1 — every `assigned_agent` writer, re-listed: PARTLY CONFIRMED (the produce path is closed; one model-driven writer still bypasses the judge)

| writer | through judge? | evidence |
|---|---|---|
| `runProduce` (produce offer accepted / deep-confirm produce) | **YES (new)** | huddle.functions.ts:1640-1651. `owner = Promise.race([resolveOwnerLLM(askText, agentId,…).catch(()=>null), 5s])`, then `assignCreatedJourneyTasks({agentId: owner ?? agentId})`. `routerCfg` (:928) and `openaiKey` (:829) are declared at function scope before the closure is invoked (:1704, :1730), so there is no TDZ throw. |
| 1:1 `create_huddle_task` | YES | AC2 above |
| 1:1 hand-off follow-up | YES (it delivers a DM; it does not write `assigned_agent`) | huddle.functions.ts:~6765-6780 |
| grooming `batch_update_tasks` | YES, with the incumbent default | AC3 above |
| board drag/menu `updateBoardTask` | NO, by design (an explicit user choice) | board.functions.ts:~40-60 |
| mirror upsert | n/a (a copy of journey) | tasks.server.ts:381 |
| **agent-invoked journey `update_task` with an `assigned_agent` arg** | **NO — bypass** | journey `_shared/tool-definitions.ts:74-89` offers `update_task` with `assigned_agent` ("assign it to a specific agent"). execute-tool :976-977 writes it. Huddle offers the whole catalog minus `HIDDEN_FROM_HUDDLE = {web_search, send_email}` (proxy.functions.ts:85-94) to text agents, and to voice when `opts.journey !== false` (realtime-tools.server.ts:424). Huddle's only update_task guard is status-only (huddle.functions.ts ~2760: `ASSIGNEE_SCOPED_STATUS`, which returns null when `a.status` is empty). So any agent can reassign any task to any id by tool call, with no judge. This is pre-existing and not introduced by this PR, but it falsifies "every ownership decision goes through resolveOwnerLLM". |
| plural `create_huddle_tasks` / voice create | leave the row unassigned (grooming decides later) | unchanged from loop 1 |

Out-of-scope note: journey `updateTask(supabase, args)` (execute-tool :349) takes NO `userId`, unlike `deleteTask(supabase, userId, args)` (:356). Delete is therefore scoped MORE tightly than the pre-existing update path. Delete does not make the client-asserted-caller issue worse than `updateBoardTask` already does. If anything, update is the weaker of the two.
