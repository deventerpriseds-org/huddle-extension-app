# VERIFY topic-tree-categories — loop 1

WHAT:       Independent adversarial verification of the topic-tree/category change deployed at huddle origin/main 1a9be2b.
WHY:        Claims made by the implementing session are unverified until observed. No shared context with that session.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   commands + file:line + live SQL recorded inline below.

Verifier start: 2026-09-13T15:48:32Z. Budget 25 min.
Baseline: huddle-extension-app local HEAD d3cbe63 (origin/main 1a9be2b + docs commit). journey-voice origin/main c7491b1, checked-out branch claude/journey-widgets-in-chat.

---

## C1 — journey web + Android bridge read `task_topic_index` DIRECTLY over PostgREST with USER credentials, not via `execute-tool`

**CONFIRMED.**

journey web (`/home/user/journey-voice/src/pages/Priorities.tsx:222`), inside `loadData`:
```
supabase.from('task_topic_index').select('*').eq('user_id', user.id),
```
That `supabase` is the browser client from `src/integrations/supabase/client.ts`, created with
`SUPABASE_PUBLISHABLE_KEY` (a JWT whose payload decodes to `"role":"anon"`) plus a localStorage-persisted
session (`STORAGE_KEY = sb-wwxgajrtmslzklnyplah-auth-token`) — i.e. the signed-in user's own credentials,
RLS-scoped. `supabase.from(...)` is PostgREST, not an edge function. No `execute-tool` appears on this path.

Other direct user-credential writes/reads on the same table in journey web, confirming the pattern is
table-level and not tool-mediated:
- `src/components/priorities/AddTopicGroupDialog.tsx:49` — `.upsert(`
- `src/components/priorities/TopicGroupPanel.tsx:53` — `.delete().eq('id', ...)`
- `src/pages/Priorities.tsx:531` — `.update({ position: i })`
- `src/pages/Priorities.tsx:592` — `.update({ category_affinity: dstCatKey })`

Android bridge (`/home/user/android-bridge-template/app/src/main/java/com/bridgetemplate/util/SupabaseTaskClient.kt:216-221`), `getPriorityGroups`:
```
val (supabaseUrl, anonKey, accessToken, userId) = credsWithUser(context) ?: return null
appendLog(context, "FETCH task_topic_index groups")
return getArray(
    "$supabaseUrl/rest/v1/task_topic_index?select=id,topic_name,position,category_affinity,parent_topic_id,window_affinity&user_id=eq.$userId&order=position.asc",
    anonKey, accessToken, context
)
```
`/rest/v1/` is PostgREST. Headers set at `SupabaseTaskClient.kt:44-45`:
`apikey: $anonKey` + `Authorization: Bearer $accessToken`, where `accessToken` is read at line 27 from
`EncryptedPrefs.get(context, "supabase_access_token")` — the signed-in user's session token, not a service
role key and not a shared secret. `grep -rn SERVICE_ROLE --include=*.kt` over the repo: no hits.
Note the Android select list explicitly includes `id`, `category_affinity` and `parent_topic_id` — the exact
columns a tree needs (relevant to C3).

---

## C2 — Huddle cannot use that route (shared-secret proxy credential only, no journey user session)

**CONFIRMED.**

Huddle's only journey egress is `journeyFetch` in
`/home/user/huddle-extension-app/src/features/huddle/lib/journey/proxy.functions.ts:35-46`:
```
const token = (process.env.JOURNEY_PROXY_TOKEN ?? "").trim();     // :31
const res = await fetch(url + path, { headers: { authorization: `Bearer ${token}`, "x-huddle-proxy": "1" }, ... })
```
`JOURNEY_PROXY_URL` is documented at `:17` as `https://<journey-project>.supabase.co/functions/v1/huddle-proxy`.
Only three paths are ever requested: `"/tools"` (`:65`), `"/tool"` (`:110`), `"/health"` (`:158`).
`invokeJourneyTool` (`:107`) takes `toolName: z.string().min(1)` (`:202`) — a NAMED tool, nothing else.

The proxy's own surface (`/home/user/journey-voice/supabase/functions/huddle-proxy/index.ts`) is exactly
those three routes and no more:
- `:128-133` shared-token gate: `token !== PROXY_TOKEN → 401`. That is the ONLY credential Huddle presents.
- `:137` `GET …/health`, `:146` `GET …/tools`, `:151` `POST …/tool`.
- `:154-157` `POST /tool` requires `toolName`; `:197-206` delegates to `${SUPABASE_URL}/functions/v1/execute-tool`
  with `{ toolName, args, ... }`.
There is no table/PostgREST/SQL passthrough route. The user identity is resolved SERVER-SIDE inside the proxy
(`resolveUserId(supabase, caller)` with `SUPABASE_SERVICE_KEY`, `:158-159`) from the caller's email — Huddle
never holds a journey user session token.

Disconfirming check run: `grep -rn "wwxgajrtmslzklnyplah|SUPABASE_ANON|SUPABASE_SERVICE_ROLE|supabase.co/rest"`
over all of huddle `src/` returns exactly ONE hit, and it is a prose comment
(`src/features/huddle/lib/tasks/widgets.server.ts:525`), not a credential or a request. So there is no second
route into journey's database from Huddle.

---

## C3 — `get_task_topics` is NOT a duplicate of the `topic_groups` returned by `get_tasks`/`get_today_tasks`

**CONFIRMED — but the cited reason is one detail wrong; correction below.**

Read from journey `origin/main:supabase/functions/_shared/call-context-builder.ts` (not the working tree):

- `getTopicGroupsManual` is declared at line **204** and its last statement is line **272**:
  `return results.slice(0, 5);` — a hard top-5 cap. CONFIRMED as cited.
- The object it returns (lines 251-266) has exactly six fields:
  `topic_name, topic_summary, position, task_count, recency, priority_density`.
  No `id`, no `category_affinity`, no `parent_topic_id`. So the payload is structurally incapable of
  expressing a tree — no node identity and no parent edge to link on.
- `formatTopicGroups` (line 277) renders it as `"1. <name> (<n> tasks)"` — a flat numbered voice summary.

**CORRECTION to the claim's stated reason.** The claim says it "selects neither `id` nor
`category_affinity`". `id` IS selected from the table, at line 236:
```
.from('task_topic_index').select('id, topic_name, topic_summary, position')
```
— it is needed for the `topicTaskMap` join. What is true is that `id` is not *returned* to the caller, and
`category_affinity` / `parent_topic_id` are neither selected NOR returned. The conclusion (not a duplicate)
holds on stronger evidence than the claim gave; the wording of the reason is inaccurate about `id`.

---

## C4 — live journey data: `parent_topic_id` NULL on every row; 5 distinct `category_affinity`

**CONFIRMED**, with a caveat that matters for C6.

`mcp__Supabase__execute_sql`, project `wwxgajrtmslzklnyplah`, read-only:
```sql
SELECT count(*) total_rows, count(parent_topic_id) rows_with_parent,
       count(*) FILTER (WHERE parent_topic_id IS NULL) rows_parent_null,
       count(DISTINCT category_affinity) distinct_category_affinity,
       count(*) FILTER (WHERE category_affinity IS NULL) rows_category_null
FROM public.task_topic_index;
```
→ `{"total_rows":158,"rows_with_parent":0,"rows_parent_null":158,"distinct_category_affinity":5,"rows_category_null":0}`

So: 158 rows, **zero** have a parent, **five** distinct category values, **zero** null categories.

The five values are NOT the five display categories:
```sql
SELECT category_affinity, count(*) FROM public.task_topic_index GROUP BY 1 ORDER BY 2 DESC;
```
→ `LIFE 60, VENTURES 50, PROF_EDUCATION 24, CAREER 13, EDUCATION 11`

**Caveat (verifier's own observation, not in any claim):** `PERSONAL` and `FAMILY` have **zero** rows in live
data today. Under the C6 merge rules (`PROF_EDUCATION→EDUCATION`), today's live data collapses to **four**
occupied display rows — Life & Personal, Ventures, Education, Career — not five. FAMILY is a display category
with no live data behind it. Any claim of "5 categories on screen" is a claim about the CODE's category list,
not about what today's data produces.

---

## C5 — journey's tree is FOUR levels, and category COMPOSES with `parent_topic_id` rather than replacing it

**CONFIRMED.**

The commit exists and is absent from `origin/main`:
```
$ git -C /home/user/journey-voice cat-file -t f0ab561            -> commit
$ git log -1 --format='%H %an %ad %s' f0ab561
f0ab561ece771261319458714a3317747088a488 deventerprisesds Mon Jun 29 09:50:46 2026 -0400
fix: priority widget proper nesting with category > group > sub-group > task tree
$ git merge-base --is-ancestor f0ab561 origin/main                -> exit 1 (NOT an ancestor)
$ git branch -a --contains f0ab561                                -> (empty)
```
Its own message says the four levels verbatim. `--stat`: `CategoryTreeSection.tsx` (+114 new) and
`Priorities.tsx` (535 changed).

The composition is visible in the code, not just the message (`git show f0ab561:src/pages/Priorities.tsx`):
- L267 `DISPLAY_CATEGORIES.map(key => …)` — the OUTER level is category.
- Inside each category, L268-270 selects top-level topics (`topics` = `allTopics.filter(t => !t.parent_topic_id)`,
  built at Priorities.tsx L231-234) — the GROUP level.
- L276-283 `children: (childrenMap.get(t.id) || []).map(child => ({ …, children: [] }))` — the SUB-GROUP
  level, from `parent_topic_id`. So category wraps the parent-id nesting; they are not alternatives.
- L279/L282 `tasks: (topicTasksMap.get(…) || []).sort(PRIORITY_SORT)` — the TASK level.
- L257-262: a child topic with no category of its own INHERITS its parent's — further proof the two
  levels coexist by design.

Verifier's own addition: journey's sub-group depth is exactly ONE (`children: []` is hardcoded on the
child at L282). journey does not render arbitrary depth.

---

## C6 — journey merges raw category keys into five display rows

**CONFIRMED in substance; the count "six" is wrong — the map has SEVEN keys.**

`git show f0ab561:src/pages/Priorities.tsx`, lines 46-72:
```
L46  const DISPLAY_CATEGORIES = ['LIFE', 'CAREER', 'VENTURES', 'EDUCATION', 'FAMILY'] as const;
L48  const CATEGORY_DISPLAY_MAP: Record<string, string> = {
       LIFE:'LIFE', PERSONAL:'LIFE', CAREER:'CAREER', VENTURES:'VENTURES',
       EDUCATION:'EDUCATION', PROF_EDUCATION:'EDUCATION', FAMILY:'FAMILY' };
L66  const CATEGORY_LABELS = { LIFE:'Life & Personal', CAREER:'Career', VENTURES:'Ventures',
       EDUCATION:'Education', FAMILY:'Family' };
```
- `PERSONAL → LIFE`, labelled **"Life & Personal"** — CONFIRMED.
- `PROF_EDUCATION → EDUCATION`, labelled **"Education"** — CONFIRMED.
- `FAMILY` present as the fifth display category — CONFIRMED.
- **Count correction:** `CATEGORY_DISPLAY_MAP` has **seven** keys collapsing to **five** values, not six.
  (Six only if FAMILY is excluded from the count, which the claim's own wording "plus FAMILY" may intend.)

**Divergence worth recording (verifier's own finding):** journey's `catData` is built by mapping over the
FIXED `DISPLAY_CATEGORIES` list (L267). A category key that is not one of those five is **dropped from the
category rail entirely** in journey — there is no dynamic append. Huddle deliberately does NOT copy that
(see C7(iii)); Huddle is more forgiving than the thing it is modelled on. That is a deliberate, documented
divergence (widgets.server.ts:474-478), not a faithful port.

---

## C7 — huddle's `widgets.server.ts` faithfully implements C5 and C6

**CONFIRMED for (i)-(iv). REFUTED for (v): there ARE inputs that make a topic disappear entirely.**

All results below are from executing the REAL exported `buildTopicTree` (probe `/tmp/probe/p1.ts`,
`bun`), not from reading.

| # | Question | Result | Observed |
|---|---|---|---|
| i | Category grouping still happens when SOME topics have children and others don't? | **YES** | in: `a`(CAREER, 1 child) + `b`(VENTURES, no children) → out top level `["category:CAREER\|pos=1\|count=5", "category:VENTURES\|pos=2\|count=5"]` — both wrapped |
| ii | Category count = sum over WHOLE subtree? | **YES** | `a.count=2` + child `a1.count=3` → `category:CAREER.count = 5` |
| iii | Unknown category key survives? | **YES** | `SIDE_HUSTLE` → `category:SIDE_HUSTLE`, label `"Side Hustle"`, `position=5` (past `DISPLAY_CATEGORY_ORDER.length`), sorts after every known one |
| iv | Topic with no category survives? | **YES** | `NoCat` emerges as its own top-level row `x\|pos=null\|count=4`, not dropped, not bucketed as "Other" |
| v | Any input that makes a topic disappear? | **YES — two** | see REFUTATION below |

Code basis for (i): `buildTopicTree:683` and `:698` BOTH end in `sortNodes(groupByCategory(...))`, so the
category step runs on every branch — the regression described in the file's own comment (`:519-523`) is
genuinely fixed. (ii): `widgets.server.ts:600-612`, the `walk` closure recurses into `c.children`.
(iii): `displayCategory:490-493` falls through with `?? k`, and `DISPLAY_CATEGORY_ORDER` is used only as an
`indexOf` rank (`:593-594`), never as a filter. (iv): `:565-568` `if (!own) { out.push(n); continue; }`.

### REFUTATION of (v) — two inputs that lose a topic outright

**(v-a) Duplicate `id` — one topic silently vanishes.**
```
in  (3 topics): [{id:"dup",topic_name:"First",...},{id:"dup",topic_name:"Second",...},{id:"ok",topic_name:"Third",...}]
out (2 topics): ["First","Third"]          <-- "Second" is GONE
```
Cause: `widgets.server.ts:686` `for (const n of flat) if (!byId.has(n.id)) byId.set(n.id, n);` — the second
node with a taken id is never inserted, and `:689` iterates `byId.values()`, so it never reaches `roots`.
This is the same class of failure the file's own comment at `:622-625` says must never happen again
("a malformed row must cost its own nesting, never its existence"). The cycle case was fixed; this one
was not. NOTE: it affects only the FLAT branch — the already-nested branch (`:683`) returns `flat` and
does not dedup.

**(v-b) No `id` field + a repeated `topic_name` — one topic vanishes, and its COUNT is lost with it.**
```
in  (2 topics): [{topic_name:"Admin", category_affinity:"LIFE",  task_count:7},
                 {topic_name:"Admin", category_affinity:"CAREER", task_count:9}]
out (1 topic):  ["Admin"], top level = ["category:LIFE|pos=0|count=7"]
```
The CAREER row and its 9 tasks are gone from the rail entirely. Cause: `toTopicNode:431`
`const id = firstString(o, ["id","topic_id","topicId"]) ?? name;` — with no id, the NAME becomes the id,
so two same-named topics collide and (v-a) then drops one. This is the more realistic of the two: journey's
`get_task_topics` envelope "is NOT yet published" per the file's own comment at `:401-404`, so a payload
without `id` is exactly the case the parser was written to tolerate — and it is the case that loses data.
Severity is bounded (journey's own rows always carry a uuid `id`), but it is a real lossy input, and
`JourneyWidgets.tsx` compounds it by keying React rows on `t.id`.

---

## C8 — `bun scripts/widget-topic-tree.test.ts` reports 17/0, with no stranded assertions

**CONFIRMED.**

```
$ bun scripts/widget-topic-tree.test.ts
...
==================== 17 passed, 0 failed ====================
```
Stranded-assertion audit (the defect that previously left 7 assertions inert):
- `grep -c "check(" scripts/widget-topic-tree.test.ts` → **18**.
- `grep -n "function check"` → **line 30** — one of the 18 is the definition.
- 18 − 1 definition = **17 call sites**, matching the 17 reported passes exactly. Nothing is skipped.
- `grep -n "process.exit"` → **line 231 only**, and `wc -l` → **231**. The single `process.exit` is the
  LAST line of the file, so no assertion can sit after it. The earlier defect cannot be present.

---

## C9 — nothing in this change touches TASK hierarchy (epic → task → subtask)

**CONFIRMED.**

```
$ git diff --stat 7dc0243..1a9be2b
 .claude/actions.md                                |  28 +
 .claude/memory.md                                 |  63 +
 package.json                                      |   3 +-
 scripts/widget-topic-tree.test.ts                 | 231 +
 src/features/huddle/components/JourneyWidgets.tsx |  24 +-
 src/features/huddle/lib/tasks/widgets.server.ts   | 199 +-
 6 files changed, 532 insertions(+), 16 deletions(-)
```
Only TWO runtime files change, and neither is a task-hierarchy path:
- `widgets.server.ts` — TOPIC tree only (`task_topic_index` shape: `parent_topic_id`, `category_affinity`).
- `JourneyWidgets.tsx` — the entire runtime change is the expand-default: `TopicRow` gains a
  `defaultOpen` prop, `useState(depth === 0 && hasChildren)` becomes `useState(defaultOpen && hasChildren)`,
  and the caller passes `defaultOpen={i === 0}`. Presentation only.

Grepping the diff for `epic|subtask|sub_task|parent_task|parentTask|task_hierarchy` (case-insensitive)
returns 6 hits, and **every one is a comment or a markdown line** (`.claude/memory.md` lines describing
that task hierarchy is a different table, and the `widgets.server.ts:487` comment). Zero executable lines.
`parent_task_id` does not appear as code anywhere in the diff — consistent with
`docs/feasibility-epics-tasks-subtasks.md` recording that the column does not exist.

---

## C10 — ADVERSARIAL: attempts to break `groupByCategory` / `buildTopicTree`

**COMPLETED — 4 defects found, all reproduced by running the real exported functions.**
Probes: `/tmp/probe/p1.ts`, `/tmp/probe/p11.ts`, `/tmp/probe/deep*.ts`, run with `bun`.

Attacks that FAILED to break it (the function is right about these):
- mutual-parent cycle (`p→q`, `q→p`): both topics survive as roots — `hasAncestorCycle` works.
- self-parent: handled by `parent !== n` (`:691`).
- missing parent id: node promoted to root, not dropped.
- double-wrapping: a payload of category roots is returned untouched (`:549`).
- unknown category: passes through with a rank past the end; never dropped.
- uncategorised topic: kept as its own top-level row.

### D1 — LOSS: duplicate `id` drops a topic (also reported under C7(v-a))
Input 3 topics with ids `dup, dup, ok` → output 2 topics `["First","Third"]`. `widgets.server.ts:686`.

### D2 — LOSS: no `id` + repeated `topic_name` drops a topic AND its count (C7(v-b))
Input `[{topic_name:"Admin",category_affinity:"LIFE",task_count:7},{topic_name:"Admin",category_affinity:"CAREER",task_count:9}]`
→ output one row, `category:LIFE count=7`. The CAREER row and its 9 tasks vanish. `toTopicNode:431` +
`buildTopicTree:686`.

### D3 — NESTING SILENTLY DROPPED in a mixed payload (no topic lost, but the tree is wrong)
Exact input:
```
[{id:"a", topic_name:"A", category_affinity:"LIFE", task_count:1, children:[{id:"a1",topic_name:"A1",task_count:1}]},
 {id:"b", topic_name:"B", category_affinity:"LIFE", task_count:1},
 {id:"c", topic_name:"C", parent_topic_id:"b", category_affinity:"LIFE", task_count:1}]
```
Exact output:
```
category:LIFE
  a
    a1
  b
  c            <-- C should be nested UNDER b; it is b's SIBLING
C nested under B? -> false | LIFE count = 4
```
Cause: `buildTopicTree:683` — `if (flat.some(n => n.children.length > 0)) return sortNodes(groupByCategory(flat));`
returns EARLY the moment ANY entry arrives pre-nested, so the `parent_topic_id` pass at `:685-697` never
runs for the entries that used that shape. The two input shapes are treated as mutually exclusive, but the
file's own doc at `:655-661` describes them as alternatives the parser accepts — it does not say they
cannot co-occur. No topic is lost and the count stays correct (4), so this is a fidelity defect, not a
data-loss one. It is exactly the "some topics nest and others do not" state the file says it was written
to survive (`:664-666`) — that concern was addressed for the CATEGORY level but not for the NESTING level.

### D4 — QUADRATIC cost on a deep parent chain; RangeError past ~24k–32k (caught, degrades to empty)
Measured, one chain of N topics each parenting the next:
```
depth=500    26 ms      depth=4000    736 ms     depth=16000  14,522 ms
depth=1000   59 ms      depth=8000  3,460 ms     depth=24000  46,771 ms  (still OK)
depth=2000  256 ms                               depth=32000  RangeError: Maximum call stack size exceeded
                                                 depth=50000  RangeError: Maximum call stack size exceeded
```
16× the nodes costs ~133× the time — O(n²), from `hasAncestorCycle` (`:627-636`) walking the full ancestor
chain once per node. The recursion limit sits between 24,000 and 32,000 (`firstCategoryInSubtree`, the
`walk` closure, and `sortNodes` are all unbounded-depth recursive; only `toTopicNode` is capped by
`MAX_TREE_DEPTH`).

**Severity is LOW and must be stated as such:** `buildTopicTree` is called at
`widgets.functions.ts:151` INSIDE a `try` whose `catch` (`:153-157`) turns any throw into
`{ok:false, roots:[], reason:"error"}`, and the widget's two halves are independent — so the overflow
degrades to an empty topic tree, never a crash. And live data is 158 topics with ZERO parents (C4), so
nothing approaches these depths today. The practical risk is the ~47s at depth 24k, which would blow the
SWA request ceiling long before the stack does.

### D5 — ORDERING: an uncategorised topic interleaves among the category rows
```
in : Zeta uncategorised(position 0, no category), Ventures thing(position 3), Life thing(position 4)
out: ["Life & Personal(pos=0)", "Zeta uncategorised(pos=0)", "Ventures(pos=2)"]
```
Category roots get `position` = their rank 0-4 (`:593-594`), but an uncategorised topic passed through at
`:566` keeps its RAW journey position (0…157). The two number spaces are then sorted together by
`sortNodes`, so uncategorised topic rows land BETWEEN category rows rather than after them. Cosmetic, and
not something any claim asserted — recorded because the rail's top level is meant to read as categories.

---

## VERDICT

**C1 CONFIRMED · C2 CONFIRMED · C3 CONFIRMED (stated reason wrong about `id`: it IS selected, just not returned) · C4 CONFIRMED (but PERSONAL and FAMILY have zero live rows, so today's data yields FOUR occupied display rows, not five) · C5 CONFIRMED · C6 CONFIRMED (the map has SEVEN keys → five rows, not six) · C7 REFUTED IN PART — (i)(ii)(iii)(iv) all hold under execution, (v) FAILS: duplicate `id`, and no-`id`-plus-repeated-name, each silently delete a topic · C8 CONFIRMED (17 live `check(` call sites, single `process.exit` on the last line) · C9 CONFIRMED · C10 COMPLETED — 5 defects (2 data-loss, 1 nesting-fidelity, 1 O(n²)/stack, 1 ordering) — CONFIRMED 8 / REFUTED 1 (C7, in part) / UNPROVEN 0.**
