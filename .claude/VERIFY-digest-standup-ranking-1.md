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

## Claim 5 — `npm run test:standup-ranking` passes 10/10, driving BOTH production entry points over ONE fixture — **CONFIRMED, with one caveat (FINDING 2)**

```
$ bun scripts/standup-ranking.test.ts
prioritize: ["Real priority","Non-priority with rank 1","Same Title Task","Plain work item"]
standup:    ["Real priority","Non-priority with rank 1","Same Title Task","Plain work item"]
ok AC-SU-2 standup drops the parking-lot task
ok AC-SU-2 prioritize drops the parking-lot task
ok AC-SU-3 standup and prioritize agree exactly, same order
ok AC-SU-3 the comparison is non-trivial (both non-empty)
ok AC-SU-4 standup puts the is_priority task first
ok AC-SU-4 prioritize puts the is_priority task first
ok AC-SU-5 standup dedups the duplicate title
ok AC-SU-5 prioritize dedups the duplicate title
ok standup.server.ts calls rankTasks (single source of ranking truth)
ok standup.server.ts hand-rolls no priority_rank sort

10 passed, 0 failed
EXIT=0
```

10/10 reproduced. **Not** a hand-written expected order: the load-bearing assertion is
`standupTitles.join("|") === prioritizeTitles.join("|")` — the two lists compared to each other. The
only literals asserted are `[0] === "Real priority"` (which is AC-SU-4's own wording, "assert index 0
is the is_priority task in both outputs") and the dedup count. One fixture feeds both surfaces.

Both entry points are real production code: `dispatchPrioritize` (`tools.ts`) via `mock.module` on
`./tasks.server`, and `selectStandupPriorities` (`standup.server.ts`). See FINDING 2 for what that
second one does *not* cover.

## Claim 6 — the four mutations genuinely FIRED — **CONFIRMED, re-run independently**

Anchor taken from the file (`sed -n '49,53p'`, verified unique: `count = 1`), replacement reinstating
origin/main's raw sort, both passed to `mutate.sh` as FILES.

```
$ mutate.sh src/features/huddle/lib/tasks/standup.server.ts $SP/anchor.txt $SP/repl.txt \
            "bun scripts/standup-ranking.test.ts" "<name>"
```

| # | must-fail test | outcome |
|---|---|---|
| 1 | `AC-SU-2 standup drops the parking-lot task` | **FIRED** |
| 2 | `AC-SU-3 standup and prioritize agree exactly, same order` | **FIRED** |
| 3 | `AC-SU-4 standup puts the is_priority task first` | **FIRED** |
| 4 | `AC-SU-5 standup dedups the duplicate title` | **FIRED** |

Verbatim, for each of the four:

```
FIRED: '<name>' failed with the defect reinstated. The guard is real.
restored: src/features/huddle/lib/tasks/standup.server.ts matches HEAD
tree clean: '<name>' passes again on the restored tree (build output regenerated)
EXIT=0
tree: 0 dirty entries
```

No `INERT`, no `NOT-APPLIED`, no `PRE-DIRTY`, no `TREE-NOT-CLEAN`. The implementer's table is
accurate. Note all four share ONE mutation (the raw sort) — each named test failed on its own
behaviour, which is what the outcome certifies.

## Environment — the `@fontsource/inter` stub: the suite is **NOT reproducible from a clean checkout in this container**, but the result is **not an artifact of the stub**

```
$ cat node_modules/@fontsource/inter/package.json
{"name":"@fontsource/inter","version":"0.0.0-local-stub"}
$ cat node_modules/@fontsource/inter/400.css
/* local test stub -- registry 403 through the session proxy */
```

Moving it aside breaks the suite outright:

```
$ mv node_modules/@fontsource /tmp/.../fontsource-stash && bun scripts/standup-ranking.test.ts
error: Cannot find module '@fontsource/inter/400.css' from '.../src/features/huddle/data/agents.ts'
```

(restored immediately; `ls node_modules/@fontsource/inter` → `400.css 500.css 600.css 700.css package.json`).

So **yes, this is a finding**: `git status --porcelain` is empty and `node_modules` is gitignored
(`.gitignore:10`), so the stub is invisible to review and vanishes on any fresh clone. Whoever runs
this next in this container without it gets a module-not-found, not a red test.

**But the stub cannot have produced the passing result**, on three independent grounds:
1. `@fontsource/inter: ^5.2.8` is a **declared dependency** (`package.json:24`). On a machine with a
   working registry, `bun install` yields the real package and the suite runs unchanged. The stub
   substitutes for a broken proxy, not for a missing dependency.
2. Its entire content is four CSS files and a `package.json`. It is imported for side effect by
   `agents.ts`; nothing on the ranking path reads it.
3. I reconstructed the OLD ordering in a standalone script that imports **nothing from this repo**
   (`scratchpad/old-sort.ts`) and reached the same conclusion — parked task at index 0.

## Environment — the "one pre-existing `TS2688 vite/client`" claim — **REFUTED as stated; the substantive half CONFIRMED**

```
$ npx tsc --noEmit 2>&1 > tsc.txt
TOTAL ERRORS: 408
=== TS2688 present? ===
0
=== errors in files this change touched ===
(none)
=== error-code histogram ===
    308 error TS7006
     49 error TS2339
     27 error TS2307
     12 error TS7053
      4 error TS2322
```

The tree does **not** report one error; it reports **408**, and `TS2688` is not among them —
`node_modules/vite/client.d.ts` now exists, so the environment has shifted since the implementer
measured. The IMPL doc's "`npx tsc --noEmit` reports **one** error" is therefore wrong as written and
should not be relied on by the next reader.

What survives, and is what actually matters: **zero errors in any file this change touched**
(`standup.server.ts`, `scoring.ts`, `tools.ts`, `standup-ranking.test.ts`). Since `tsc` reports
per-file and the branch modifies exactly one source file, the change introduces no type error. The
408 are pre-existing implicit-`any`s in untouched `.tsx` components plus 27 `TS2307` module-not-found
from the same failed install.

---

# FINDING 2 (gap in the guard) — the blocked-task filter makes the two surfaces diverge, and the test can never see it

`selectStandupPriorities` drops blocker-flagged tasks before ranking. `dispatchPrioritize` does not:

```
$ sed -n '225,246p' src/features/huddle/lib/tasks/tools.ts
    const tasks = await getTasksForUser(userEmail, category);
    const inView = tasks.filter((t) => { switch (view) { ... default: return true; } });
    const ranked = rankTasks(inView, limit);
```

`getTasksForUser`'s SQL excludes `status IN ('DONE','BLOCKED')`, but a `task_blockers` row is a
**separate table** — a task can carry a blocker without `status = 'BLOCKED'`. Whenever one does, the
stand-up drops it and `prioritize` still ranks it, so the two lists differ. AC-SU-3 requires them to
be "identical and in the same order".

The guard cannot catch this: the test passes `const noBlockers = new Set<string>()`
(`standup-ranking.test.ts:56`), so the branch with a non-empty blocker set is never executed.

**Is filtering before ranking correct?** Yes, and it should stay: filtering *after* would let blocked
items consume slots in the top-5 and return fewer than five actionable priorities on a blocked board.
The defect is not the ordering of the filter — it is that a **deliberate, unguarded cross-surface
divergence** is now baked in with no test and no note.

**Smallest change that would fix it:** add one fixture task carrying a blocker id, assert the
stand-up drops it, and assert explicitly that `prioritize` still lists it — turning the divergence
from an untested accident into a documented, guarded choice. (Or, if the two are meant to agree,
apply the same blocker filter in `dispatchPrioritize`.)

# FINDING 3 (minor) — the wiring inside `runScheduledStandup` is asserted by regex, not executed

The test calls `selectStandupPriorities(FIXTURE, ...)` directly. It never runs `runScheduledStandup`,
so the line that connects the producer to the seam —

```
  const scorable = await getTasksForUser(email);
  const priorities = selectStandupPriorities(scorable, blockers);
```

— is covered only by two source regexes (`standup-ranking.test.ts:92-94`): "calls `rankTasks`
somewhere in the file" and "hand-rolls no `priority_rank` sort". Someone could reroute `priorities`
to a different producer, or drop the `selectStandupPriorities` call entirely, and both regexes would
still pass. The mutation proof is real but it mutates *inside* the seam, so it does not close this.
