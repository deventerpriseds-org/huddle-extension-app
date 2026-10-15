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

