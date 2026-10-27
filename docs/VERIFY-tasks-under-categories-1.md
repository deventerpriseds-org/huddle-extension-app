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

### V-8 — LIVE DOM at 390×844, against the deployed SWA. **23/23 PASS**

`verify-uat.yml` run **38767143745**, head `0c3358d` of `verify/category-tree-uat-1792080280`,
`APP_URL=https://icy-flower-0f415200f.7.azurestaticapps.net`, viewport **390×844**, surface =
the **Priorities** bottom tab (`PrioritiesView` → `LivePrioritiesWidget full`). Raw `results.json`
off the `uat-shots` orphan branch.

> **Three earlier runs had to be discarded, and WHY matters more than the result.** Runs
> `38765949907` and `38766417095` both reported "the tree does not render" — and both were WRONG.
> The tell was that all three screenshots of each run came back **byte-identical** (63907 and
> 63835 bytes): the navigation click never landed (the `<aside>` is in the DOM but off-canvas at
> 390px, and a `.catch(() => {})` swallowed the Playwright timeout), so the checks ran against the
> chat screen. A fourth defect was in my own row classifier — see V-9. **A verifier reporting a
> feature absent because its own harness never got there is the single worst failure available to
> it; it is recorded here rather than quietly fixed.**

| id | criterion | verdict | observed |
|---|---|---|---|
| V-L1 | the tree renders at all | **PASS** | `tree copies mounted=1; roots=4; names=["Life & Personal","Career","Ventures","Education"]` |
| V-L2 | top level is CATEGORY rows | **PASS** | `["Life & Personal(12)","Career(10)","Ventures(56)","Education(5)"]` |
| V-L3 | Uncategorised sorts last | **PASS (vacuous live)** | `order = Life & Personal > Career > Ventures > Education` — no Uncategorised row, because the live data has none (see V-10) |
| V-L4 | every category row EXPANDABLE | **PASS** | all four `disabled:false`, `aria-expanded` present — the dead unclickable count is gone |
| V-L5 | exactly ONE root starts open | **PASS** | `expanded = ["Life & Personal"]` |
| **V-L6** | **AC-6 / AC-10: rendered rows == count badge** | **PASS** | `12/12, 10/10, 56/56, 5/5` — **exact on all four**, 83 rows |
| V-L7 | AC-10: no "+N more" | **PASS** | `matches = 0` |
| V-L8 | no DONE task rendered | **PASS** | `struck: 0` in every category |
| V-L9 | every task row has a title | **PASS** | `83 task rows total; empties=0` |
| V-L10 | nothing unaccounted under a category | **PASS** | `unaccounted: 0` ×4 |
| **V-L11** | **claim 6: the journey `reason` is still surfaced** | **PASS** | `banner nodes = 1` — the "Sub-themes within each category aren't available yet" sentence renders BESIDE a populated tree |
| V-L12 | cross-surface duplicate | **PASS** | `band rows=22; band titles also in the tree=22` |
| V-L12b | duplicates carry the star | **PASS** | `starred tree rows=22 vs band rows=22` |
| V-L14 | no horizontal overflow at 390 | **PASS** | `scrollWidth=390 clientWidth=390` |
| V-L15 | 44px touch targets, task rows | **PASS** | `36 boxes sampled; under 44px high = 0` |
| V-L16 | 44px tap target, category rows | **PASS** | all four `h: 44` |
| V-L17 | **REGRESSION** This Week band renders | **PASS** | `22 band rows` |
| V-L18 | **REGRESSION** band ▲/▼ still present | **PASS** | `Move up/down buttons = 44` (22 rows × 2) |
| V-L19 | **REGRESSION** Today controls present | **PASS** | `Today buttons = 105` (22 band + 83 tree) |
| — | console / page errors | **PASS** | `""` — **no React duplicate-key warning**, which is AC-34's observation method |
| — | failed / 4xx / 5xx requests | **PASS** | `[]` |

**This settles the headline claims that offline work could not:**
- **CLAIM 2 — CONFIRMED LIVE.** The badge equals the rendered task rows exactly, on all four
  categories, 83 rows. AC-6 and AC-journey-widgets AC-10 both **PASS**.
- **CLAIM 6 — CONFIRMED LIVE.** `{...topics, roots: merge(...)}` spreads first and overrides only
  `roots`, so `ok`/`reason` survive; the UI renders `TopicsEmpty` whenever `reason !== "ok"` even
  with a non-empty tree, and run 38767143745 found that banner on screen. The undeployed
  `get_task_topics` remains diagnosable.
- **CLAIM 8 — CONFIRMED LIVE for the band.** 22 rows, 44 reorder buttons, Today controls, zero
  console errors, zero failed requests.
- **The feature does what it was built for.** The tree had **never populated in production**
  (`reason:"tool-absent"` → empty). It now carries 83 live tasks under 4 categories.

### V-9 — a FALSE RED I produced, and how it was caught (recorded, not hidden)

Run `38766826631` reported V-L6 FAILING — `12→10, 10→6, 56→41, 5→4` — and V-L10 reporting
`2, 4, 15, 1` rows "unaccounted". **Those two shortfalls are the same numbers: 2+4+15+1 = 22, and
22 is exactly the This Week band size.** `TopicTaskRow` renders a lucide `<Star>` **SVG** before
the title when `row.isPriority`, so a starred row's `firstElementChild` is an `SVG`, and my
classifier keyed on `=== "SPAN"`. **The app was right; my check was wrong.** Fixed to classify on a
direct-child `span[title]`, and the corrected run returns `12/12, 10/10, 56/56, 5/5`. The
arithmetic coincidence is what exposed it — had the band been empty, the bad classifier would have
passed and nobody would have known it was broken.

### V-10 — AC-37 reconciliation against the REAL mirror: **R === T, exactly**

The Huddle PG connector returned "needs you to sign in again", so per the org rule a dead connector
is a detour, not a blocker: routed through `azure-pg-query.yml` instead (runs `38767541608`,
`38767685374`, `38767906188`). First finding: the mirror holds **one** user and it is **not** the
email in the brief —

```
          em          | rows_all | live_rows
 dev@enterpriseds.io  |      366 |        98
```

(`von.ellis@enterpriseds.io` returns 0 rows; the UAT identity resolves onto the `dev@` alias through
`resolveScopeByEmail`. Worth knowing before anyone else writes a query against this mirror.)

Then, applying Huddle's OWN liveness rule in SQL (`completed_at IS NULL`, `status <> 'DONE'`, no
case-insensitive `parking-lot` tag) and Huddle's own category folding (`PERSONAL→LIFE`,
`PROF_EDUCATION→EDUCATION`):

| display category | DB live_tasks | **DOM badge** | **DOM rendered rows** | DB in_band | DB blocked |
|---|---|---|---|---|---|
| LIFE | **12** | 12 | 12 | 2 | 0 |
| CAREER | **10** | 10 | 10 | 4 | 1 |
| VENTURES | **56** | 56 | 56 | 15 | 0 |
| EDUCATION | **5** | 5 | 5 | 1 | 1 |
| **TOTAL LIVE UNPARKED** | **83** | — | **83 task rows** | **22** | **2** |
| (parked, live) | 15 | — | **0 rendered** | — | — |

**`R === T` with R = T = 83.** AC-37 — *"the single most likely wrong-but-running outcome of this
feature"* — **PASSES on the owner's real data**, not on a fixture.

- **CLAIM 1 — CONFIRMED ON REAL DATA.** 83 live unparked tasks in the mirror, 83 rendered, each
  under the category its own column names, none twice. The 15 parked live rows are correctly absent.
  The **2 BLOCKED rows are present** (they are inside the 83) — Huddle's `isOpen` rule, not
  journey's.
- **CLAIM 8 band figure cross-checks too:** DB `in_band = 22` (`is_priority OR priority_rank`),
  DOM band = 22 rows, DOM starred tree rows = 22.
- **No Uncategorised row appears live because no live task lacks a category** (0 of 83). The
  bucket is proven by fixture and mutation (M1 FIRED), not by the live board.
- Screenshot `01-priorities-view.png` (desktop run) shows it: `Life & Personal  12` expanded, star
  on `Get a haircut` and `Go to church`, `Get a haircut` also in the This Week band above, and the
  honest sub-themes banner across the bottom.

### V-11 — **D-1 is NOT theoretical: the tie exists on the owner's live board right now**

The non-total comparator (D-1) needs two live tasks identical on `is_priority`, `priority_rank`,
`due_date` AND `title`. I asked the mirror whether any such pair exists:

```
                     title                      | n | distinct_sort_keys
------------------------------------------------+---+--------------------
 Prepare my office camera quality               | 2 |                  1
 Research someone to install brakes and rotors  | 2 |                  1
```

Two pairs, each with **`distinct_sort_keys = 1`** — i.e. both rows of each pair agree on every key
`byPriorityThenDue` looks at, and on the title. `byPriorityThenDue` returns `0` for them, so their
rendered order is whatever `getBoardTasks`' `ORDER BY t.updated_at DESC` produced, and **it flips
whenever either row is touched** — with no change the user made. `Prepare my office camera quality`
is visible in the desktop screenshot, in the Life & Personal list.

**So D-1 is a live defect on the owner's board, not a hypothetical.** It is one clause to fix:

```ts
// widgets.server.ts:331 — byPriorityThenDue
-  return a.title.localeCompare(b.title);
+  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
```

It is a one-line change to a PRE-EXISTING comparator shared with the This Week band, so it is the
owner's call whether it ships here or on its own — but the claim "deterministic, a pure function of
the data" is false until it does.

### V-12 — two further findings from reading, now confirmed against the live DOM

**D-4 — `count` and the rendered rows agree TODAY, but the invariant is narrower than claim 2.**
A node's `count` is its OWN `tasks.length`. Live, journey supplies no topics, so every category's
only descendants are its own tasks and badge == rows exactly (V-L6). **The moment `get_task_topics`
is deployed**, a category will carry topic children whose tasks journey does not send
(`toTopicNode` sets `tasks: []`) while those children DO carry a journey `count` — so a topic row
will render a count of e.g. 7 with zero rows beneath it, which is precisely the
`PrioritiesWidgetFactory.grpTaskCount` defect the commit message says it avoids. **Not a defect
today; a landmine for the next change.** AC-6's stronger "N distinct task ids beneath a row
showing N" does not hold for a journey-supplied topic node.

**D-6 — the ACs' own observation hooks do not exist.** AC-4, AC-5, AC-6 and AC-34 all specify
`li[data-task-id]` / `li[data-topic-id]`. `grep -n "data-task-id\|data-topic-id\|data-testid"` over
`JourneyWidgets.tsx` → **zero hits.** My checks had to classify rows structurally
(`li > div > button > span[title]` vs `li > span[title]`), and that is exactly how I produced the
false RED in V-9. Two attributes would make every future DOM assertion about this widget direct and
unbreakable. **Recommended, cheap, and it is the AC file's own stated method.**

**CLAIM 7 — CONFIRMED.** `grep -n "updateWidgetTask(\|invokeJourneyTool(" JourneyWidgets.tsx`
returns **exactly one line**: `222: const r = await updateWidgetTask(...)`, inside `runAction`.
Zero `invokeJourneyTool` calls in the component. `TopicTaskRow` renders `TodayButton` / `DoneButton`
/ `PauseButton` verbatim — the same components the band uses — and `runAction` self-seeds an
untracked row before setting `busy`, so the double-tap guard works for a tree row that the band
never seeded. **No second write path was introduced.** Live-confirmed in shape: 105 Today buttons
= 22 band + 83 tree, all the same component.

**One honest caveat on CLAIM 7, and on AC-66/67:** `useSeededRows(data.band, live)` seeds **only
the band rows**. A tree-only task enters the store lazily, via `runAction`'s self-seed, and is
therefore never covered by the `refreshChecklistRows` live refresh on later payloads. Harmless for
done/park (the row leaves the tree), but a tree-only `today`/`untoday` overlay is not refreshed
from the server again. Mechanism read from source; **not exercised**, because exercising it means
writing to the owner's real board (see below).

---

## The eight claims — verdicts

| # | claim | verdict | the evidence that settles it |
|---|---|---|---|
| 1 | every live (not DONE, not completed, not parked) task reaches the tree exactly once, under the right category; BLOCKED kept | **CONFIRMED** | 400-row fixture: 210 expected / 210 got / 210 distinct / 0 misplacements (V-2). **And on the real board: DB 83 live unparked == 83 rendered rows, per-category exact, 15 parked excluded, 2 BLOCKED present** (V-10) |
| 2 | `count` can never disagree with the rows beneath it | **CONFIRMED as stated** | every node of a 400-row tree (V-2 I-1f); mutation M2 FIRED; **live: 12/12, 10/10, 56/56, 5/5** (V-L6) — but see **D-4** for the post-`get_task_topics` case |
| 3 | null/blank category → an "Uncategorised" row that sorts last | **CONFIRMED (fixture + mutation)** | null, `""` and `"   "` all bucket; sorts after known AND dynamic categories; M1 FIRED. **Not live-observed — 0 of 83 live tasks lack a category** |
| 4 | `mergeTopicTree` loses nothing and does not mutate its inputs | **HALF DISPROVED** | loses nothing: CONFIRMED (9/9 nodes, M5 + M7 FIRED). **Mutates inputs: DISPROVED — grandchild arrays are sorted in place (D-2)**; the implementer's own assertion checks only a length on the one level that IS copied |
| 5 | ordering is deterministic and a pure function of the data, not of row arrival order | **DISPROVED** | true for rows with distinct keys (50 shuffles → 1 order). **False on ties: 6 permutations → 6 orders (D-1), and two such pairs exist on the live board right now (V-11)** |
| 6 | `topics.ok` / `topics.reason` still report the JOURNEY passthrough, and the UI surfaces it when the tree is non-empty | **CONFIRMED** | `{...topics, roots: …}` overrides only `roots`; `reason !== "ok"` gates `TopicsEmpty` inside the non-empty branch. **Live: the "Sub-themes … aren't available yet" banner is on screen beside a 4-category, 83-row tree** (V-L11, and visible in the screenshot) |
| 7 | no second write path | **CONFIRMED** | exactly ONE `updateWidgetTask(` in the component (line 222, inside `runAction`); zero `invokeJourneyTool(`; buttons reused verbatim. Caveat on seeding in V-12 |
| 8 | nothing regressed in This Week, its controls, or topic-tree parsing | **CONFIRMED** | 11 suites green (V-6), `tsc` 0, build 0. **Live: 22 band rows, 44 ▲/▼ buttons, 105 Today buttons, 0 console errors, 0 failed requests**, at BOTH 390×844 and 1440×900 |

## The adversarial angles in the brief — each one settled

| angle | verdict |
|---|---|
| consts declared BELOW their user — TDZ in the built bundle? | **NO PROBLEM. Executed**, not reasoned: the bundler emits `var` at byte 25202, the use is at 24385, and `node` running the built chunk returns the correct tree (V-4) |
| did a VALUE import of a server module leak into the client? | **NO.** 0 hits for every new symbol across 58 client files; **the `widgets.server` client chunk is byte-identical (md5 `973e7911…`) on base and branch** (V-3). Nothing was missed |
| render cap of 8 / "+N more" — true total? every task reachable? | **The cap is GONE** (`ac43446`, after AC-journey-widgets AC-10 forbade it by name). Live: no `+N more` anywhere, and **all 56 Ventures rows render** (V-L7, V-L6) |
| `useState` in `TopicRow` — does expansion leak between the two mounted copies? | **NO — but only partly observed.** `showAllTasks` no longer exists; `open` is plain local `useState` with no store involvement (grep-proven). Live run had **one** copy mounted, so the two-copy case was **not** observed (V-L13) |
| band + tree duplicate — does acting in one update the other? | **Duplicate confirmed live: 22 band rows, all 22 present in the tree, all 22 starred** (V-L12/12b). Both go through `useRowState` keyed on `row.id`, so propagation is mechanical — **but NOT exercised**, because it needs a write to a real task |
| can an EMPTY category row appear? | **NO from the mirror** — a category exists only because live tasks are in it; all-DONE → `tree.length=0` (V-2 I-2). A journey topic root for an empty category still creates one, by design |
| can `displayCategory` folding produce two rows with the same id? | **NO.** The fold happens before a `Map` key, so `PERSONAL`/`LIFE` and `PROF_EDUCATION`/`EDUCATION` collapse to one node; 7 roots / 7 distinct ids over 400 rows; `mergeTopicTree` folds a duplicate journey `category:` id into one row (I-5a). Two notes: a journey root whose id is a **bare duplicate** does pass through twice (I-5c), and a task whose category string is literally `"UNCATEGORISED"` is indistinguishable from the null bucket (I-6) — neither is reachable today |

## Open defects, in priority order

| id | severity | what | fix |
|---|---|---|---|
| **D-1** | **HIGH — live on the owner's board** | `byPriorityThenDue` is not a total order; two real task pairs tie on every key, so their order follows `updated_at DESC` and flips on any touch. Breaks the determinism the feature is sold on | one clause: `|| a.id.localeCompare(b.id)` |
| **D-2** | MEDIUM — latent | `mergeTopicTree` sorts the caller's grandchild arrays in place; its "does not mutate" test is a false positive | deep-copy in the merge, or make `sortNodes` non-mutating; and widen the assertion to depth ≥ 2 |
| **D-5** | MEDIUM — test quality | the "Uncategorised sorts last" assertion is **INERT** (its `SIDE_HUSTLE` fixture cannot see the `+ 1` disappear). AC-65 requires FIRED | change the fixture's dynamic category to one whose LABEL sorts after "Uncategorised" (`ZZ_TOP` makes it FIRE) |
| **D-4** | MEDIUM — landmine | once `get_task_topics` deploys, topic rows will show a journey `count` with zero rows beneath — the exact Android defect the commit claims to avoid | decide now: derive topic counts too, or render `count: null` for a node whose tasks were not supplied |
| **D-6** | LOW — testability | no `data-task-id` / `data-topic-id`, which AC-4/5/6/34 name as their observation method; it caused a false RED in this very pass | add the two attributes |
| **D-3** | DECISION, not a bug | AC-13 (HIGH not below MEDIUM) and AC-14 (the exact comparator that ignores `priority`) **contradict each other**. As built, an URGENT task can be returned second to an agent asked "what's next in Career?" | withdraw AC-13, or add `priority` to the comparator — which changes This Week's order too |
| — | HOUSEKEEPING | `scripts/_verify-cat-tree-independent.test.ts` (my throwaway) was committed in `ac43446` and is **permanently RED** (3 failures = D-1/D-2/D-3) | give it a `test:` script and treat it as the open-defect tracker, or delete it when they close |

## ACs that are OUT-OF-SCOPE (untouched), not failed

The owner deferred category-level drag. These were written for the larger scope and **this change
does not attempt them** — reporting them as failures would misattribute a deliberate deferral:

- **Drag, every level:** AC-17, 18, 19, 20, 21, 42. `grep -n "onDrag|draggable|dataTransfer|onDrop"`
  on `JourneyWidgets.tsx` still returns **0 hits**, exactly as the AC file's F-7 recorded before the
  work started. The ▲/▼ buttons are untouched and still work (V-L18: 44 of them live).
- **Persisted cross-level ordering:** AC-22, 23, 24, 25, 26, 27, 49, 50, 51, 52, 53, 54. No new
  store, no new write, no migration — so none of these is exercised. `week_order` is read by
  `getWeekOrder`/`applyWeekOrder` unchanged (`test:week-order` 9/9).
- **A new journey tool / topic source:** AC-10, 31, 35, 36, 36b, 40. The source decision was to use
  the mirror and add **no** journey call, so these do not apply. AC-45's ≤2 journey round-trips is
  satisfied trivially: the count is **1** and unchanged.
- **`nextInCategory` as one shared function for UI and agent:** AC-15, 16, 68. Not built. The data is
  now in the payload in rendered order, which is the precondition — the shared accessor is not.
- **Empty FAMILY row:** AC-41. Partly addressed in the opposite direction — a category now exists
  because TASKS are in it, so FAMILY appears when it has work and is absent when it has none. The
  live board has no FAMILY tasks and **no FAMILY row rendered**, which is NOT the Android behaviour
  AC-41 asked for. **Call this OPEN, not passed**: G-5 in the AC file flagged it as needing the
  owner's confirmation and it has not been settled.

## What NO harness in this pass can settle — MECHANISM-ONLY, and why

1. **AC-67 — acting on a task in the tree updating its This Week copy without a refetch.** Both rows
   read `useRowState(row.id)`, so it is mechanical; proving it requires **clicking ✓ on a real task
   on the owner's live board**. I did not, and my checks module is read-only by construction.
   *Vehicle:* seed a `Test-` task in journey (`wwxgajrtmslzklnyplah`), wait out the 1–3 s `pg_net`
   mirror lag, drive the click, then delete by marker. **No `Test-` task was created in this pass,
   so there is nothing to clean up.**
2. **AC-62 — expansion state across two mounted copies.** Needs a surface carrying BOTH a frozen
   in-chat snapshot card and the docked widget. The Priorities tab mounts one (`mounted copies = 1`).
   *Vehicle:* a UAT check that first posts a message rendering a priorities snapshot card, then
   opens the dock in the same huddle.
3. **Real drag on a phone.** Not built, and per this repo's own rule a synthetic pointer sequence
   would be a smoke test, never proof. *Verdict belongs to the owner, on his device.*
4. **AC-24 — order surviving a Monday grooming pass.** No new order store exists, so there is
   nothing to survive; if one is added, `run-grooming.yml` + an `azure-pg-query.yml` read is the
   vehicle.
5. **AC-47 — absolute timing / payload size on the live server.** Not instrumented. The payload now
   carries 83 task rows it did not before; nobody has measured the serialized size or the server
   time. *Vehicle:* a timed server-fn call logging `JSON.stringify(payload).length`.

## Verdict

**CONFIRMED: claims 1, 2, 3, 6, 7, 8.  DISPROVED: claim 5.  HALF DISPROVED: claim 4.**

The feature does the thing it was built to do, and that is established on the owner's real data and
his real screen, not on a fixture: a tree that had **never populated in production** now renders
**83 live tasks across 4 categories**, count badges that match the rendered rows exactly at both
390×844 and 1440×900, no truncation, the This Week band and all its controls intact, and zero
console errors or failed requests.

**It should not be called finished while D-1 stands.** The owner's stated payoff — *"so if an agent
in the future is asked to autopull one or two FROM THE CATEGORIES it knows whats next"* — rests on a
deterministic order, and two real task pairs on his board are ordered by `updated_at`, not by the
data. One clause fixes it.

