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

### Mutation proof (fix 1) — `mutate.sh`, verbatim

Anchors and replacements came from FILES, never shell arguments.

```
===== M1 group-only-when-named =====
FIRED: 'group, nobody named -> null (left for grooming, NOT dumped on the lead)' failed with the defect reinstated. The guard is real.
restored: src/features/huddle/lib/tasks/assign-on-create.ts matches HEAD
tree clean: ... passes again on the restored tree

===== M2 one-to-one-assigns-responder =====
FIRED: '1:1, no owner named -> the responder' failed with the defect reinstated. The guard is real.
restored: src/features/huddle/lib/tasks/assign-on-create.ts matches HEAD

===== M3 no-silent-default =====
FIRED: 'resolveExplicitOwner("nobody-by-that-name")' failed with the defect reinstated. The guard is real.
restored: src/features/huddle/lib/tasks/assign-on-create.ts matches HEAD

===== M4 one-char-slip =====
FIRED: 'a 1-char slip does not fuzzy-match anyone' failed with the defect reinstated. The guard is real.
restored: src/features/huddle/lib/tasks/assign-on-create.ts matches HEAD

===== M5 dm-huddle-is-one-to-one =====
FIRED: 'huddleId "dm-<id>" even when scope says group' failed with the defect reinstated. The guard is real.
restored: src/features/huddle/lib/tasks/assign-on-create.ts matches HEAD
```

5 FIRED, 0 INERT, 0 NOT-APPLIED.

### A note on the commit

The first `git add -A` swept in three files this lane did not author — another lane's uncommitted
override-quote-hardening work (`approach-override.ts`, `green-light.ts`,
`.claude/BUILD-override-quote-hardening.md`). The commit was soft-reset and re-made with only this
lane's five files; the other lane's changes were left uncommitted exactly as found (the
`eds-git-guard` PostToolUse autosave already mirrors them to `refs/heads/eds-wip/*`).

---

## FIX 2 — "already said go" is not remembered, so the produce-vs-quick question re-asks

### Verification of the verifier's description (read directly, not taken on trust)

| Claim | Verified? | Where |
|---|---|---|
| the pending row is `PRIMARY KEY (user_email, huddle_id)` | YES | `deep-confirm.server.ts` BOOTSTRAP, line 28 |
| EVERY verdict deletes the row | YES | `huddle.functions.ts` quick -> `clearPendingDeepConfirm` (was :1598), produce -> `clear` (:1600), cancel -> `clear` (:1604) |
| the ask is gated on that row | YES | `getPendingDeepConfirm` at the top of the gate; the fresh-ask branch fires on `!deepManual && winners.length && difficulty >= 3` |
| only `data.modelEscalate` suppresses it | **STALE** | `hasGreenLit(recentUserLines)` was added earlier today and also suppresses. See below — it does not cover the case being fixed. |

**The part that matters, and it is measured rather than reasoned.** The green-light suppression
added today does NOT cover an ANSWERED gate, because the words the gate asks for are not go-ahead
idioms:

```
$ bun -e 'import {isGreenLight,hasGreenLit} from "./src/features/huddle/lib/tasks/green-light";...'
"produce"    -> isGreenLight: false
"quick"      -> isGreenLight: false
"produce it" -> isGreenLight: false
"yes"        -> isGreenLight: false
hasGreenLit(["produce"]): false
```

So replying with the exact word the gate asked for suppressed nothing at all, and the next
difficulty>=3 message in the same 1:1 asked again from scratch. The defect is real and uncovered.

### What was changed

**New — `src/features/huddle/lib/tasks/verdict-memory.ts`** (pure, no node imports):
`VERDICT_MEMORY_MS`, `asRememberedVerdict`, `verdictToApply(verdict, atMs, nowMs)`.

**`deep-confirm.server.ts` — the EXISTING row is extended, no new table:**
three idempotent `ADD COLUMN IF NOT EXISTS` — `resolved_at`, `last_verdict`, `last_verdict_at`.
- `getPendingDeepConfirm` gains `AND resolved_at IS NULL` on **both** query branches, so a verdict
  memory can never masquerade as an outstanding ask.
- `setPendingDeepConfirm` sets `resolved_at=NULL` on conflict — a new ask reopens the row.
- **new** `recordDeepConfirmVerdict(...)` — retires the pending and stores the verdict.
  UPDATE-then-INSERT rather than a bare upsert, because the read path resolves a user by `user_id`
  OR any of their emails, so `ON CONFLICT (user_email, huddle_id)` alone could create a second row
  under the user's other address. The INSERT covers the green-lit path, which has no pending row.
- **new** `getRecentDeepVerdict(...)` — returns the verdict only if `verdictToApply` says it is
  still in-window. Null on any error, i.e. ask normally.

**`huddle.functions.ts`:** produce and quick now RECORD instead of clearing; **cancel still calls
`clearPendingDeepConfirm`**, which deletes the row and takes the memory with it, so parking one ask
can never silence a later genuine one. The fresh-ask branch consults `getRecentDeepVerdict` before
asking — `produce` runs the produce path, `quick` drops to the `terra-med` tier and answers inline,
anything else asks exactly as before. The green-lit path also records its verdict, because
`hasGreenLit` only looks back four user lines and decays out mid-conversation.

### THE WINDOW IS A JUDGEMENT CALL AND IS TUNABLE

`VERDICT_MEMORY_MS = 30 * 60_000` — thirty minutes, a named constant with the reasoning in its
doc comment. The failure being fixed is a re-ask "a minute later" inside one continuous
conversation, and half an hour covers a sitting at the keyboard; it is also well inside the store's
existing 2h pending expiry, since a verdict should not outlive an unanswered ask. It refreshes on
every verdict, so a flowing conversation keeps the memory warm rather than hitting a cliff.
**Change the constant to tune it — nothing else reads a duration.**

### Executed against a real Postgres, on a POPULATED old-schema database

A fresh database would have proved nothing: `CREATE TABLE IF NOT EXISTS` is skipped on the database
that actually matters, so the new columns can only arrive via the idempotent ALTERs.

```
=== 1. OLD (HEAD) bootstrap ===            OK old schema applied, exit 0
=== 2. seed a live pending ask ===         1 row
=== 3. NEW bootstrap ON TOP ===            NOTICE: relation "deep_confirm" already exists, skipping
                                           OK new schema applied on top, exit 0
```
and the resulting table carries all three new columns alongside the pre-existing row.

Then the REAL store functions (not a paraphrase of their SQL) were exercised against that database —
15/15 PASS, including that the pre-migration row still reads as pending, that `produce` retires the
ask but is remembered, that the memory expires, that `cancel` wipes both, that the no-pending INSERT
fallback works, and that huddles are isolated. Preserved as
**`scripts/deep-confirm-store.probe.ts`**, which SKIPS cleanly (exit 0) unless
`DEEP_CONFIRM_TEST_PG_URL` is set; the header carries the exact commands to stand a cluster up.

> One local-harness gotcha worth recording: the store's pool hardcodes `ssl`, so against a local
> cluster with SSL off EVERY call returns null via its own best-effort catch — which looks exactly
> like a code defect. `ssl=on` + a self-signed cert is required. Half an hour was nearly spent
> debugging working code.

### Offline test

`scripts/verdict-memory.test.ts` (`npm run test:verdict-memory`) — 46 checks. It **imports**
`VERDICT_MEMORY_MS` rather than copying it, so tuning the window cannot leave a test asserting the
old value; the bounds it does assert are sanity bounds (positive, < the 2h expiry, >= 5 min).
It also carries STRUCTURAL guards for the half no offline runtime test can reach: both
`getPendingDeepConfirm` branches filter `resolved_at IS NULL`, produce/quick record while cancel
clears, and the memory is read BEFORE the ask is stored. Comments are stripped before matching, so
a guard cannot pass on prose.
