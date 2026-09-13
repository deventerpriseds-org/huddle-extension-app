<!--
WHAT:          independent verification of the stand-up ranking fix (AC-SU-2..5), loop 1.
WHY:           the implementer self-reported 10/10 + 4 FIRED mutations; a Tier-1 ranking path
               that decides what the owner is told their priorities are needs a cold adversarial
               re-run, not a reread of the claim.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      every verdict below quotes the command and its real output.
-->

# VERIFY — digest-standup-ranking, loop 1

Repo `/home/user/huddle-extension-app`, branch `claude/huddle-workflows-setup-cucecs`, head `2aca67f`.

## Claim 1 — standup gets priorities via `rankTasks`, not a raw `priority_rank` sort — **CONFIRMED**

`git diff origin/main...HEAD -- src/features/huddle/lib/tasks/standup.server.ts`

```
-  const priorities = notDone
-    .filter((t) => !blockers.has(t.id))
-    .sort((a, b) => (a.priority_rank ?? 9999) - (b.priority_rank ?? 9999))
-    .slice(0, 5)
-    .map((t) => ({ title: t.title, agent: t.assigned_agent }));
+  const scorable = await getTasksForUser(email);
+  const priorities = selectStandupPriorities(scorable, blockers);
```

and the new seam:

```
+export function selectStandupPriorities(
+  tasks: ScorableTask[],
+  blockedIds: { has(id: string): boolean },
+  limit = 5,
+): { title: string; agent: string | null }[] {
+  const byId = new Map(tasks.map((t) => [t.id, t]));
+  return rankTasks(
+    tasks.filter((t) => !blockedIds.has(t.id)),
+    limit,
+  ).map((r) => ({ title: r.title, agent: byId.get(r.id)?.assigned_agent ?? null }));
+}
```

The raw sort is gone; `rankTasks` (`scoring.ts:123`) is the only ordering. Confirmed.

## Claim 2 — `rankTasks` UNMODIFIED and no filter copied into the standup — **CONFIRMED**

```
$ git diff origin/main...HEAD -- src/features/huddle/lib/tasks/scoring.ts
$ echo exit=$?
exit=0        # zero bytes of diff
```

`git diff --stat origin/main...HEAD` lists six files and `scoring.ts` is not one of them:

```
 .claude/IMPL-standup-ranking.md                 | 121 ++++++++++++++++++++++++
 .claude/actions.md                              |  28 ++++++
 .claude/memory.md                               |  44 +++++++++
 package.json                                    |   1 +
 scripts/standup-ranking.test.ts                 |  97 +++++++++++++++++++
 src/features/huddle/lib/tasks/standup.server.ts |  40 ++++++--
```

No filter was copied: `grep -n "parking" src/features/huddle/lib/tasks/standup.server.ts` returns
only lines 41 and 176, both **comments**. The single `.filter()` in `selectStandupPriorities` is
`!blockedIds.has(t.id)` — stand-up-specific (a blocked item is reported in the BLOCKED section),
not a duplicate of anything in `scoring.ts`. This EXTENDED rather than duplicated.

## Claim 8 — `BoardTaskRow` cannot be a `ScorableTask` — **CONFIRMED (and stronger than claimed)**

`ScorableTask` (`scoring.ts:10-26`) requires:
`pushed_count`, `created_at`, `is_scheduled?`, `start_time?`, plus `priority: TaskPriority` and
`is_priority: boolean` (both non-null).

`BoardTaskRow` (`tasks.server.ts:1361`) in full:

```
export interface BoardTaskRow {
  id; title; status; priority: string | null; category; is_priority: boolean | null;
  priority_rank; due_date; completed_at; assigned_agent; tags; definition_of_done;
  artifacts?: ...
}
```

All four named fields are absent — **and the SQL does not fetch them either**, so this is not a
type-only gap that a widened interface could paper over:

```
  const plain = `
    SELECT id,title,status,priority,category,is_priority,priority_rank,due_date,completed_at,assigned_agent,tags,definition_of_done
      FROM tasks.journey_tasks
```

vs `getTasksForUser` (`tasks.server.ts:449`):

```
  let sql = `SELECT id,title,status,priority,category,is_priority,priority_rank,due_date,pushed_count,created_at,completed_at,assigned_agent,tags,is_scheduled,start_time
             FROM tasks.journey_tasks WHERE lower(user_email) = ANY($1)`;
```

Two further incompatibilities the implementer did not claim: `priority: string | null` vs
`TaskPriority`, and `is_priority: boolean | null` vs `boolean` — `scoreTask` reads
`PRIORITY_WEIGHT[task.priority]`, which is `undefined` for a null. The producer swap was
**necessary scope, not over-reach**.

## Claim 3 — `dispatchPrioritize` and every other `rankTasks` caller behaviourally unchanged — **CONFIRMED (for the branch's own base) — see FINDING 1**

```
$ git diff origin/main...HEAD -- src/features/huddle/lib/tasks/tools.ts
[no output]
$ git diff origin/main...HEAD -- src/features/huddle/lib/tasks/scoring.ts
[no output]
```

`grep -rn "rankTasks" src/ scripts/` shows exactly two non-comment call sites: `tools.ts:246`
(`dispatchPrioritize`, untouched) and the new `standup.server.ts:50`. Nothing else calls it.
`scoring.ts` is byte-identical to the merge-base, so no caller can have changed behaviour.

## Claim 4 — the parked task is in NEITHER surface now, and WAS first before — **CONFIRMED, independently reconstructed**

New code, `bun scripts/standup-ranking.test.ts`:

```
prioritize: ["Real priority","Non-priority with rank 1","Same Title Task","Plain work item"]
standup:    ["Real priority","Non-priority with rank 1","Same Title Task","Plain work item"]
```

`Prepare investor pitch` (tags `["parking-lot"]`, `priority_rank: 1`, `is_priority: true`,
`priority: "URGENT"`) is absent from both.

I did **not** trust the note for the "did appear first" half. I copied origin/main's removed hunk
verbatim into a standalone script over the identical fixture
(`scratchpad/old-sort.ts`) and ran it:

```
$ bun /tmp/.../scratchpad/old-sort.ts
OLD standup priorities: ["Prepare investor pitch","Non-priority with rank 1","Real priority","Same Title Task","same title task  "]
parked task index under OLD code: 0
```

The parked task was **index 0** — the first thing the owner was told to work on. The same run also
shows the old code independently violated AC-SU-4 (`Real priority` at index 2, not 0) and AC-SU-5
(both `Same Title Task` duplicates listed). The leak was real and three-way.

## Claim 7 — `buildBrief` signature + downstream path reconcile — **CONFIRMED**

`git diff origin/main...HEAD -- standup.server.ts` contains **no hunk touching `buildBrief`**; the
only three hunks are the `import`, the new `selectStandupPriorities`, the destructure line, and the
`priorities` block. The call site is unchanged:

```
  await surfaceDigest({ email, tz, caller, brief: buildBrief(produced, movedToReview, blocked, priorities), runId });
```

`priorities` is still `{ title, agent }[]` — `selectStandupPriorities` returns exactly
`{ title: string; agent: string | null }[]`. `scripts/blocked-line.test.mjs` imports `buildBrief`
with the same 4-arg shape and is unaffected. Downstream, `surfaceDigest` receives `brief` as a
string, so `enqueueTurn → runTurnById` is untouched.

---

# FINDING 1 (material, not in the implementer's account) — the branch is **219 commits behind `origin/main`**, and `rankTasks` has ALREADY grown a third parameter there

```
$ git rev-list --left-right --count origin/main...HEAD
219	5
$ git merge-base origin/main HEAD
5002158bfc85c8ee95f4fa69545c5f555dd02635
```

Every claim above was verified against the **merge-base**, which is the right frame for "did this
change duplicate anything". But `origin/main` has since changed the very function this lane
single-sources on:

```
$ git diff origin/main HEAD -- src/features/huddle/lib/tasks/scoring.ts
-export function rankTasks(tasks: ScorableTask[], limit = 25, excludeIds?: ReadonlySet<string>): RankedTask[] {
+export function rankTasks(tasks: ScorableTask[], limit = 25): RankedTask[] {
```

(direction is origin/main → branch, i.e. **main has `excludeIds`; the branch's base does not**),
and `dispatchPrioritize` on main already passes it:

```
$ git show origin/main:src/features/huddle/lib/tasks/tools.ts | grep -n "rankTasks("
410:    const ranked = rankTasks(inView, limit, await taskIdsInReminderWindow(userEmail));
```

`selectStandupPriorities` calls `rankTasks(filtered, limit)` — **two arguments**. `excludeIds` is
optional, so nothing fails to compile. The consequence is behavioural and is exactly the defect
class this lane exists to close:

> **On merge, a `reminder`-tagged task inside its reminder window will be DROPPED by `prioritize`
> and still SURFACE in the stand-up.** AC-SU-3 ("the two title lists are identical and in the same
> order") is reopened by the merge itself.

The committed guard does not protect against this quietly: after merge, `dispatchPrioritize` would
call `taskIdsInReminderWindow`, which the test's `mock.module` replaces away (the stub exports only
`getTasksForUser`), so the suite would throw rather than pass — loud, but it means the guard must be
re-authored at merge time, and the obvious "fix" (stub it to an empty set) would make the divergence
invisible again.

**Smallest change that would fix it:** give `selectStandupPriorities` an `excludeIds` parameter and
forward it, and have `runScheduledStandup` pass `await taskIdsInReminderWindow(email)` — the same
value `dispatchPrioritize` passes. To be done as part of merging `origin/main` into the branch,
which has to happen anyway.

`origin/main`'s `standup.server.ts` still carries the raw sort at line 165, so the branch is not
racing another fix — but it is also missing 219 commits of main, including an `artifacts` "Uploads"
discrimination filter in this same function that the branch's base predates.
