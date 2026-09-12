# BUILD — assign-on-direct-ask + verdict memory (2026-09-12)

# WHAT:       Incremental build log for two owner-requested fixes on branch
#             `claude/iris-huddle-interaction-baj51c`.
# WHY:        A container reclaim kills the session silently; this file is written as the work
#             happens so a kill costs one step, not the whole pass.
# SUPERSEDES: nothing
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   commits on this branch; `.claude/actions.md` ACT:assign-on-direct-ask;
#             `.claude/VERIFY-escalated-dead-end-1.md` claim 5.

## Branch state at start

```
git rev-list --left-right --count origin/claude/iris-huddle-interaction-baj51c...HEAD
0	0
```
In sync. No reset/rebase needed.

---

## FIX 1 — a task handed directly to an agent lands with NO assignee

### Verification of the traced diagnosis (line numbers re-checked this session)

| Claim in `actions.md` | Verified? | Actual |
|---|---|---|
| `huddle.functions.ts:2649` resolves owner for the UI card only | YES | `ownerId: resolveTaskOwner(args.ownerId ?? args.owner ?? args.assignee)` at **2649**, on the `SuggestedTaskDraft` literal |
| `:2673-2677` journey write passes no assignee | YES | `invokeJourneyTool({toolName:"quick_create_task", args: dateArg ? {title,date} : {title}, ...})` at **2673-2678** |
| journey `quickCreateTask` accepts only title/date/auto_schedule | YES | `execute-tool/index.ts:2658-2670` — forwards `{text,target_date,auto_schedule}` to `parseAndCreateTasks`. No assignee anywhere in the chain. |
| `autowork.server.ts:370` skips unassigned | (read below) | |
| journey `update_task` writes `assigned_agent` | YES | `execute-tool/index.ts:906-908` |

### THE ARG NAME — read, not assumed

`updateTask` (`journey-voice supabase/functions/execute-tool/index.ts:900`) opens with:

```ts
if (!args.task_id) return { success: false, error: "Task ID is required" };
```

**So the id arg is `task_id`, NOT `id`.** The brief's suggested `{id, assigned_agent}` would have
been rejected with "Task ID is required". Confirmed against the existing consumer
`src/features/huddle/lib/tasks/board.functions.ts:56` which builds
`const args = { task_id: data.taskId }`. The assignee arg IS `assigned_agent`
(`index.ts:906-908`, `if (args.assigned_agent !== undefined) updateData.assigned_agent = ...`).

`update_task` is honest about failure: `.maybeSingle()` then
`if (!data) return { success:false, error: 'No task matched id ... (0 rows updated)' }`
(`index.ts:927-942`). By contrast `batch_update_tasks` returns `success:true` even when every
update failed (`index.ts:985-989`, only a `failed_count` field) — so the SINGULAR `update_task` is
the right tool here, because its `ok` is real evidence.

### WHERE THE NEW TASK ID COMES FROM

`invokeJourneyTool` returns `JourneyToolInvocationResponse` (`journey/types.ts:57-64`) with
`tasks?: JourneyTask[]`, each `{id,title,status,...}`. The proxy builds it in
`huddle-proxy/index.ts:66-88 extractTasks(exec.result)`, reading `result.tasks[]`, which
`parseAndCreateTasks` populates with the real DB rows including `id` (`execute-tool/index.ts:357-371`).
The call site at `huddle.functions.ts:2680` already consumes `r.tasks`. So `r.tasks[*].id` is the
canonical journey uuid — no new plumbing needed.

Caveat recorded honestly: `extractTasks` falls back to `crypto.randomUUID()` for a row with no id.
For `quick_create_task` the id is always present, but if it ever were not, the follow-up
`update_task` would fail with "No task matched id" — non-fatal by design.

### The sibling call site at :1542 — DOES need the same treatment

`runProduce` (`huddle.functions.ts:1534-1582`) is reached only under the 1:1 gate
(`data.scope === "one-to-one"`, line 1518), creates a board task via `quick_create_task` with NO
assignee, then calls `runScheduledAutoWork(..., {force:true})` and tells the user
*"I've put X on the board … and kicked it to the team to work up async."*

Since auto-work skips rows with `assigned_agent = NULL`, **the produce task is inert too** — the
ack is an overclaim. Same root cause, same fix, so it is fixed in the same pass rather than left
as a second unassigned path.

Also confirmed by reading, since the assignment must be one the engine will accept:
`autowork.server.ts:370` `if (!row.assigned_agent) continue;` (confirm reach-outs) **and**
`autowork.server.ts:544` `if (!agent || !AGENT_BY_ID[agent as AgentId]) continue;` (the WIP
bucketing). The second one is why a bare model-supplied string is not good enough — an id that is
not in the roster is dropped just as silently as a NULL.

### What was changed

**New — `src/features/huddle/lib/tasks/assign-on-create.ts`** (pure at module scope, no node
imports, so `bun` can test it; the journey transport is imported dynamically inside the one function
that calls it, like every other journey call site):

- `resolveExplicitOwner(value, roster)` — resolves a model-supplied owner to a REAL roster id or
  **null**. Never defaults. This is the fact the group rule needs and the one the old
  `resolveTaskOwner` could not supply, because it folded "nobody named" and "named the responder"
  into the same answer.
- `isOneToOne(scope, huddleId)` — `scope === "one-to-one"` OR a `dm-` huddle id.
- `pickCreatedTaskAssignee({scope, huddleId, responderId, explicitOwner})` — 1:1 → responder;
  group → only a named owner; otherwise null (unassigned = today's behaviour).
- `assignCreatedJourneyTasks({taskIds, agentId, caller, huddleId})` — the follow-up
  `update_task({task_id, assigned_agent})` per created row, in parallel, capped at 10. Returns an
  `AssignOutcome` whose `assigned` is true only when a journey row really changed.

**`huddle.functions.ts`:**

1. `resolveTaskOwner` is now `resolveNamedTaskOwner(value) ?? winner.id`, with
   `resolveNamedTaskOwner` delegating to `resolveExplicitOwner`. **One matching implementation**, so
   the UI card's owner and the canonical assignee cannot disagree. One deliberate tightening: the
   loose substring branches now need >= 2 characters, so a 1-char model slip no longer picks an
   agent. That was harmless when it only tinted a card; it is not harmless when it writes a
   canonical assignment.
2. `createSuggestedTaskFromTool` computes `namedOwner` once, uses `namedOwner ?? winner.id` for the
   card, and after a SUCCESSFUL `quick_create_task` calls `pickCreatedTaskAssignee` +
   `assignCreatedJourneyTasks`. The tool result gained `assigned` / `assignedTo`, and the note now
   carries the assignment outcome verbatim; the breadcrumb shows `· assigned to X` or
   `· NOT assigned (<error>)`.
3. `runProduce` (the 1:1 produce path, the sibling call site at what was :1542) does the same for
   the agent taking the task on.

### Offline test

`scripts/assign-on-create.test.ts`, wired as `npm run test:assign-on-create`. It imports the REAL
`AGENTS` / `AGENT_BY_ID` and the REAL functions — no copied constants, no fixture roster. One case
asserts every roster name resolves to an id that is present in `AGENT_BY_ID`, which is the exact
predicate `autowork.server.ts:544` applies.

```
$ bun scripts/assign-on-create.test.ts
... 45 checks ...
ALL PASS
```

### Full suite + typecheck before commit

```
$ npx tsc --noEmit
TSC_EXIT=0
```

| suite | exit | result |
|---|---|---|
| test:router | 0 | 20 pass |
| test:blocked | 0 | pass |
| test:presence | 0 | 18 pass |
| test:mode | 0 | 22 pass |
| test:voice-tools | 0 | 36 pass |
| test:cross-app | 0 | 83 passed, 0 failed |
| test:email-gate | 0 | 73 passed, 0 failed |
| test:nexus-tools | 0 | 2 pass |
| test:turn-identity | 0 | 23 pass |
| test:override-gate | 0 | 60 pass |
| test:green-light | 0 | 78 pass |
| test:assign-on-create | 0 | 45 pass |
