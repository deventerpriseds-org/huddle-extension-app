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
(Confirmed: execute-tool `updateTask` filters only `.eq('id', args.task_id)` at :998-999, with no user_id.)

## AC5 — delete reachable only from the board's confirm dialog: CONFIRMED (Huddle side)

- Gate: proxy.functions.ts:114 `UI_ONLY_JOURNEY_TOOLS = new Set(["delete_task"])`. At :120 `invokeJourneyTool` returns `{ok:false, error:"delete_task is a user-only action"}` unless `opts.allowUiOnly`.
- The only caller passing `allowUiOnly` in src: board.functions.ts:105 (`deleteBoardTask`, after the `Sign-in required` check at :95).
- Voice executor realtime-tools.server.ts:824 calls `invokeJourneyTool({toolName: name, …})` with no opts, so it is gated. `invokeJourneyToolDebug` (proxy.functions.ts:229-233) has no opts, so it is gated.
- Other routes to journey's /tool: `journeyFetch` is module-private (proxy.functions.ts:35, not exported). Its only `/tool` caller is `invokeJourneyTool` (:127). A grep of src for `supabase.co`, `SUPABASE_SERVICE`, `.from("tasks")` and `/functions/v1/execute-tool` finds nothing. So there is NO Huddle path to journey /tool that skips the chokepoint.
- **Behavioural probe** (a scratch bun script importing the real `invokeJourneyTool`, with the journey env unset so any call that passes the gate throws "not configured"; deleted after the run):
  ```
  "delete_task"  {}                    -> refused: false delete_task is a user-only action
  "delete_task"  {"allowUiOnly":false} -> refused: false delete_task is a user-only action
  "delete_task"  {"allowUiOnly":true}  -> THREW (reached journeyFetch)
  "get_tasks"    {}                    -> THREW (reached journeyFetch)   (over-match negative: not blocked)
  "DELETE_TASK"  {}                    -> THREW (reached journeyFetch)
  " delete_task" {}                    -> THREW (reached journeyFetch)
  ```
  The case and whitespace variants pass Huddle's gate. They are harmless: huddle-proxy forwards `toolName` unchanged (index.ts:154, :206), and execute-tool matches `switch (toolName)` / `case 'delete_task'` exactly (:331, :355), with `default` returning `Unknown tool` (:471-474). No normalisation exists on that path. This rests on the journey-voice checkout at branch claude/intelligent-hawking-qj88qu. If deployed journey ever starts normalising tool names, the gate should match the normalised form.
- UI (BoardView.tsx, unchanged since e56147d): `onDelete={applyDelete}` at :560 and :634; `onDelete(task.id)` only inside the confirm action at :768; the hover button (:749) and the mobile menu item (:831) only `setConfirmDelete(true)`; `applyDelete` (:330) restores `prev` on failure (:340, :346). Loop 1's whole-snapshot-restore caveat still applies.
- journey scoping: `deleteTask(supabase, userId, args)` (execute-tool :356, :947-952, `.delete()` scoped to user). The mirror DELETE path is unchanged and not exercised live.

## AC6 — produce offer suppressed after a hand-off: CONFIRMED (unchanged code, shifted lines)

`ensureProduceOfferDelivered` huddle.functions.ts:6943-6952. It returns immediately when there is no offer; otherwise it races `followupResolution.catch(()=>{})` against 3000ms, then `if (followupDelivered.size > 0) return`. `followupResolution` is the IIFE at :6765 with `.catch(() => {})`. The capability path adds to `followupDelivered` synchronously (:6752-6753). Loop 1's edges remain. One edge now matters less: a >3s judge still lets the offer go out, but `runProduce` now runs the same judge, so accepting that offer assigns the task to the lane owner, not the offering agent (AC1).

## AC4 — judge framing and strict schema: CONFIRMED (routing.ts unchanged since e56147d)

routing.ts :543 `framing?: "dm" | "assigned"`, :549 `const assigned = opts.framing === "assigned"`, :563/:566 the two DEFAULT STRONGLY texts, :582-584 `additionalProperties:false`, `owner` enum = roster ids, `required:["owner"]`.

## AC7 — harness env: CONFIRMED by reading (unchanged since e56147d)

durable-harness.mjs :33 `journey: { enabled: false }`, :72 `SCOPE = HUDDLE_SCOPE || "group"`, :73 `TARGET = HUDDLE_TARGET`. Not run (live scripts forbidden).

## AC8 — focus_on refuses when the agent's journey is disabled (cf2305e): CONFIRMED for both TEXT backends; the VOICE path is NOT gated

- OpenAI path huddle.functions.ts:4355 and Lovable path :5790: `if (!agentBackend.journey?.enabled)` returns `{error:"journey_disabled"}` BEFORE `claimAction("focus_on")` and before any dispatch. `agentBackend = agentsCfg[nextId] ?? {backend:"lovable"}` (:2194). With no config, `journey` is undefined, so the call refuses (fails closed). tsc exit 0 confirms it is in scope at both sites. Test: ask-shape.test.ts gained one check (regex) and passes.
- **Finding (outside the literal "both backends" claim, same incident class):** voice realtime-tools.server.ts:174 always includes `FOCUS_TOOL` (not gated by `opts.journey`, which gates only the journey catalog at :424). The executor at :526-528 calls `dispatchFocusOn(ctx.caller, args)` with no journey check. So a voice session minted with `journey:false` can still create and start real tasks through focus_on. The 2026-10-28 incident was a text-harness turn, which IS closed.

## Verdict (loop 2, at 508970d)

| AC | result |
|---|---|
| suites | tsc exit 0; all 7 suites pass |
| 1 | PARTLY CONFIRMED: runProduce is now judged (closed). Still bypassing: an agent-invoked journey `update_task` with `assigned_agent` (pre-existing, model-driven, no judge, no guard) |
| 2 | CONFIRMED: 5s race; falls back to the responder |
| 3 | CONFIRMED: no path writes a batch pick over an assigned (roster-owned) task; worst case ~63.5s in-chat (unmeasured), still over 45s |
| 4 | CONFIRMED (unchanged) |
| 5 | CONFIRMED: the chokepoint gate is behaviourally proven; voice and debug are blocked; there is no bypass to /tool. Journey-side exact-match dependency noted. The client-asserted caller is pre-existing; delete is scoped more tightly than update |
| 6 | CONFIRMED (unchanged) |
| 7 | CONFIRMED by reading |
| 8 | CONFIRMED for text OpenAI + Lovable; voice focus_on ignores the journey toggle (finding) |
