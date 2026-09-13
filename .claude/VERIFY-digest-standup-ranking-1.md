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
