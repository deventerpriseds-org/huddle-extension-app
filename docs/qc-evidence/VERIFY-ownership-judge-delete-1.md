# VERIFY ownership-judge-delete, loop 1

- WHAT: independent verification of PR #124 (huddle-extension-app) at e56147d vs origin/main 8302cb6
- WHY: Tier-1 (ownership decides who works a task; delete is destructive). Verifier pass requested by the session.
- SUPERSEDES: nothing
- SUPERSEDED-BY: nothing -- current
- EVIDENCE: this file; commands below were run in an isolated worktree at detached e56147d.

## Suite run (observed)

| command | result |
|---|---|
| `npx tsc --noEmit -p .` | exit 0, no output |
| `bun scripts/ownership-judge.test.ts` | ALL PASS, exit 0 |
| `bun scripts/board-delete.test.ts` | ALL PASS, exit 0 |
| `bun scripts/assign-on-create.test.ts` | ALL PASS, exit 0 |
| `bun scripts/ask-shape.test.ts` | ALL PASS, exit 0 |
| `bun scripts/verdict-memory.test.ts` | ALL PASS, exit 0 |
| `bun scripts/router-winners.test.ts` | 20 passed, 0 failed |
| `bun scripts/priority-lane.test.ts` | 10 passed, 0 failed |

Note: ownership-judge.test.ts and board-delete.test.ts are almost entirely regex-on-source checks. They prove text is present, not behaviour.

## AC1 — every ownership decision goes through resolveOwnerLLM: PARTLY CONFIRMED (the three named paths do; one more writer does not)

Judge call sites (grep `resolveOwnerLLM` in src):
- huddle.functions.ts:2883, 1:1 task creation (on the title, `winner.id` as default)
- huddle.functions.ts:6745, 1:1 hand-off (on `data.text`, `nextId` as default)
- groom.ts:320, grooming (framing "assigned")

Every other place that writes `assigned_agent` to journey:

| site | what it writes | through judge? | should it be? |
|---|---|---|---|
| huddle.functions.ts:1635 `runProduce` (produce-offer accepted / deep-confirm produce) | `agentId` = `pending.agentId` (the agent that made the offer) | NO | Arguably yes. It is a 1:1 ownership decision. After this PR the offer is suppressed once a hand-off resolves within 3s, which mostly closes it. But if the judge takes longer than 3s, the offer still goes out, and a "produce" reply then assigns the task to the original agent while the lane owner has already been tapped. |
| board.functions.ts:59 `updateBoardTask` (drag or menu reassign) | the user's explicit choice | NO | No. A user decision must not be second-guessed. Note that grooming's judge CAN later move a task the user assigned by hand, because nothing marks it as user-pinned. That was true of the batch model before too. |
| groom.ts:391 batch_update_tasks | judge output, or the batch pick for budget-skipped tasks | partly (see AC3) | — |
| tasks.server.ts:381 mirror upsert | copy of journey (sync trigger) | n/a | no (not a decision) |
| create_huddle_tasks (plural, huddle.functions.ts:3125 `parse_and_create_tasks`) | writes NO assignee; the row lands unassigned | no | Gap worth knowing. The tool prompt (huddle.functions.ts:2469) tells agents to use the PLURAL tool for more than one task. The Oct 9 incident was TWO tasks, so the plural path is a likely route for it. On that path the judge does not run at creation, and the row waits for grooming, where the incumbent is the batch pick. The fallback card (huddle.functions.ts:3196) shows `resolveTaskOwner` = the responder. |
| voice create_huddle_task (realtime-tools.server.ts) | no assignment call found | no | Same gap as the plural tool for voice-created tasks. |

## AC2 — 1:1 creation order and card/assignee agreement: CONFIRMED on order and agreement; latency is UNBOUNDED

- Order (huddle.functions.ts:2878-2892, assign-on-create.ts:89-92): `namedOwner` → `capabilityOwnerFor(title)` → `resolveOwnerLLM(title, winner.id)` → `winner.id`. On a thrown error or no key, `laneOwner` stays null and the responder wins. CONFIRMED.
- The capability step is effectively dead code here. The meta-task guard earlier in `createSuggestedTaskFromTool` already returns early when `capabilityOwnerFor(title)` is an exclusive owner other than the filer (CLAUDE.md "Meta-task guard"). By this point that step can only return `winner.id` or null.
- Card vs journey (1:1): card `ownerId = namedOwner ?? laneOwner ?? winner.id` (line 2896); assignee = `pickCreatedTaskAssignee` = `explicitOwner ?? laneOwner ?? responder` in a 1:1. The two expressions are identical. CONFIRMED. When journey echoes rows, the board shows the journey row (`journeyTaskUpdates`), not `task`, so the card owner comes from journey after sync.
- Group: `laneOwner` is only computed when `isOneToOne(...)` is true, and `pickCreatedTaskAssignee` returns null for a group with no named owner. assign-on-create.test "group ignores a lane owner" passes. CONFIRMED, unchanged.
- LATENCY RISK (finding): the judge call is AWAITED inline, inside the agent's tool call, with NO timeout. `callOpenAIRouter` (openai-responses.server.ts:43) calls `fetch` with no AbortSignal or deadline, and the create site has no `withTimeout`. That adds one serial OpenAI round trip per created task, on the reply's critical path (typical router latency is about 0.5-2s, not measured here). A hung or slow OpenAI call blocks the tool result, and so the turn, until the platform kills it. The hand-off path is fire-and-forget and grooming uses `withTimeout(6s)`. This is the only one of the three judge callers with no bound.

## AC3 — grooming: CONFIRMED for the incumbent and the per-call timeout; REFUTED that "a failure can never reshuffle owners"

- Incumbent: `incumbentOwner(current, batchPick)` (groom.ts:148) = current when it is a valid agent id, else the batch pick. Unit checks pass (4/4). CONFIRMED.
- Framing "assigned" is passed (groom.ts:320-325). CONFIRMED.
- Per-call failure or 6s timeout → `.catch(() => null)` → `judged ?? incumbent`. CONFIRMED (groom.ts:319-329).
- Budget: a task the 12s budget does not reach returns early and keeps `a.assigned_agent` = the BATCH PICK. The outer `catch` (judge import fails) also leaves every task on the batch pick.
- **Reshuffle path exists (REFUTED as stated in the code comment at groom.ts:305):** for an ALREADY-ASSIGNED task that is budget-skipped, or when the outer catch fires, the owner written is the batch model's pick, which can differ from the current owner. That matches the old behaviour, but the comment's guarantee only holds for per-call failures. The fix would be `a.assigned_agent = incumbent` on the skip and catch paths. It is not applied here (verifier only).
- The budget is checked only when a task STARTS (`if (Date.now() - _tJ0 > JUDGE_BUDGET_MS) return;`). Up to 10 calls already in flight can run 6s more, so the judge phase can last up to about 18s, not 12s.
- Prompt for an UNASSIGNED task says "currently owned by <batch pick>" and "It already has an owner". That is not literally true, but it is a coherent way to make the batch pick the default.
- 45s ceiling estimate (from the code's own deadlines, not measured):
  - Interactive cap: the brief says 40, but the code caps in-chat grooming at **25 (default 15)**: `cap = opts?.maxLimit ?? 25`, groom.ts:196-197. The tool description at groom.ts:24 still says "default 40", which is stale. The 80 cap applies only to grooming.server.ts:143 (scheduled).
  - Worst case before the PR: classify 15s + write 18s + wait 2.5s + autowork 15s = **50.5s** (already over 45s).
  - Worst case after: plus judge about 18s = **about 68.5s**.
  - Typical added time: 15 tasks / 10 concurrent = 2 waves (about 2-4s); 25 tasks = 3 waves; 80 tasks = 8 waves (about 8-16s, so the 12s budget will often cut the tail and those tasks keep the batch pick).
  - So yes, an in-chat grooming can now exceed 45s more often; it could before too. UNPROVEN by measurement.
- `resolveOwnerLLM` is called with no temperature setting, across up to 80 tasks a week. Owner flip-flop between passes resets confirm state (groom.ts prompt "ASSIGNMENT STABILITY"). The "DEFAULT STRONGLY to keeping" wording mitigates this, but it is not measured. UNPROVEN.

## AC4 — prompt coherence, "dm" framing unchanged in meaning, strict output still valid: CONFIRMED (the dm prompt is not byte-identical)

- System, dm branch: the new string = the old string byte for byte (the dm text ends "...agent's. " and is then joined with the shared "Judge by intent..." tail; old routing.ts at 8302cb6 L555-559).
- Prompt, dm branch: two wording changes that apply to BOTH framings. "KEEP it with the agent they addressed (the default)" became "KEEP it with ${addressed.name} (the default)", and "when the request plainly belongs" became "when it plainly belongs". The meaning is the same; the bytes are not.
- "assigned" framing: system and prompt read coherently ("currently owned by X ... DEFAULT STRONGLY to keeping it").
- Strict: the schema is `{type:object, additionalProperties:false, properties:{owner:{type:string, enum:[roster ids]}}, required:["owner"]}`, sent with `strict: true` (openai-responses.server.ts:37). All properties are required and additionalProperties is false, so the schema is valid under strict mode. Unchanged by the PR.

## AC5 — delete: UI and journey scoping CONFIRMED; the cross-user guarantee and agent non-exposure are REFUTED as stated

- Both renders: `onDelete={applyDelete}` appears 2 times (BoardView.tsx:560 desktop grid, :634 mobile list). CONFIRMED.
- Only the confirm action deletes. `onDelete(task.id)` appears once, inside `AlertDialogAction` (BoardView). The hover button (desktop, `!onMove`) and the menu item (mobile) only call `setConfirmDelete(true)`. CONFIRMED.
- Optimistic remove and restore on failure (`applyDelete`): CONFIRMED, with two minor defects.
  1. It restores the WHOLE pre-delete list snapshot. Delete A, then delete B before A's response arrives; if A fails, `setTasks(prevA)` brings back B too, even though B was deleted in journey (and any move made in between is reverted on screen) until the next refetch.
  2. `prev` is captured inside the state updater. It relies on React running the updater before the network call returns, which holds in practice.
- Server fn: `if (!data.caller?.entra_email) return {ok:false,"Sign-in required."}` then `invokeJourneyTool({toolName:"delete_task", args:{task_id}})` (board.functions.ts:86-107). CONFIRMED as written.
- journey `deleteTask` (squash 9c81e5f, read via the GitHub API): `.delete().eq('id', task_id).eq('user_id', userId)`; zero rows returns "Task not found". Scoped to `userId`. CONFIRMED.
- How huddle-proxy resolves userId (journey `supabase/functions/huddle-proxy/index.ts` @ main):
  1. The bearer must equal `JOURNEY_PROXY_TOKEN`.
  2. `userId` comes from `caller.entra_email` in the REQUEST BODY: alias table first, then `profiles.email`.
  3. In Huddle, `caller` is a client-supplied field of the server-fn input (`Caller` zod object, board.functions.ts:10). No server middleware verifies it: src/start.ts registers only `errorMiddleware`.
  So "a user can't delete another user's task" holds only relative to a TRUSTED caller email. A client that puts someone else's email in `caller` plus a task uuid would delete that user's row. This is the same pre-existing trust model as `updateBoardTask`, but delete is the first irreversible action on it. **REFUTED in the strong sense; pre-existing design.**
- Mirror removal on DELETE: journey migration `20260711120000_huddle_task_sync.sql` fires `AFTER INSERT OR UPDATE OR DELETE ON public.tasks`, and Huddle `src/routes/api/public/tasks-sync.ts:54-55` calls `deleteJourneyTask(id)` (`DELETE FROM tasks.journey_tasks WHERE id=$1`, tasks.server.ts:410). CONFIRMED from source; not exercised live.
- Agent exposure:
  - Text path: journey tools are dispatched only when `journeyNames.has(c.name)` (huddle.functions.ts:4667 and 6223 via the catalog). The catalog comes from execute-tool `/definitions`; a GitHub code search for `delete_task` in journey-voice finds it only in the `case 'delete_task'` switch, not in a definition. So it is not offered to text agents. CONFIRMED.
  - **Voice path: REFUTED.** `executeRealtimeTool` forwards ANY non-native name straight to `invokeJourneyTool({toolName: name})` with no catalog check (voice/realtime-tools.server.ts:819-825). Its server-fn entry `runRealtimeTool` takes `name` from the client body (realtime.functions.ts:186-201). The model is never offered `delete_task`, but the path does pass an arbitrary journey toolName, and `delete_task` is now a live name there.
  - `invokeJourneyToolDebug` (journey/proxy.functions.ts:213) is also a public server fn that takes an arbitrary `toolName` and `caller`.
  - Neither path is new in this PR, but both now reach a destructive tool.

## AC6 — hand-off offer suppression: CONFIRMED, with one edge

- `followupResolution` is assigned the 1:1 lane-owner IIFE, `(async () => {...resolveOwnerLLM(data.text, nextId)...; deliverIfOwner(ownerId)})().catch(() => {})` (huddle.functions.ts:6738-6753). CONFIRMED.
- `ensureProduceOfferDelivered` (6916-6925): returns immediately when `!produceOffer`. Otherwise it races `followupResolution.catch(()=>{})` against a 3000ms timer, then `if (followupDelivered.size > 0) return;`. CONFIRMED.
- Capability path: `deliverIfOwner(capOwnerId)` adds to `followupDelivered` SYNCHRONOUSLY (before the void delivery), and `followupResolution` stays null, so the size check suppresses the offer. CONFIRMED.
- No unhandled rejection: the IIFE carries `.catch(() => {})`, the race uses `.catch(() => {})` again, `resolveOwnerLLM` never throws, and `deliverOwnerFollowup` is internally try/catch'd. CONFIRMED.
- Which turns wait: only turns where `produceOffer` was set (huddle.functions.ts:1753) AND a 1:1 lane-owner resolution is in flight. Every other turn returns at `if (!produceOffer) return;` with no wait. CONFIRMED. The 3s timer is not cleared after the race; that is harmless.
- Edge 1: `followupDelivered.add` happens before the asynchronous `deliverOwnerFollowup` succeeds. If the follow-up enqueue later fails silently, the offer is still suppressed, and the user gets neither the offer nor the owner's DM.
- Edge 2: if the judge takes longer than 3s, the offer goes out (documented), which reopens the runProduce gap in AC1.
- Edge 3: when several agents reply in one turn, each reassigns `followupResolution`, so only the last one is awaited. Earlier ones still populate `followupDelivered` if they finish first.

## AC7 — harness env overrides: CONFIRMED

- durable-harness.mjs: `HID = HUDDLE_ID || "all-members"`, `SCOPE = HUDDLE_SCOPE || "group"`, `TARGET = HUDDLE_TARGET`. The payload uses `scope: SCOPE` and spreads `targetAgentId` only when it is set. The server schema accepts `scope: z.enum(["one-to-one","group"])` and `targetAgentId: z.enum(AgentIds)` (huddle.functions.ts:195-198).
- qa-iris-plan-durable.mjs sets HUDDLE_ID=dm-iris-chase, SCOPE=one-to-one, TARGET=iris-chase, MEMBERS=iris-chase, and a `Test-` prefixed text BEFORE `await import("./durable-harness.mjs")`. Dynamic import, so the env is set before the harness reads it at module evaluation.
- journey: every agent is built with `journey: { enabled: false }` (durable-harness.mjs:33).
- Not run live (the brief forbids live scripts).

## Verdict

| AC | result |
|---|---|
| 1 | PARTLY CONFIRMED — the three named paths use the judge; `runProduce` (huddle.functions.ts:1635) assigns without it; the plural/voice creates leave rows unassigned |
| 2 | CONFIRMED (order, card = assignee, group unchanged); finding: judge awaited with NO timeout on the reply path |
| 3 | CONFIRMED (incumbent, framing, per-call fallback); REFUTED "a failure can never reshuffle": budget-skip and outer-catch use the batch pick for assigned tasks; judge phase can last about 18s; in-chat worst case about 68.5s (was 50.5s); interactive cap is 25, not 40 |
| 4 | CONFIRMED (dm meaning unchanged, two wording edits; strict valid) |
| 5 | UI, journey user_id scoping and mirror CONFIRMED; cross-user safety REFUTED in the strong sense (client-asserted caller); agent non-exposure REFUTED for the voice executor path (arbitrary toolName passthrough) |
| 6 | CONFIRMED; edges: suppression counts an un-confirmed delivery; more than 3s reopens the offer |
| 7 | CONFIRMED by reading; not run |
