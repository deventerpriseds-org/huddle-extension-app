<!--
WHAT:       Independent verification of commit 9252a1b (PR #66, branch
            claude/eds-skills-chat-widget-ep1joo) — "render each category's tasks in the
            priorities tree, from the mirror" — against docs/AC-tasks-under-categories.md.
WHY:        The implementing agent made 8 claims. This file records what was EXECUTED to
            prove or disprove each, with commands and raw output. No context was shared
            with the implementer.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   every verdict below names the command and quotes its output.
-->

# VERIFY — tasks under categories (loop 1)

Verifier: independent subagent, no shared context with the implementer.
Target: `9252a1b` on `claude/eds-skills-chat-widget-ep1joo`, base `9d874f8`.
Written incrementally — each verdict appended the moment it was reached.

## Scope note, read first

`docs/AC-tasks-under-categories.md` has 69 criteria written for a LARGER scope: drag-and-drop at
task / topic / category level, and persisted cross-level ordering. The implementer built the
**render + source** half only; the owner deferred category-level drag ("that can be done later").
Those ACs are marked **OUT-OF-SCOPE (untouched)** below, not FAIL. A section at the end lists them
explicitly so nothing is silently counted as passing.

---

## Evidence log

### V-0 — deploy state, verified first because it bounds every live claim

```
$ git fetch origin && git log --oneline -1 origin/main
10c9d86 Priority check: Iris asks "are these still right?" at 6am and 8pm, with Send now in Settings (#65)
$ git merge-base --is-ancestor 9252a1b origin/main && echo YES || echo NO
NO
$ git log --oneline -1
1bead4d ledgers: ACT:category-tasks — ...
$ git diff --stat 9252a1b..HEAD
 .claude/actions.md | 44 +++++
 .claude/memory.md  | 27 +++
```

**OBSERVED:** `9252a1b` is NOT in `origin/main`. The code diff between `9252a1b` and the branch
head `1bead4d` is ledgers only — so verifying `9252a1b`'s code is verifying `1bead4d`'s code.
**Consequence: every DOM / live-data criterion is BLOCKED-ON-DEPLOY, not FAIL.** No
`verify-uat.yml` run was dispatched; one would have exercised the previous build and burned the
single-use `?uat_token=`.

**Integration note (not a defect):** `origin/main` has moved on by one commit (PR #65) that this
branch does not have. `git rev-list --left-right --count origin/main...HEAD` → `1  3`, i.e. DIVERGED
— so per this repo's own rule `reset --hard` must not be used here. A trial merge:

```
$ git merge-tree --write-tree origin/main HEAD
CONFLICT (content): Merge conflict in .claude/actions.md
Auto-merging .claude/memory.md
Auto-merging package.json
```

One conflict, in a LEDGER file only. PR #65 touched no file this branch touches except
`.claude/*` and `package.json` (which auto-merges — different `scripts` lines). No source conflict.

---

### V-1 — the implementer's own suite, and every neighbouring suite, re-run from scratch

```
$ npm run test:category-tree
  … 15 PASS lines …
  ==================== 15 passed, 0 failed ====================
```

| suite | result |
|---|---|
| `test:category-tree` | **15 passed, 0 failed** |
| `test:widget-topics` | 20 passed, 0 failed |
| `test:widget-park` | 10 passed, 0 failed |
| `test:widget-live` | 12 passed, 0 failed |
| `test:widget-colors` | 25 passed, 0 failed |
| `test:widget-band-color` | 21 passed, 0 failed |
| `test:week-order` | 9 passed, 0 failed |
| `test:priority-lane` | 9 passed, 0 failed |
| `test:schedule-brief` | 21 passed, 0 failed |
| `test:router` | **20** passed, 0 failed |

```
$ npx tsc --noEmit ; echo EXIT=$?
EXIT=0        (16.8s, zero diagnostics)
```

**AC-64 — PASS with one correction to the AC itself.** `tsc --noEmit` exits 0 and every suite is
green. AC-64 asks for `test:router` to report **9/9**; it reports **20/20**. `scripts/router-winners.test.ts`
is NOT in this diff, so 20 is the pre-existing figure and the AC's "9/9" is a stale number in the
AC, not a regression in this change.

**A passing suite written by the implementer is not evidence on its own** — the mutation proofs in
V-6 are what establish those 15 assertions are load-bearing.

### V-2 — my own adversarial suite (NOT the implementer's), executed

Written without using `scripts/category-tree.test.ts` as a template; run as
`bun scripts/_verify-cat-tree-independent.test.ts` (throwaway, deleted after this pass).
**22 passed, 3 FAILED.** Raw output of the three failures is quoted verbatim below; the 22 passes
are summarised.

#### Passed, with the measurement

| id | what was executed | observed |
|---|---|---|
| I-1a | 400 pseudo-random rows across 13 category spellings and 11 statuses; expected set computed INDEPENDENTLY as `rows.filter(isOpen && !isParked)` | `expected 210 live of 400, got 210; missing=[] extra=[]` |
| I-1b | exactly-once | `210 placements, 210 distinct` |
| I-1c/d | leakage | `148 closed rows, 0 present`; `57 parked rows, 0 present` (incl. odd-cased `Parking-Lot`) |
| I-1e | BLOCKED kept | `28 blocked live rows, all present` |
| I-1f | count integrity on EVERY node | `7 category nodes all agree` |
| I-1g | right category, independently recomputed from each task's own column | `0 misplacements over 400 rows` |
| I-1h | case folding | `'career'`→CAREER, `'Family'`→FAMILY, one node each |
| I-1i | id collisions | `7 roots, 7 distinct ids: [category:LIFE category:CAREER category:VENTURES category:EDUCATION category:FAMILY category:SIDE_HUSTLE category:UNCATEGORISED]` |
| I-1j | Uncategorised last | `LIFE > CAREER > VENTURES > EDUCATION > FAMILY > SIDE_HUSTLE > UNCATEGORISED` |
| I-2 | all-DONE category | `tree.length=0` — **no empty category row can appear from the mirror** |
| I-3a | 50 shuffles, distinct keys | `1 distinct result; canonical=[b,a,f,d,c,e]` |
| I-4a | merge conservation, 9 nodes both sides | `missing=[]` |
| I-4c | merged root ids | `5 roots, 5 distinct` |
| I-4g | merge twice | `1589 bytes both times` — byte-identical |
| I-5a | two journey roots with the same `category:` id | fold into **1** row, children `[x1,x2]` |
| I-5b | journey root colliding with the Uncategorised id | folds in, `1` row, mirror task `u1` kept |

**CLAIM 1 — CONFIRMED.** Every live, unparked task reaches the tree exactly once, under the
category its own `category` column names; BLOCKED is kept (28 rows).
**CLAIM 2 — CONFIRMED** for the invariant as stated (`count === tasks.length` on every node).
See D-4 below for the one case where `count` can still disagree with the rows a USER sees.
**CLAIM 3 — CONFIRMED.** Null, `""` and `"   "` all land in `category:UNCATEGORISED`, which sorts
after both the five known categories and a dynamic one.

#### D-1 — **DISPROVED (claim 5, and AC-12):** the comparator is NOT total, so ties ARE ordered by row arrival order

```
  FAIL I-3b rows TYING on every key: order is a function of the DATA, not arrival order
    :: 6 distinct orders from 6 permutations: t1,t2,t3 | t3,t2,t1 | t2,t1,t3 | t2,t3,t1 | t3,t1,t2 | t1,t3,t2
```

Three rows with the SAME title, no due date, unstarred, no rank: `byPriorityThenDue`
(widgets.server.ts:320-331) returns `0`, so `Array.prototype.sort` — stable in V8 — emits them in
**input order**, and six input permutations gave **six different rendered orders**.

Why this is reachable, not theoretical: the input order is `getBoardTasks`'s
`ORDER BY t.updated_at DESC LIMIT 500` (tasks.server.ts:1692). So the order of same-titled tasks
**flips whenever either one is touched**, with no data change the user made. Duplicate titles are
documented live behaviour on this very board — `CLAUDE.md`: *"hundreds of `Define MVP scope for new
venture…` rows"* from harnesses writing to the real board.

AC-12 asks for exactly this: *"the comparator is total — no two rows compare equal"*. It is not.
**Fix is one clause**, and it also makes the pure function genuinely pure:
`return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);`

**Severity / attribution:** `byPriorityThenDue` is PRE-EXISTING (used by `buildPrioritiesBand`
too), so this diff did not introduce the non-totality. But this diff is what makes determinism a
load-bearing promise — the commit message sells "a stable answer to 'what's next in Career?'" — and
the implementer's own test `I-3`-equivalent ("the order is a function of the DATA, not of row
arrival order") asserts a property that **does not hold** for tied rows; it only tested one
4-row fixture whose keys all differ.

#### D-2 — **DISPROVED (claim 4):** `mergeTopicTree` DOES mutate its inputs, at depth ≥ 2

```
  FAIL I-4e DEEP: a GRANDCHILD array of the input is NOT re-sorted in place
    :: grandchildren of journeyRoots[0].children[0] were [gz,ga], are now [ga,gz]
```

`mergeTopicTree` copy-on-writes only two levels — `{...n, children:[...n.children]}` — then calls
`sortNodes(out)`, and `sortNodes` (widgets.server.ts:695-704) does `nodes.sort(...)` **and then
recurses** `for (const n of nodes) sortNodes(n.children)`. At depth ≥ 2 the `children` array is the
caller's own array object, so it is sorted **in place**. The input's grandchildren were reordered
`[gz,ga] → [ga,gz]`.

The implementer's test "merging does not MUTATE the inputs" only checks
`journeyRoots[0].children.length === 1` — a LENGTH, which a sort cannot change, on the one level
that IS copied. It passes while the property is false.

**Observable impact today: none.** `topics.roots` is journey's tree, which is `[]` in production
(`reason:"tool-absent"`), and `getPrioritiesWidget` does not read `topics.roots` again after the
merge. So this is a latent defect plus a **false-positive assertion**, not a live bug. Fix: deep-copy
in `mergeTopicTree`, or make `sortNodes` return new arrays.

#### D-3 — AC-13 FAILS, but AC-13 and AC-14 contradict each other

```
  FAIL I-7 AC-13: a HIGH/URGENT task is NOT ranked below a LOW one
    :: order=[low,urgent] — byPriorityThenDue reads is_priority/priority_rank/due_date/title and
       never the `priority` text column, which BoardTaskRow does carry
```

A task with `priority:"URGENT"` titled `"zzz…"` sorts **below** one with `priority:"LOW"` titled
`"aaa…"`. AC-13 demands "HIGH is not below MEDIUM"; AC-14 demands the order be exactly
`is_priority desc, priority_rank asc nulls-last, due_date asc, title asc` — a comparator that by
construction ignores `priority`. **The two ACs cannot both hold.** The implementer satisfied AC-14
(the specific one) and therefore fails AC-13 (the general one).

This is not nothing, because the owner's stated payoff is an agent autopulling "the next one or two"
from a category: as built, an URGENT task can be returned second. `BoardTaskRow.priority` IS
selected by `getBoardTasks` (tasks.server.ts:1682) and IS dropped by `toWidgetRow`
(widgets.server.ts:291-315), so the data is one line away. **Decision for the owner, not a verifier:**
either AC-13 is withdrawn, or `priority` is added to the comparator — which would change the
existing This Week band's order too, so it is not a free change.

---

### V-3 — `npm run build`, and the "did a server module leak into the client bundle?" question

The main working tree had a `git merge origin/main` IN PROGRESS (conflict in `.claude/actions.md`)
while this pass ran, so every build below was done in an **isolated detached worktree** pinned to
the commit under test, to keep the evidence uncontaminated:

```
$ git worktree add --detach <scratch>/wt-1bead4d 1bead4d     # feature
$ git worktree add --detach <scratch>/wt-base    9d874f8     # base, for attribution
$ npm run build   # in each
EXIT=0   (both)
```

#### The adversarial angle, settled: the new symbols are NOT in the client bundle

```
$ grep -rl <symbol> .output/public | wc -l        # 58 client .js files, 5.4M
  buildCategoryTaskTree      0
  mergeTopicTree             0
  UNCATEGORISED_CATEGORY     0
  buildTopicTree             0
  groupByCategory            0
  CATEGORY_ROOT_PREFIX       0
  withParkingLotTag          0
```

`JourneyWidgets.tsx:50-57` imports from `widgets.server` under `import type { … }` only — type-only,
erased at compile. The colour helpers it DOES value-import come from a different module
(`../lib/tasks/widget-colors`), and `CATEGORY_TASK_PREVIEW_MAX` was declared in the component. So
**nothing was missed.**

**The strongest form of that evidence — the content hash is unchanged:**

```
$ md5sum wt-1bead4d/.output/public/assets/widgets.server-DjJWCyWR.js \
         wt-base/.output/public/assets/widgets.server-DjJWCyWR.js
973e7911a3d5374b6b935ca8cad47ff1  wt-1bead4d/…/widgets.server-DjJWCyWR.js
973e7911a3d5374b6b935ca8cad47ff1  wt-base/…/widgets.server-DjJWCyWR.js
```

Same filename, same hash, 2881 bytes, on BOTH commits. **This diff added zero bytes to the client's
copy of `widgets.server`.**

**Pre-existing observation, NOT this diff's doing, reported because I found it:** a client-served
`.output/public/assets/widgets.server-*.js` chunk exists on BOTH commits, reached from
`assets/tools-BvQdWw9X.js` (`lib/tasks/tools.ts` does a dynamic `import("./widgets.server")`). It
exports `safeTimeZone, localDateKey, buildScheduleSections, buildPrioritiesBand` — pure functions,
no `pg`, no connection string. 13 client chunks contain the literal **string** `AZURE_PG_URL` (e.g.
`` `AZURE_PG_URL not configured` ``), i.e. the variable NAME in an error message, not a value; a
`grep -rlE "postgres(ql)?://"` over `.output/public` matched only `esm-DvNGi1wG.js` (a driver's own
regex, not a credential). **No secret leak observed.** Still: server modules being emitted into
`public/` is a shape worth a separate look, and it is older than this change.

---

### V-4 — the declared-below-use question, EXECUTED in the built bundle (not reasoned about)

`UNCATEGORISED_CATEGORY` / `UNCATEGORISED_LABEL` are declared at source line ~918, **below**
`buildCategoryTaskTree` (line ~810) which reads them. What the bundler actually emitted:

```
$ grep -b "UNCATEGORISED" .output/server/_ssr/widgets.server-D24swPAC.mjs
24385 : const cat = raw ? displayCategory(raw) : UNCATEGORISED_CATEGORY;     <- USE
25202 : var UNCATEGORISED_CATEGORY = "UNCATEGORISED";                        <- DECL, 817 bytes LATER
25248 : var UNCATEGORISED_LABEL = "Uncategorised";
```

The use is at byte 24385, the declaration at 25202 — the declaration really is below the use in the
built output, and the bundler **rewrote `const` to `var`**. Executed rather than reasoned about:

```
$ node tdz.mjs .output/server/_ssr/widgets.server-D24swPAC.mjs
exports present: buildCategoryTaskTree=function mergeTopicTree=function
built-bundle result: [{"id":"category:CAREER","name":"Career","pos":1,"count":1,"tasks":["b"]},
                      {"id":"category:UNCATEGORISED","name":"Uncategorised","pos":6,"count":2,"tasks":["a","c"]}]
mergeTopicTree([],tree) roots: category:CAREER,category:UNCATEGORISED
```

**NO TDZ error, correct values, in the BUILT bundle under plain Node.** Reason: the declaration runs
during module evaluation, which completes before any caller can invoke the function. **PASS — the
angle is closed, and it is closed by execution, not by argument.** (One note: because the bundler
emits `var`, a future refactor that called this function *during* module evaluation would get a
silent `undefined` instead of a loud TDZ throw. Not reachable today.)

---

### V-5 — the 15 assertions are load-bearing: 7 independent mutations via `scripts/mutate.sh`

Anchors written to FILES (not shell args), run in the isolated worktree, test command
`bun scripts/category-tree.test.ts` (reads source — no build output to contaminate). Tree verified
clean after all seven (`git status --porcelain` → empty).

| # | defect reinstated | must-fail label | outcome |
|---|---|---|---|
| M1 | `if (!raw) continue` — drop null/blank-category tasks | `a task with a null OR blank category gets a real row` | **FIRED** |
| M2 | `count: tasks.length + 1` — count no longer derived | `count equals the number of tasks actually carried` | **FIRED** |
| M3 | remove `.filter(isOpen && !isParked)` | `DONE, completed and parked tasks are excluded` | **FIRED** |
| M4 | remove `tasks.sort(byPriorityThenDue)` | `the order is a function of the DATA` | **FIRED** |
| M5 | `mergeTopicTree` drops a journey category root the mirror lacks | `a journey category the mirror has no tasks for is still created` | **FIRED** |
| M6 | remove the `+ 1` that forces Uncategorised last | `Uncategorised sorts last` | **INERT** |
| M7 | `mergeTopicTree` drops a bare (uncategorised) journey topic root | `an uncategorised journey topic stays top-level` | **FIRED** |

**6 of 7 FIRED. D-5 — M6 is INERT because the FIXTURE is too weak, and the `+ 1` IS load-bearing.**
I proved that rather than leaving it ambiguous. The implementer's fixture uses `SIDE_HUSTLE`, whose
label `"Side Hustle"` sorts BEFORE `"Uncategorised"`, so when both land on `position = 5` the
`name.localeCompare` tiebreak in `sortNodes` still puts Uncategorised last — the mutation is
behaviourally equivalent *for that one input*. With a dynamic category whose LABEL sorts AFTER it:

```
unmutated:  PASS … :: Zz Top(pos=5) > Uncategorised(pos=6)
mutated  :  FIRED: 'Uncategorised sorts last even behind a dynamic category' failed … The guard is real.
```

So the code is RIGHT and the test is WEAK. **Fix: change the fixture's dynamic category from
`SIDE_HUSTLE` to anything whose label sorts after "Uncategorised"** (e.g. `ZZ_TOP`), and M6 fires.
Per AC-65 ("`FIRED` — never `INERT`"), this one assertion is currently **unproven**.

---

## PART 2 — re-verified against the MERGED, DEPLOYED code (`ca0d7d1`)

Mid-pass the change moved: the row cap was removed (`ac43446`), `origin/main` was merged in, PR #66
merged as `ca0d7d1`, and `deploy-swa.yml` run `38764997134` on `ca0d7d1` completed SUCCESS. So the
BLOCKED-ON-DEPLOY items in Part 1 are now observable, and everything below is against `ca0d7d1`.

```
$ git fetch origin && git log --oneline -1 origin/main
ca0d7d1 feat(widgets): render each category's tasks in the priorities tree (#66)
$ grep -n "CATEGORY_TASK_PREVIEW_MAX\|showAllTasks\|visibleTasks\|hiddenTaskCount" src/.../JourneyWidgets.tsx
  (only two COMMENT lines naming the removed pattern — no code)
```

### V-6 — every suite re-run on `ca0d7d1`, and my 3 disproofs RE-CONFIRMED

```
$ bun scripts/_verify-cat-tree-independent.test.ts
  FAIL I-3b rows TYING on every key … 6 distinct orders from 6 permutations
  FAIL I-4e DEEP: a GRANDCHILD array of the input IS re-sorted in place … [gz,ga] -> [ga,gz]
  FAIL I-7 AC-13: a HIGH/URGENT task IS ranked below a LOW one … order=[low,urgent]
  =========== INDEPENDENT: 22 passed, 3 failed ===========
```

**D-1, D-2 and D-3 all still hold on the merged, deployed code.** None was fixed by `ac43446` or
the merge.

Independent confirmation of the numbers the implementer reported (every one re-run here, not taken
on their word):

| suite | implementer said | I measured |
|---|---|---|
| `test:category-tree` | 17 | **17 passed, 0 failed** |
| `test:widget-topics` | 20 | 20 passed, 0 failed |
| `test:widget-park` | 10 | 10 passed, 0 failed |
| `test:widget-live` | 12 | 12 passed, 0 failed |
| `test:widget-colors` | 25 | 25 passed, 0 failed |
| `test:widget-band-color` | 21 | 21 passed, 0 failed |
| `test:week-order` | 9 | 9 passed, 0 failed |
| `test:priority-lane` | 9 | 9 passed, 0 failed |
| `test:router` | 20 | 20 passed, 0 failed |
| `test:priority-check` (PR #65, merged in) | 20 | 20 passed, 0 failed |
| `test:schedule-brief` | 21 | 21 passed, 0 failed |

All eleven confirmed. `npx tsc --noEmit` → EXIT=0. `npm run build` → EXIT=0.

**A note on the cap-removal commit:** `ac43446` also committed MY throwaway file
`scripts/_verify-cat-tree-independent.test.ts` into the repo. It is a verifier artifact, not a
project suite, and it is **currently RED by design** (3 failures = the 3 open defects). If it stays
in the tree it should either get a `test:` script of its own and be treated as the open-defect
tracker it is, or be deleted once D-1/D-2/D-3 are resolved — a permanently-red file in `scripts/`
is the kind of thing a later session reads as "the suite is broken".

### V-7 — live DOM: vehicle and method

`verify-uat.yml` dispatched against a verifier branch carrying **my own** checks module
(`.claude/skills/test-agent-serverfn/scripts/verify-category-tree-checks.mjs`, branch
`verify/category-tree-uat-1792080280`, commit `9aefe3b`) rather than the default
`huddle-checks.mjs` (which runs the ceremony/barge suite — irrelevant here and expensive).

**The module is READ-ONLY by construction: it never clicks ✓ / ⏸ / Today**, because those write to
the owner's REAL journey board. Expand/collapse is local component state and writes nothing. That
is a deliberate limit on what this pass can settle — see the "not settleable" list at the end.

Method for the count-vs-rows criterion, which is AC-10's own: the count badge beside a category is
`node.count`, which the server derives as `node.tasks.length` (mutation-proved, M2 FIRED above), so
**badge vs rendered task rows IS payload-length vs rendered-`li`** and can be read from the DOM
alone. Rows are told apart structurally — a category/topic row is `li > div > button > span[title]`,
a task row is `li > span[title]` — because **neither carries a `data-*` hook** (see D-6).

