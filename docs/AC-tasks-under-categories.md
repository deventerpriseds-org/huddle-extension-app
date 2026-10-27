<!--
WHAT:       Adversarial acceptance criteria for "tasks rendered under each category/topic, in a
            defined, draggable, persistent order" in the PRIORITIES widget.
WHY:        Owner asked for two things: (1) drag a topic/theme/grouping OR a task to the top of
            This Week, and (2) a deterministic order AT EVERY LEVEL so a future agent can
            auto-pull "the next one or two" from a category. The widget currently renders the
            category/topic tree as names + counts with no tasks underneath, so neither is
            answerable today.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   written cold by an independent AC subagent; "Sources read" below lists exactly what
            was opened. Findings marked OBSERVED were executed/grepped in this pass; findings
            marked INFERRED were not.
-->

# Acceptance Criteria — tasks under categories/topics in the PRIORITIES widget

Task, restated: the PRIORITIES widget must render the **tasks that belong to each category /
topic**, under that category/topic, in a **defined and persistent order**, draggable at the task
level AND at the category/topic level — and that same order must be the answer a future agent
gives to "what's next in Career?".

> **Status of this file: written incrementally.** Each criterion was appended as it was formed.

## Sources read (so far — this list grows as the pass proceeds)

- `src/features/huddle/lib/tasks/widgets.server.ts` (796 lines, read in full)
- `src/features/huddle/lib/tasks/widgets.functions.ts` (376 lines, read in full)

- `src/features/huddle/components/JourneyWidgets.tsx` (lines 1–300, 575–870 read; whole file grepped
  for `onDrag|draggable|dataTransfer|onDrop`)
- `/home/user/journey-voice/supabase/functions/execute-tool/index.ts`
  (`getTasksByTopic` 2162–2229, `swapTaskOrder` 2732, `setPriorityRank` 2753,
  `batchUpdateTasks` ~963–998, the dispatch `switch` 405–460, the `default:` unknown-tool branch 455)
- `/home/user/journey-voice/supabase/functions/_shared/tool-definitions.ts` (grepped for `topic`)
- `/home/user/journey-voice` working tree on `main` — full `grep -rn get_task_topics --include=*.ts`

## Ground-truth findings established BEFORE writing any AC

These change what is testable, so they are stated first. Each is marked OBSERVED (executed or read
this pass) or INFERRED (reasoned, not executed).

**F-1 (OBSERVED, and it invalidates the obvious happy-path AC): `get_task_topics` does not exist
in journey.** `grep -rn "get_task_topics" --include=*.ts .` over the whole `journey-voice` working
tree on `main` returns **zero hits** — not in `execute-tool/index.ts`, not in
`_shared/tool-definitions.ts`, not in `huddle-proxy`. The only topic tool journey registers is
`get_tasks_by_topic` (`tool-definitions.ts:62`). `fetchTopicTree` (widgets.functions.ts) calls
`invokeJourneyTool({toolName:"get_task_topics"})`; `execute-tool`'s `default:` branch returns
`{success:false, error: "Unknown tool: get_task_topics"}` (index.ts:455-459), whose text contains
`"unknown tool"`, which `fetchTopicTree`'s `absent` matcher catches → `reason:"tool-absent"` →
`PrioritiesWidget` renders `TopicsEmpty` with the sentence *"Topic breakdown isn't available yet —
journey hasn't deployed its topic list."*
**Consequence for this AC set: the topic tree is EMPTY IN PRODUCTION TODAY.** Any AC phrased as
"given the Career category is on screen, when the user expands it, then the tasks appear" is
**untestable as written** against the live app — there is no Career row to expand. Every tree AC
below is therefore written against one of: (a) `buildTopicTree`/`groupByCategory` as pure functions
with a fixture payload, or (b) a NEW tree source that this feature must choose and name. **AC-0
forces that choice to be made explicitly rather than inherited.**

**F-2 (OBSERVED): `get_tasks_by_topic` answers "no such topic" when a topic name is DUPLICATED.**
`getTasksByTopic` resolves the topic with
`.eq('user_id',userId).ilike('topic_name',topicName).maybeSingle()` (index.ts:2170-2175) and
destructures **`const { data: topic } = await …` — the `error` is discarded.** PostgREST's
`maybeSingle()` errors when more than one row matches, so with two topics named `Admin` the call
yields `data: null`, and the function returns
`{success:true, result:{tasks:[],count:0}, message:'No topic group found matching "Admin"…'}`.
That is a **silent wrong answer, reported as success** — the worst shape for an agent consumer,
because `success:true` tells the caller to trust `count:0`.

**F-3 (OBSERVED): `get_tasks_by_topic`'s ordering is not deterministic and is not a priority
order.** The task fetch is
`.in('id',taskIds).neq('status','DONE').neq('status','BLOCKED').not('title','ilike','%test%').order('priority',{ascending:false})`
(index.ts:2199-2205). Three separate problems:
  1. It orders by the **`priority` text column, descending** — not by `priority_rank`. Descending
     text on `HIGH|MEDIUM|LOW` sorts `MEDIUM, LOW, HIGH`, i.e. **MEDIUM above HIGH**.
  2. There is **no tiebreak at all**, so rows with equal `priority` come back in whatever order
     Postgres chooses. "What's next in Career?" has no stable answer.
  3. It **excludes `BLOCKED`**, while Huddle's own `isOpen()` (widgets.server.ts:270) deliberately
     keeps BLOCKED ("a blocked item is still live work"). The two surfaces therefore disagree by
     construction, and it also **excludes any title matching `%test%`**, which silently hides a
     legitimate task called e.g. "Test strategy for Q4".

**F-4 (OBSERVED): writing order into `priority_rank` STARS the task.** `setPriorityRank` writes
`{is_priority: true, priority_rank: args.rank ?? null}` (index.ts:2755-2758) and `batchUpdateTasks`
does the same (`if (typeof u.rank === "number") { data.is_priority = true; data.priority_rank = u.rank; }`,
index.ts:~981). `buildPrioritiesBand` (widgets.server.ts) admits any row with
`is_priority === true || priority_rank !== null`. So **ranking a task inside a category would
simultaneously put it in This Week** — which destroys the owner's distinction between "ordered
within Career" and "deliberately dragged up to This Week".

**F-5 (OBSERVED): `swap_task_order` is NOT an ordering tool.** Despite the name it swaps
`start_time`/`end_time` and refuses unless **both tasks are already scheduled**
(`if (!a?.start_time || !b?.start_time) return {success:false, error:'Both tasks must be scheduled'}`,
index.ts:2740). It cannot express "put this one above that one" for unscheduled backlog items.

**F-6 (OBSERVED): the topic tree renders NAMES AND COUNTS ONLY — there is no task level.**
`TopicRow` (JourneyWidgets.tsx:645-717) renders `node.name`, an expand triangle, and `node.count`,
and recurses into `node.children` — which are `TopicNode`s. `TopicNode` (widgets.server.ts) has no
task field at all. **This is the gap the feature exists to close.**

**F-7 (OBSERVED): there is no drag anywhere in the widget, despite a comment claiming there is.**
`grep -n "onDrag|draggable|dataTransfer|onDrop" src/features/huddle/components/JourneyWidgets.tsx`
returns **zero hits**, while the same grep on `BoardView.tsx` returns 10. The comment above
`PriorityRow` (line 587-591) says *"drag is layered on top for mouse users rather than being the only
way in"* — **that is not true of the current source.** Reordering is ▲/▼ buttons only. The owner's
words were "i still need a way to **dray** one row above the other", so this is the literal ask.

**F-8 (OBSERVED): one widget render costs exactly ONE journey round-trip today.**
`getPrioritiesWidget` runs `Promise.all([getBoardTasks(email), getWeekOrder(email), fetchTopicTree(caller)])`
— two Azure PG reads and **one** `invokeJourneyTool`. A naive implementation of this feature
(one `get_tasks_by_topic` per topic) would cost **1 + N journey calls**, and journey's live data is
**158 topics** (measured 2026-09-13, quoted in `groupByCategory`'s comment). AC-20 bounds this.

**F-9 (OBSERVED): `FAMILY` has no topics, so it is the "category with no children" case.**
`groupByCategory` only ever creates a category root when some topic carries that category
(`byCat.get(cat)` on demand), and `TopicRow` renders the expander `disabled` when
`node.children.length === 0`. The `CATEGORY_LABELS`/`DISPLAY_CATEGORY_ORDER` lists include `FAMILY`
but nothing synthesises an empty `FAMILY` root. So today FAMILY **does not appear at all** in
Huddle's tree, whereas the owner's screenshot (per the code comment) shows a Family row with no
count. AC-18/AC-19 pin which of those two is correct.

---

## The criteria

Each item is binary. "Observed via" names the exact thing to look at.

### AC-0 — the source of truth for "tasks under a topic" must be named before anything is built

1. **Given** F-1 (journey exposes no `get_task_topics`, and `get_tasks_by_topic` has the defects in
   F-2/F-3), **when** the implementer opens a PR for this feature, **then** the PR description names
   exactly one of these four sources for the task-under-topic data and states why the other three
   were rejected: (a) journey `task_topic_index` + `task_topic_mappings` read through a NEW journey
   tool, (b) `get_tasks_by_topic` per topic, (c) a topic/category grouping computed in Huddle from
   `tasks.journey_tasks.category` with no journey call at all, (d) a new mirror column.
   **Observed via:** the PR body contains a section headed with the chosen source and three
   rejection sentences. A PR with no such section fails this AC.
2. **Given** the "Extend, don't duplicate" rule, **when** the implementer adds any new store for
   topic→task membership, **then** the PR states in its own text that `task_topic_mappings`
   (journey) and `tasks.journey_tasks.category` (Huddle mirror) were both read and are insufficient,
   naming the specific column that is missing.
   **Observed via:** PR body names `task_topic_mappings` AND `tasks.journey_tasks`; `grep -rn` in
   the diff shows no second topic-membership table unless that justification is present.

### Happy path — tasks actually appear under a topic/category

3. **Given** a topic node that has 3 open, unparked tasks mapped to it, **when** the priorities
   payload is built, **then** that node carries those 3 tasks in a typed field on the node itself
   (e.g. `TopicNode.tasks: WidgetTaskRow[]`) and `node.tasks.map(t => t.id)` equals the 3 expected
   ids in the expected order.
   **Observed via:** a unit test on the pure builder in `widgets.server.ts` asserting
   `JSON.stringify(node.tasks.map(t=>t.id))`. `TopicNode` today has **no** task field (F-6), so
   `tsc` must also compile with the new field present on the exported interface.
4. **Given** that node rendered in `PrioritiesWidget`, **when** the user expands it, **then**
   exactly 3 new list items appear, each containing the task's `title` as text, and each is nested
   inside the topic's `<ul>` — not a sibling of it.
   **Observed via:** DOM — `container.querySelectorAll('li[data-task-id]').length === 3` after the
   expand click, and each node's `closest('li[data-topic-id="<id>"]')` is non-null.
5. **Given** a category root (`id` starting `category:`) with topics beneath it, **when** it is
   expanded, **then** its immediate children are topic rows and **zero** task rows appear at that
   level.
   **Observed via:** DOM — immediate `li` children of the category's `<ul>` all carry
   `data-topic-id` and none carries `data-task-id`.
6. **Given** any topic row that displays a count of `N`, **when** that row is expanded fully
   (itself and every descendant), **then** the number of distinct `data-task-id` values beneath it
   is exactly `N`.
   **Observed via:** DOM count vs. the rendered `row_count` text. **This is the AC that catches the
   design truth's own bug:** `PrioritiesWidgetFactory.rebuildItems` computes
   `grpTaskCount = if (hasSubGroups) subs.sumOf{…} else tasksByTopic[grp.id]?.size` — a group that
   has sub-groups **omits its own directly-mapped tasks from the count**, and never renders them
   either. Huddle must not copy that; the count and the rendered rows must agree.
7. **Given** a category whose descendants hold `M` distinct open unparked tasks (some tasks mapped
   to two topics under the same category), **when** the category count is read, **then** it equals
   `M` — each task counted **once**.
   **Observed via:** unit test with a fixture where task `T1` maps to both `Career/Admin` and
   `Career/Hiring`; assert the `Career` count is `M`, not `M+1`.
8. **Given** a topic with 5 mapped tasks of which one is `status:'DONE'`, one has
   `completed_at` set, and one carries the `parking-lot` tag, **when** the tree is built, **then**
   `node.tasks.length === 2` and none of the three excluded ids is present.
   **Observed via:** unit test asserting the id set. This must reuse the EXISTING
   `isOpen()` + `isParked()` from `widgets.server.ts`, not a new predicate.
   **Observed via (extend-don't-duplicate):** `grep -c "parking-lot" src/features/huddle/lib/tasks/`
   in the diff shows no new literal; the new code imports `isParked`/`isOpen`.
9. **Given** a topic with one `status:'BLOCKED'` task, **when** the tree is built, **then** that
   task's presence matches Huddle's existing `isOpen()` contract — i.e. it **is** present — and the
   PR states in its own text that journey's `get_tasks_by_topic`
   (`.neq('status','BLOCKED')`, F-3) and the Android widget
   (`status=not.in.(DONE,BLOCKED)`, `SupabaseTaskClient.kt:248`) both **exclude** it, and which
   behaviour was chosen.
   **Observed via:** unit test on the id set, plus the PR body naming the divergence. An
   implementation that silently inherits journey's exclusion while the This Week band above keeps
   BLOCKED produces **two different answers for the same task on one screen** — that is the failure
   this AC exists to catch.
10. **Given** journey's `task_topic_index` carries `window_affinity` and a topic whose
    `category_affinity` is NULL but whose `window_affinity[0]` is `CAREER`, **when** the tree is
    built, **then** that topic appears under `Career`.
    **Observed via:** unit test. The Android design truth does exactly this
    (`grp.categoryAffinity ?: grp.windowAffinity?.firstOrNull()`,
    `PrioritiesWidgetFactory.kt:461-463`); Huddle's `groupByCategory` has **no**
    `window_affinity` branch today, so a topic placed on Android would be a top-level orphan row in
    Huddle. If the chosen source does not return `window_affinity`, this AC is satisfied instead by
    the PR stating that and the divergence being accepted in writing.

### Ordering determinism — the half of the ask that an agent depends on

11. **Given** the same input payload twice, **when** the tree is built twice in one process,
    **then** the flattened `[topicId, taskId]` sequence is byte-identical.
    **Observed via:** unit test — `expect(flatten(build(p))).toEqual(flatten(build(p)))`.
12. **Given** a topic whose tasks tie on every sort key used, **when** they are ordered, **then**
    the comparator is **total** — no two rows compare equal — and the order is identical across 50
    randomly shuffled permutations of the same input.
    **Observed via:** unit test looping 50 shuffles and asserting one distinct result; plus
    `rows.every((r,i,a) => i===0 || cmp(a[i-1],r) !== 0)`.
13. **Given** two tasks under one topic with `priority:'MEDIUM'` and `priority:'HIGH'` and no
    `priority_rank`, **when** they are ordered, **then** HIGH is **not** below MEDIUM.
    **Observed via:** unit test. This is the direct mutation of F-3: journey's
    `.order('priority',{ascending:false})` on a text column sorts `MEDIUM, LOW, HIGH`, so an
    implementation that passes journey's order through unchanged **fails this AC**.
    > **RETIRED by owner decision, 2026-10-15 — AC-14 governs.** AC-13 and AC-14 contradict: AC-14
    > orders by the user's star and rank, AC-13 would float a HIGH/URGENT label above them. The owner:
    > *"keep AC-14"*. Reason given to him and accepted: he asked for his own pick to beat the score
    > ("superspeed other items in that category that may have scored higher"), and letting a label
    > override his star reintroduces exactly what he was overriding. So an URGENT task CAN rank below
    > a task he starred or ranked; that is the intended behaviour, not a defect. Asserted by I-7 in
    > `scripts/category-tree-independent.test.ts`.

14. **Given** a topic's tasks, **when** they are ordered, **then** the sequence matches
    `is_priority desc, priority_rank asc nulls-last, due_date asc, title asc` — the existing
    `byPriorityThenDue` in `widgets.server.ts`, which is also what the Android truth asks Postgres
    for (`order=is_priority.desc,priority_rank.asc.nullslast`, `SupabaseTaskClient.kt:248`).
    **Observed via:** unit test on a 6-row fixture exercising each key in turn; and the diff
    contains no second comparator — `grep -n "localeCompare\|sort(" ` in the diff shows the ordering
    goes through `byPriorityThenDue`, not a copy.
15. **Given** the Career category rendered with its tasks, **when** an agent is asked
    "what's next in Career?", **then** the id it names is the id of the **first** task row rendered
    under Career.
    **Observed via:** one exported function (e.g. `nextInCategory(data, 'CAREER', n)`) consumed by
    BOTH the UI render and the agent tool, proven by `grep` showing a single definition and two
    call sites. Two independent orderings that merely "look the same" fail this AC.
16. **Given** a request for "the next two in Career", **when** `nextInCategory(data,'CAREER',2)` is
    called, **then** it returns exactly 2 ids, both drawn from Career's descendants, in the rendered
    order, and returns fewer only when fewer exist (never a padded or fabricated id).
    **Observed via:** unit test, including the `0 available` case returning `[]` — not `null`, not a
    throw.

### Drag — the literal ask, which does not exist today

17. **Given** the priorities widget on a mouse-driven browser, **when** the user presses on a task
    row and drags it above the row before it, **then** the two rows swap and the new order is the
    one rendered after the pointer is released.
    **Observed via:** DOM — a Playwright `dragAndDrop` (or synthetic pointer sequence) followed by
    reading the rendered `data-task-id` order. **F-7 is the baseline:**
    `grep -n "onDrag|draggable|dataTransfer|onDrop" src/features/huddle/components/JourneyWidgets.tsx`
    returns **0 hits today** while the same grep on `BoardView.tsx` returns 10, so this AC starts
    RED. The comment at `JourneyWidgets.tsx:587-591` claiming drag is "layered on top for mouse
    users" is false and must be corrected or made true in the same commit.
18. **Given** the same widget on a touch device, **when** the user uses the ▲/▼ buttons, **then**
    the row still moves and persists exactly as it does today.
    **Observed via:** the existing ▲/▼ path still passing; drag must be ADDITIVE. HTML5 native DnD
    does not fire on touch (the stated reason the buttons exist), so an implementation that replaces
    the buttons with drag fails this AC.
19. **Given** a task row inside the Career category (not in This Week), **when** the user drags it
    onto the This Week band, **then** after the next refetch that task appears in `data.band` and
    journey's row has `is_priority = true`.
    **Observed via:** the band's rendered id list contains the id; and a journey read of
    `public.tasks` for that id shows `is_priority = true`. This is owner ask #1 verbatim —
    *"i should be able to drag a topic theme/grouping or the task itself"*. On Android the same
    gesture is the **star** button (`EXTRA_TYPE="STAR"` → `updateTaskPriority` →
    `{is_priority:true}` only, no rank — `SupabaseTaskClient.kt:261`), so the Huddle write must set
    `is_priority` and **must not** set `priority_rank` (see AC-22).
20. **Given** a whole topic/theme row (not a task), **when** the user drags it onto the This Week
    band, **then** the observable outcome is the one the PR declares, and it is one of exactly two:
    (a) every open unparked task under that topic enters the band, or (b) the drag is refused with a
    visible message. A silent no-op fails this AC.
    **Observed via:** DOM — either the band's row count increases by that topic's count, or a toast
    with specific text appears. Owner ask #1 names "a topic theme/grouping" as a draggable thing, so
    "nothing happens" is not an acceptable answer.
21. **Given** two categories rendered in the order `Life, Career`, **when** the user drags `Career`
    above `Life`, **then** the rendered order becomes `Career, Life` and is still `Career, Life`
    after a full page reload.
    **Observed via:** DOM order before/after, then after `page.reload()`. Today category order is
    **hard-coded** — `DISPLAY_CATEGORY_ORDER = ["LIFE","CAREER","VENTURES","EDUCATION","FAMILY"]`
    encoded into `parent.position` by `groupByCategory` — so this AC starts RED and requires a
    user-owned override. (Android's equivalent is `config.prioritiesWidget.categories`, i.e. it is
    already config-driven there, matching this repo's "no un-changeable hardcoded config" rule.)

### Persistence of the order, and surviving a grooming pass

22. **Given** the user has ordered tasks inside the Career category, **when** that order is
    persisted, **then** no journey write occurs that sets `is_priority` or `priority_rank` for any
    of those tasks.
    **Observed via:** a spy/log on `invokeJourneyTool` during the reorder asserting **zero** calls
    to `update_task`/`set_priority_rank`/`batch_update_tasks`; and a journey read showing
    `is_priority` unchanged for a previously-unstarred task. **F-4 is why:** `setPriorityRank`
    writes `{is_priority:true, priority_rank:args.rank ?? null}` (execute-tool:2755) and
    `batchUpdateTasks` does `if (typeof u.rank === "number") { data.is_priority = true; … }`
    (execute-tool:~981). Storing a within-category order in `priority_rank` therefore **stars every
    task the user merely ordered**, dragging it into This Week — breaking the owner's distinction
    between "ordered in Career" and "pulled up to This Week".
23. **Given** `tasks.week_order` is a single `task_ids TEXT[]` keyed by `user_email`
    (`tasks.server.ts:284-288`) and therefore holds exactly **one flat list**, **when** the feature
    needs three independent orderings (category order, topic order within a category, task order
    within a topic), **then** the PR states which store holds each one and the migration is in the
    diff.
    **Observed via:** the diff contains the DDL (a new column/table or a documented key convention
    inside the existing array), and `grep -n "week_order" ` in the diff shows the existing band
    ordering is still read by `getWeekOrder`/`applyWeekOrder` unchanged. Overloading one flat
    `TEXT[]` with three orderings without stating the encoding fails this AC.
24. **Given** a persisted category/topic/task order, **when** Huddle's Monday grooming pass runs
    (`groom.ts` → `batch_update_tasks` with dense `rank` 1..N), **when** the widget is read again,
    **then** the rendered order is byte-identical to the order before the groom.
    **Observed via:** capture the flattened id sequence, run `runGrooming` (or the
    `run-grooming.yml` workflow) against a seeded `Test-` fixture set, re-read, compare. An order
    stored in `priority_rank` **cannot** pass this: `groom.ts:254` normalises ranks to a dense
    1..N over the whole slice and `laneFieldFor` sends `unset_rank` for everything outside the cap.
25. **Given** a task whose only reason for being in `tasks.week_order` is a **category-level**
    order pin (not a This Week placement), **when** grooming runs, **then** that task is still
    eligible for grooming's rank lane — or the PR states that it is deliberately exempted.
    **Observed via:** `groom.ts:283-287` reads `userPinned = new Set(await getWeekOrder(email))` and
    `laneFieldFor` returns `{}` (no rank, no unset_rank) for any pinned id. So **reusing
    `week_order` for category ordering silently opts those tasks out of grooming's lane cap** — a
    cross-system side effect the owner did not ask for. Assert either: a groom run still assigns a
    rank to such a task, or the PR names the exemption.
26. **Given** a persisted order and a page reload, **when** the widget mounts, **then** the first
    paint's rendered order equals the persisted order (no visible reshuffle after hydration).
    **Observed via:** a single DOM read after the network is idle; and the server payload's
    `band`/tree order already matching, i.e. the ordering is applied SERVER-side (as
    `applyWeekOrder` already is) and not only in the client `override` state.
27. **Given** an order containing an id that has since been closed, parked or unstarred, **when**
    the widget is read, **then** that id contributes no row and every remaining row still renders
    in the stored relative order.
    **Observed via:** unit test — the existing sparse-pin semantics of `applyWeekOrder` must hold
    for the new levels too (ids absent from `rows` simply drop out; no pruning pass required).

### The empty / absent-tool state (the state production is in RIGHT NOW)

28. **Given** the live deployment exactly as it stands (F-1: `get_task_topics` registered nowhere in
    journey), **when** `getPrioritiesWidget` is called, **then** the returned payload has
    `ok: true`, a non-empty `band`, `topics.ok === false`, `topics.roots.length === 0` and
    `topics.reason === "tool-absent"`.
    **Observed via:** the decoded `getPrioritiesWidget` server-fn response (the
    `test-agent-serverfn` seroval path). Chain, all read this pass: `huddle-proxy/index.ts:198-230`
    forwards any `toolName` with **no allowlist** → `execute-tool` `default:` returns
    `error: "Unknown tool: get_task_topics"` (index.ts:455-459) → `fetchTopicTree`'s matcher tests
    `detail.includes("unknown tool")` → `"tool-absent"`.
29. **Given** that same state, **when** the widget renders, **then** the DOM contains the exact
    sentence *"Topic breakdown isn’t available yet — journey hasn’t deployed its topic list.
    Everything above is live."* — note the TYPOGRAPHIC apostrophes (`’`, U+2019) and the em dash,
    copied from `TopicsEmpty` in `JourneyWidgets.tsx:731`; a test written with a straight `'` will
    report a false RED and the This Week band above it is fully interactive.
    **Observed via:** `getByText` on that string, plus the band's buttons being enabled. **Any AC
    written as "expand Career and see its tasks" is untestable against the live app until the chosen
    source in AC-1 is actually deployed** — this is the AC that makes that visible instead of
    letting a verifier report a false RED.
30. **Given** the feature's chosen data source is unreachable (journey down, env vars absent, tool
    unregistered), **when** the widget is read, **then** the top-level `ok` is still `true`, `band`
    is still populated, and the tree degrades to `{roots: [], reason}` with no exception propagated.
    **Observed via:** unit test with a mocked `invokeJourneyTool` throwing, and one returning
    `{ok:false}`; assert the payload shape and that no rejection escapes. The existing contract
    ("a failed topic tree does NOT set `error`") must still hold.
31. **Given** the feature adds a new journey tool, **when** it is deployed, **then** the tool name
    appears in BOTH `supabase/functions/_shared/tool-definitions.ts` and the `switch` in
    `supabase/functions/execute-tool/index.ts`, and a live call through the proxy returns
    `ok: true`.
    **Observed via:** two greps in the journey diff plus one live proxy call. Registering in only
    one place yields the `Unknown tool` default branch — which is precisely how the current
    `get_task_topics` call fails, and it fails **silently as an empty state**, so a missing
    registration would otherwise look like "no topics yet".
32. **Given** a topic with zero mapped open tasks, **when** it is rendered, **then** its count cell
    is **blank** (not `"0"`) and its expander is disabled/absent.
    **Observed via:** DOM — the count element is absent or empty, and the expand button has
    `disabled` or no `aria-expanded`. Both the existing Huddle code (`{node.count ? … : null}`,
    JourneyWidgets.tsx:707-712) and the Android truth (`if (item.totalCount > 0) "$…" else ""`,
    `PrioritiesWidgetFactory.kt:334`) render blank, so a regression to `0` fails this.

### Duplicate topic names (two "Admin" in the owner's data)

33. **Given** a payload with two topics both named `Admin`, one `category_affinity: LIFE` with 7
    tasks and one `CAREER` with 9, **when** the tree is built, **then** BOTH appear — one under
    `Life & Personal` with its 7 tasks, one under `Career` with its 9 — and no task from either is
    attributed to the other.
    **Observed via:** unit test asserting two distinct nodes and two disjoint task-id sets. The
    existing `buildTopicTree` already carries a regression guard for exactly this input (its own
    comment records the measured `one row — LIFE/7` failure); the new task level must not reintroduce
    it by keying tasks on topic **name**.
34. **Given** the same payload, **when** the rows are rendered, **then** React logs **no duplicate
    key warning** and the DOM contains 2 elements whose `data-topic-id` differ.
    **Observed via:** console assertion in the test run + DOM count. `toTopicNode` falls back to
    `id = name` when the payload carries no id, so a source that omits ids makes both `Admin` nodes
    share `id === "Admin"` — the exact collision the guard was written for.
35. **Given** `get_tasks_by_topic` is chosen as the source (AC-1 option b) and the user has two
    topics named `Admin`, **when** the widget asks for `topic_name: "Admin"`, **then** the widget
    does **not** render `Admin` with zero tasks.
    **Observed via:** a live/mocked call. **F-2 is why this starts RED:** `getTasksByTopic` does
    `.ilike('topic_name', topicName).maybeSingle()` and **discards the error**
    (`const { data: topic } = await …`, execute-tool:2170-2175), so a duplicate name returns
    `{success:true, result:{tasks:[],count:0}, message:'No topic group found matching "Admin"'}` —
    a wrong answer flagged as success. Choosing option (b) therefore requires fixing journey too,
    and this AC is what proves the fix.
36. **Given** `get_tasks_by_topic` is chosen, **when** it is called with a topic name containing
    `%` or `_`, **then** the task set returned is the one for that exact topic.
    **Observed via:** a seeded `Test-` topic named `50%_done`; `ilike` treats both characters as
    wildcards, so an unescaped pass-through matches the wrong row.

36b. **Given** `get_tasks_by_topic` is chosen as the source and a `task_topic_mappings` row points
    at a task belonging to a DIFFERENT user, **when** the tool runs, **then** that task is not
    returned.
    **Observed via:** a seeded cross-user mapping plus the returned task ids. `getTasksByTopic`
    scopes the TOPIC lookup with `.eq('user_id', userId)` but the task fetch is
    `.in('id', taskIds)` with **no `user_id` filter at all** (execute-tool:2199-2205) — scoping is
    only indirect, through the junction table. Every other read in this stack is email/user scoped
    explicitly (`getBoardTasks`, `getOwnedTaskForConfirmAsk`), so this is a gap, not a style choice.

### Tasks that belong to no topic, and tasks in more than one

37. **Given** the user's open unparked tasks number `T`, and the tasks reachable under all rendered
    categories/topics number `R` (distinct ids), **when** both are counted, **then** either
    `R === T`, or the widget renders an explicit bucket whose count is exactly `T - R`.
    **Observed via:** one SQL/mirror read for `T` (`getBoardTasks` filtered by `isOpen && !isParked`)
    and a DOM/payload count for `R`; the difference must be either zero or displayed. A task that is
    in neither place has been **silently dropped**, which is the single most likely wrong-but-running
    outcome of this feature.
38. **Given** a task with `category: 'CAREER'` and no topic mapping at all, **when** the tree is
    built, **then** it appears exactly once, under `Career`, at the category level.
    **Observed via:** unit test asserting the id is present and that its parent node's id is
    `category:CAREER`. journey's live data had **158 topics, 0 with a parent** (measured 2026-09-13,
    quoted in `groupByCategory`), and `task_topic_mappings` is populated by a separate
    `classify-task-topic` function, so unmapped tasks are the common case, not the edge.
39. **Given** a task with neither category nor topic, **when** the tree is built, **then** it is
    reachable from the rendered payload (an "Uncategorised"/"Other" node or the band), and
    `R === T` in AC-37 still holds.
    **Observed via:** unit test + AC-37's count. `groupByCategory` already pushes an uncategorised
    topic through as a top-level row "never silently dropped" — the same property must hold one
    level down for tasks.
40. **Given** a task mapped to two topics, **when** the tree is built, **then** it appears under
    both, and every ancestor count still counts it once (AC-7).
    **Observed via:** unit test. **The Android design truth gets this wrong and must not be copied:**
    `getTasksForTopics` builds `topicByTask: MutableMap<String,String>` keyed by **task id**
    (`SupabaseTaskClient.kt:237-241`), so the **last** mapping wins and the task vanishes from the
    other topic. If the chosen rule is instead "first topic only", the PR must say so and AC-37's
    reconciliation must still pass.

### Categories with no topics at all — FAMILY in the owner's data

41. **Given** the user's data contains no topic whose category resolves to `FAMILY`, **when** the
    tree is rendered, **then** a `Family` row is present with a blank count and a disabled expander.
    **Observed via:** DOM — an element whose text is `Family` exists, its count cell is empty, and
    its expander is `disabled`. **This is the Android design truth** (`rebuildItems` adds a
    `CategoryHeader` for **every** configured category before the `if (!catExpanded) continue`, with
    the fallback list `["LIFE","CAREER","VENTURES","EDUCATION","FAMILY"]`,
    `PrioritiesWidgetFactory.kt:429-484`) and it matches the owner's screenshot.
    **Huddle does NOT do this today** (F-9): `groupByCategory` only creates a category root when
    some topic carries that category, so `Family` is **absent**, not empty. This AC starts RED.
42. **Given** AC-41's `Family` row, **when** the user drags a task onto it, **then** the observable
    outcome is the one the PR declares — either the task's `category` is written to `FAMILY`, or the
    drop is refused visibly. A silent no-op fails.
    **Observed via:** DOM/toast plus a journey read of `public.tasks.category`.
43. **Given** a topic carrying an unknown `category_affinity` such as `SIDE_HUSTLE`, **when** the
    tree is rendered, **then** a `Side Hustle` row exists, positioned after all five known
    categories.
    **Observed via:** unit test on `displayCategory`/`categoryLabel` output plus the rendered order.
    This is an EXISTING property (`DISPLAY_CATEGORY_ORDER` is "an ORDERING, not an allow-list" and
    unknown keys get `position = ORDER.length`) and must survive; the Android truth **loses** it
    (its loop iterates only configured categories, so `SIDE_HUSTLE` is dropped), so copying the
    Android loop shape would regress Huddle.
44. **Given** `PERSONAL` and `LIFE` topics both present, **when** the tree is rendered, **then**
    exactly **one** `Life & Personal` row exists and both topics are beneath it.
    **Observed via:** DOM count of category rows === 1 for that label. Existing
    `CATEGORY_DISPLAY_MAP` behaviour (`PERSONAL→LIFE`, `PROF_EDUCATION→EDUCATION`); a new grouping
    pass that buckets on the raw key would render six rows instead of five.

### Round-trip cost of ONE widget render

45. **Given** the user has 158 topics (the measured live figure), **when** one
    `getPrioritiesWidget` call completes, **then** the number of `invokeJourneyTool` calls it made
    is **≤ 2**, independent of topic count.
    **Observed via:** a counter/spy on `invokeJourneyTool` in a server-side test; assert the count
    for a 5-topic fixture equals the count for a 158-topic fixture. **The Android design truth is
    the bound to match:** `getTasksForTopics` issues exactly **two** REST calls for any number of
    topics — `task_topic_mappings?topic_id=in.(…)` then `tasks?id=in.(…)`
    (`SupabaseTaskClient.kt:231-249`). A per-topic `get_tasks_by_topic` loop would cost **158**
    journey round-trips per render and fails this AC.
46. **Given** the same call, **when** its Azure PG queries are counted, **then** it issues no more
    mirror reads than today's two (`getBoardTasks` + `getWeekOrder`) plus at most one for the new
    ordering store.
    **Observed via:** a `pg` query counter in a server-side test, or the `Promise.all` in
    `getPrioritiesWidget` still containing a bounded, enumerable list of reads.
47. **Given** the 158-topic fixture, **when** `getPrioritiesWidget` is timed server-side, **then**
    it completes in under 5 s and the serialised payload is under 512 KB.
    **Observed via:** a timed test printing elapsed ms and `JSON.stringify(payload).length`.
    (Bounds proposed by this AC pass — the task statement set none. Confirm or replace them.)
48. **Given** the 158-topic fixture, **when** the widget first paints, **then** only the first
    category is expanded and the initial DOM contains at most 20 rows.
    **Observed via:** `querySelectorAll('li').length` on first paint. The existing
    `defaultOpen={i === 0}` exists for exactly this reason ("expand-all would open the rail as a
    163-row wall on a phone"); adding a task level multiplies that, so the collapsed default must
    hold at both the category AND topic level.

### Error states the user can actually see

49. **Given** a reorder (any level) whose persist call returns `ok: false`, **when** it fails,
    **then** the rendered order reverts to the server order and the row does not stay where the user
    dropped it.
    **Observed via:** DOM order after a mocked failing `reorderWidgetBand`. The existing band path
    does this (`if (!res?.ok) setOverride(null)` — "roll back to server order rather than lying");
    the new levels must too. A silent optimistic success that never persisted is the exact
    wrong-but-running failure here.
50. **Given** a reorder whose persist call throws (transport failure), **when** it throws, **then**
    the order reverts AND a visible message appears.
    **Observed via:** DOM order + a toast with specific text. The existing band `catch` does
    `setOverride(null)` with **no toast** — so today a failed reorder reverts silently and the user
    cannot tell whether it saved. Assert a message is shown.
51. **Given** a drag-to-This-Week whose journey write fails, **when** it fails, **then** the task
    does not remain rendered in the band and an error message names the failure.
    **Observed via:** DOM + `toast.error` text, matching `runAction`'s existing
    `rollbackChecklistRow(row.id, before)` + `toast.error(r.error || …)` contract.
52. **Given** an unauthenticated caller, **when** the new ordering write is called, **then** it
    returns `{ok:false, error:"Sign-in required."}` and performs no write.
    **Observed via:** the returned object plus a `pg` spy showing zero statements — the same gate
    every function in `widgets.functions.ts` opens with.
53. **Given** a task id the caller does not own, **when** it is included in any new ordering write,
    **then** it is dropped from the stored list and the rest of the reorder still succeeds.
    **Observed via:** the returned `taskIds` array excludes it, and a read of the store shows it
    absent. This is `reorderWidgetBand`'s existing per-id `getOwnedTaskForConfirmAsk` loop; the new
    levels must not bypass it.
54. **Given** a task id the caller does not own, **when** a drag-to-This-Week is attempted on it,
    **then** the result is `{ok:false, error:"Task not found."}` — the same message as a
    non-existent id, so the response cannot be used to probe for other users' task ids.
    **Observed via:** two calls (forged uuid, another user's real uuid) returning byte-identical
    errors.

### Regression guards — This Week band and its five controls must keep working untouched

55. **Given** a user with starred/ranked open tasks, **when** `getPrioritiesWidget` is called after
    the change, **then** `band` contains exactly the same ids, in the same order, as before the
    change for the same input.
    **Observed via:** a golden-file unit test on `buildPrioritiesBand` with a fixed fixture,
    captured BEFORE the change and asserted after. The band filter
    (`is_priority === true || priority_rank !== null`, open, unparked) must be unmodified.
56. **Given** the band rendered on a `live` widget with 3+ rows, **when** ▲ is clicked on row 2,
    **then** rows 1 and 2 swap, `reorderWidgetBand` is called with the full new id list, and after
    reload the new order persists.
    **Observed via:** DOM order, a spy on the server fn's `taskIds` argument, then `page.reload()`.
57. **Given** a frozen in-chat snapshot card (`live` not set), **when** it renders, **then** no ▲/▼
    buttons are present and no drag handle is active.
    **Observed via:** DOM — `queryAllByLabelText(/Move .* up/)` length 0. `canReorder = live === true
    && data.ok && data.band.length > 1` must still gate BOTH the buttons and the new drag.
58. **Given** a band row, **when** `✓ Today` / `▲ Today` is clicked, **then** `updateWidgetTask` is
    called with `today`/`untoday`, the row's chip flips immediately, and `move_task_to_day` /
    `unschedule_task` is the journey tool invoked.
    **Observed via:** spies on `updateWidgetTask` and `invokeJourneyTool` + the `aria-pressed` value.
59. **Given** a band row, **when** `⏸` is clicked, **then** the journey call is `update_task` with
    `status: "BACKLOG"` **and** `tags` equal to the task's existing tags **plus** `parking-lot` —
    never `["parking-lot"]` alone.
    **Observed via:** the spied `args.tags` array. journey's `update_task` REPLACES the tag array,
    so a regression here silently wipes `blocked`/`reminder`/`quick-win` labels. `withParkingLotTag`
    must still be the single union helper (`grep -c "withParkingLotTag"` unchanged or higher).
60. **Given** a band row that is not `DOING`, **when** `✓` is un-ticked, **then** the action sent is
    `reopen` (status `BACKLOG`, tags untouched) — **not** `pause`.
    **Observed via:** the spied `action` value and the absence of any `tags` key in `args`.
    Un-ticking must not park the task.
61. **Given** a band row, **when** it is double-tapped, **then** exactly one journey write occurs.
    **Observed via:** a counter on `invokeJourneyTool`. The `busy` guard only works once the row is
    in the store map, which is why `runAction` seeds first — that seeding must survive.
62. **Given** two mounted copies of the widget (a chat card and the docked rail), **when** one
    category is expanded in one copy, **then** the other copy's expansion state is unchanged.
    **Observed via:** DOM `aria-expanded` on both. Expansion must stay LOCAL component state; moving
    it to the store to support the new task level would make the copies fight.
63. **Given** a stale snapshot card and a live widget sharing rows, **when** both are mounted,
    **then** the live payload's values win in the shared row map.
    **Observed via:** the rendered status/today state matching the live payload — the existing
    `useSeededRows(rows, live)` seed-vs-refresh split must be unchanged.
64. **Given** the whole change, **when** `npx tsc --noEmit` and the existing test suite run,
    **then** both exit 0 and `npm run test:router` still reports 9/9.
    **Observed via:** the two command exit codes and the router test output line.
65. **Given** any new guard added by this work (a comparator totality check, a count-reconciliation
    assertion, the duplicate-name guard), **when** `scripts/mutate.sh <file> <anchor> <replacement>
    <test-cmd> <pattern>` reverts the guarded behaviour, **then** the result is `FIRED` — never
    `INERT`, never `NOT-APPLIED`.
    **Observed via:** the `mutate.sh` output line for each new guard. An `INERT` guard is worse than
    none because it is believed.

### Cross-surface reconciliation (the classic bug this project keeps hitting)

66. **Given** one task that is both starred (so it is in This Week) and mapped to a topic under
    Career, **when** the widget renders, **then** the SAME task id appears in both places and its
    rendered title, category chip and Today state are identical in both.
    **Observed via:** DOM — the two rows with that `data-task-id`, compared field by field. They
    read through the same `useRowState` overlay today; a new task row that reads
    `row.status` directly instead of `useRowState` would show a stale value in one place after a
    write.
67. **Given** a task shown under Career, **when** `✓` is clicked on it in the tree, **then** the
    copy of that task in the This Week band also shows as done, without a refetch.
    **Observed via:** DOM — both rows' line-through/strikethrough state after one click. This only
    works if the new task rows go through `useRowState`/`runAction`; a second write path would leave
    the two rows disagreeing on screen.
68. **Given** the `prioritize(category)` agent tool and the widget's Career ordering, **when** both
    are asked for Career's top item, **then** they name the same task id — or the PR states that
    `prioritize` uses the scoring engine (`lib/tasks/scoring.ts`) and the widget uses the user's
    manual order, and names which one an agent asked to "autopull one or two" must use.
    **Observed via:** the two returned ids, plus the PR statement. Owner ask #2 is explicitly about
    an agent knowing "whats next", and this repo already has TWO ordering authorities
    (`scoring.ts` and `priority_rank`/`week_order`) — shipping a third without reconciling them is
    the "parallel system" failure.

## Goal → AC coverage

| Owner's words | ACs |
|---|---|
| "items for this week and below that the catagories and themes" | 3, 4, 5, 28, 29, 41, 44, 48 |
| "i can drag to the top … a topic theme/grouping or the task itself" | 17, 18, 19, 20, 21, 42, 49, 50, 51 |
| "currently it populates this week with tasks when i should be able to drag…" | 19, 20, 22, 55, 57 |
| "a way to dray one row above the other for priority amongst priorities" | 17, 18, 56 |
| "and even at the category and below rows" | 20, 21, 23, 41, 42 |
| "SO IF AN AGENT … ASKED TO AUTOPULL ONE OR TWO FROM THE CATEGORIES IT KNOWS WHATS NEXT" | 11, 12, 13, 14, 15, 16, 24, 68 |
| (implicit) nothing already working may break | 55–65, 66, 67 |
| (implicit) it must be true on his screen, not just in a fixture | 28, 29, 31, 45 |

**Every AC traces to a goal.** The ones with no direct owner sentence behind them — 6, 7, 8, 9, 10,
25, 30, 32–40, 45–54 — exist because each is a way for the feature to run successfully and still be
wrong: a count that disagrees with the rows under it, a topic that absorbs another's tasks, a task
that is silently in no bucket, 158 round-trips per render, a reorder that reverts silently.

**Goals with the weakest coverage, flagged rather than papered over:** "drag a topic/grouping to the
top" (AC-20) has no defined outcome in the request at all — only AC-20's forced choice covers it.
That is a GAP, listed below.

## Gaps / open questions that should be settled BEFORE implementation

- **G-1. The data source does not exist.** F-1: journey registers no `get_task_topics`. Until AC-1's
  choice is made and (for options a/b) deployed to journey, nothing about the tree is live-testable.
  This is the decision that blocks everything else.
- **G-2. "Drag a topic/grouping to the top" has no defined meaning.** Does it re-order the topic
  among its siblings, or move its tasks into This Week? The owner's sentence supports both readings
  and they produce materially different work. AC-20/AC-21 split them; one needs to be chosen.
- **G-3. Three orderings, one flat array.** `tasks.week_order` holds one `TEXT[]` per user (AC-23).
  Whether the category/topic/task orders live in new columns, a new jsonb shape, or a documented
  encoding inside that array is a schema fork, not a detail — and reusing the array has the
  grooming side effect in AC-25.
- **G-4. BLOCKED, and `%test%`.** journey's `get_tasks_by_topic` excludes `BLOCKED` and any title
  matching `%test%`; Huddle's `isOpen()` keeps BLOCKED. Counts will disagree across surfaces until
  one rule is chosen (AC-9).
- **G-5. FAMILY: empty row, or no row?** Android renders it blank; Huddle omits it. AC-41 assumes
  the Android behaviour because it is what the owner is looking at — confirm.
- **G-6. No performance numbers were given.** AC-47's 5 s / 512 KB and AC-48's 20-row first paint
  are **this AC pass's proposals**, not requirements. Confirm or replace them.
- **G-7. Two ordering authorities already exist** (`scoring.ts`'s computed score and
  `priority_rank`/`week_order`'s manual order). AC-68 forces a statement about which one an
  auto-pulling agent reads; it does not decide it.

## ACs that CANNOT be verified from this repo or a CCR session

These need a different vehicle. Listed with the reason and the vehicle.

| AC | Why a CCR session cannot settle it | Vehicle needed |
|---|---|---|
| 4, 5, 6, 17, 18, 19, 20, 21, 29, 32, 41, 42, 48, 56, 57, 58, 62, 66, 67 | They are DOM/pointer observations against the **deployed SWA**, whose host is frequently outside this session's egress allowlist, and the app needs real MSAL auth. Drag in particular cannot be observed without a real browser. | **`verify-uat.yml`** (GitHub-Actions Playwright against the deployed SWA with `?uat_token=`), using `huddle-checks.mjs`; screenshots retrieved via the `uat-shots` orphan branch. Component-level DOM ACs (4, 5, 6, 32, 57, 62) can alternatively run in-repo under a jsdom test runner with a fixture payload — that is cheaper and should be preferred where the AC does not need the live data. |
| 17, 18 (drag/touch feel), 20, 21 | HTML5 native DnD does not fire on touch, and a headless synthetic pointer sequence proves the handler runs, not that the gesture works on the owner's phone. Per this repo's own rule, a synthetic harness here is a **smoke test, not proof**. | Mechanism verified in `verify-uat.yml`; the verdict is the **owner confirming live on his phone**. Status until then must read `MECHANISM ONLY, NOT USER-CONFIRMED`. |
| 19, 22, 24, 25, 42, 51, 54, 59, 60 | They assert the state of **journey's `public.tasks`** (`is_priority`, `priority_rank`, `tags`, `category`) after a write. | **Supabase MCP** against journey project ref `wwxgajrtmslzklnyplah` (cast the `task_status` enum `::text`), or `db-query.yml` / `azure-pg-query.yml` as the fallback when the connector's OAuth has expired. Seed with `Test-` prefixed tasks and clean up by marker. |
| 24 (survives grooming) | Grooming runs on a cadence and writes the live board; it cannot be exercised meaningfully from a sandbox. | **`run-grooming.yml`** workflow dispatch against `Test-` fixtures, then a `azure-pg-query.yml` read of `tasks.week_order` and `tasks.journey_tasks`. |
| 28, 29, 31, 35, 36, 45 | They depend on what journey has actually **deployed**, not on what is in the working tree. journey's git history is truncated, so `git log` cannot prove a tool was never shipped. | A **live proxy call** — `invokeJourneyTool({toolName:…})` through the deployed SWA server fn (the `test-agent-serverfn` seroval path), or `GET execute-tool/definitions`, which returns the registered tool list. Reading `execute-tool/index.ts` on `main`, as this pass did, is evidence about the source, not about the deployment. |
| 37 (R === T reconciliation) | Needs the owner's real task set; a fixture cannot show a real silent drop. | **`azure-pg-query.yml`** for `T` (the mirror) plus one live widget payload for `R`. |
| 45, 46, 47 | Round-trip and timing counts need instrumentation inside the running server, and the 158-topic figure is live data. | In-repo server-side test with a spy for the **invariance** (5-topic count === 158-topic count); the absolute live timing needs the deployed SWA, i.e. `verify-uat.yml` or a timed server-fn call. |
| 64, 65 | Fully verifiable here. | `npx tsc --noEmit`, the test runner, and `scripts/mutate.sh` — no external vehicle needed. |

**One thing no vehicle can supply:** AC-28/AC-29 describe the state production is in **today**, and
they are the only tree ACs that are GREEN before any work starts. Every other tree AC is RED because
there is no tree. A verifier that reports "the topic tree is empty" as a defect of this change has
mis-attributed F-1 — it was already empty.
