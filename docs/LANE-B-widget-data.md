# LANE B — server-side data for the in-chat journey widgets

<!--
WHAT:       Server functions supplying data for two in-chat widgets (SCHEDULE, PRIORITIES) that
            mirror journey's Android home widgets. Lane C builds the UI against the types here.
WHY:        The widgets need email-scoped, timezone-correct reads of the existing Azure mirror
            (`tasks.journey_tasks`) plus a degradable passthrough to journey's `get_task_topics`
            proxy tool. No new store, no second query layer, no second writer.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   docs/widgets/spec-schedule-widget.jpg, docs/widgets/spec-priorities-widget.jpg;
            DDL + tool schemas + proxy envelope all quoted below exactly as read this session;
            tsc result and mutation-proof recorded in "Verification".
-->

Branch: `claude/journey-widgets-in-chat`. Lane B owns only
`lib/tasks/*.server.ts`, `lib/journey/*`, and new `*.functions.ts` under `lib/`.

## Progress log

- [x] Read both widget spec screenshots.
- [x] Created this doc.
- [x] Read the real DDL in `lib/tasks/tasks.server.ts` (`BOOTSTRAP_SQL`, lines 29-53).
- [x] Read `getBoardTasks` + `BoardTaskRow` (tasks.server.ts ~1560-1628) and `board.functions.ts`.
- [x] Read `lib/journey/proxy.functions.ts` (`invokeJourneyTool`) + `lib/journey/types.ts`.
- [x] Read journey's `_shared/tool-definitions.ts` for `update_task` / `move_task_to_day` /
      `unschedule_task` schemas, and `huddle-proxy/index.ts` for the response envelope.
- [x] Read Lane A's `/home/user/journey-voice/docs/LANE-A-get-task-topics.md`.
- [x] Extended `BoardTaskRow` + `getBoardTasks` with `start_time`/`end_time`/`is_scheduled`.
- [x] `lib/tasks/widgets.server.ts` — pure composition + exported types.
- [x] `lib/tasks/widgets.functions.ts` — the three server fns.
- [x] Ran the pure logic for real; found and fixed a topic-tree cycle defect; mutation-proved it.
- [x] `npx tsc --noEmit` — result pasted under "Verification".
- [x] Committed (NOT pushed, NOT merged).

## Files touched

| file | change |
|---|---|
| `src/features/huddle/lib/tasks/tasks.server.ts` | **extended** (not forked): `BoardTaskRow` gains optional `start_time` / `end_time` / `is_scheduled`; both `getBoardTasks` SELECTs now include those three columns. |
| `src/features/huddle/lib/tasks/widgets.server.ts` | **new** — pure, dependency-free composition + all exported types. |
| `src/features/huddle/lib/tasks/widgets.functions.ts` | **new** — `getScheduleWidget`, `getPrioritiesWidget`, `updateWidgetTask`. |

Nothing else was touched. `data/seed.ts`, `store.ts`, `HuddleView.tsx`, `HuddleApp.tsx` and
`lib/tasks/tools.ts` were left alone (Lane C owns them).

## Observations from the specs

### SCHEDULE (`spec-schedule-widget.jpg`)
- `TODAY'S SCHEDULE` — rows `10:00AM <title>`, each with ▶ (start) and ✓ (done).
- `CURRENTLY DOING` — bold **"Nothing in progress"** when empty, with ✓ (done) and ⏸ (pause).
- `UP NEXT` — a highlighted `★ This Week` card; rows have a ★ bullet and a `▲ Today` toggle.

### PRIORITIES (`spec-priorities-widget.jpg`)
- Header + `Add a priority…` compose row (Lane C's UI).
- A **task band**: `<emoji?> <title>` + a category chip (`Life`, `Education`) + a `▲ Today` /
  `✓ Today` toggle (green when already today).
- A **topic tree** below it: top-level categories with counts (Career 25, Ventures 40,
  Education 20, Life 35, Family — no count) expanding to sub-topics with their own counts, some
  sub-topics having **no** count. Lane A's `get_task_topics`; Lane B only passes it through.

---

# THE EXACT PAYLOAD TYPES (Lane C: build against these)

All exported from `src/features/huddle/lib/tasks/widgets.server.ts`.

```ts
/** Raw ISO timestamps — the CLIENT formats "10:00AM". The server never pre-formats a clock time. */
export interface WidgetTaskRow {
  id: string;
  title: string;
  status: string | null;            // BACKLOG|TODO|READY|UP_NEXT|DOING|IN_REVIEW|DONE|BLOCKED|PLANNING
  category: string | null;          // LIFE|CAREER|VENTURES|EDUCATION or null -> the category chip
  isPriority: boolean;
  priorityRank: number | null;
  dueDate: string | null;           // ISO timestamptz
  startTime: string | null;         // ISO timestamptz (raw)
  endTime: string | null;
  isScheduled: boolean;
  tags: string[];
  assignedAgent: string | null;
  isToday: boolean;                 // -> `✓ Today` (green) vs `▲ Today` (grey)
}

export interface ScheduleWidgetData {
  ok: boolean;
  error?: string;                   // set only when ok === false; sections are then empty
  timeZone: string;                 // the IANA zone every boundary below was computed in
  todayKey: string;                 // local YYYY-MM-DD
  weekStartKey: string;             // Monday-start, inclusive
  weekEndKey: string;
  todaySchedule: WidgetTaskRow[];   // TODAY'S SCHEDULE, earliest start_time first
  currentlyDoing: WidgetTaskRow[];  // [] IS VALID -> render "Nothing in progress"
  upNext: WidgetTaskRow[];          // UP NEXT / This Week, de-duped against the two above
}

export interface TopicNode {
  id: string;
  name: string;
  parentId: string | null;          // null = top-level
  categoryAffinity: string | null;
  position: number | null;
  count: number | null;             // null is REAL: the spec shows sub-topics with no count
  children: TopicNode[];
}

export type TopicTreeReason = "ok" | "not-configured" | "tool-absent" | "error";

export interface TopicTreeResult {
  ok: boolean;
  roots: TopicNode[];               // [] is valid -> render the empty state, see `reason`
  reason: TopicTreeReason;
  error?: string;
}

export interface PrioritiesWidgetData {
  ok: boolean;                      // reflects the MIRROR read only
  error?: string;                   // a failed topic tree does NOT set this
  timeZone: string;
  todayKey: string;
  band: WidgetTaskRow[];            // open priority-lane tasks, journey's own ordering
  topics: TopicTreeResult;
}

export type WidgetTaskAction = "start" | "done" | "pause" | "today" | "untoday";

export interface WidgetActionResult {
  ok: boolean;
  error?: string;
  action: WidgetTaskAction;         // echoed, so an optimistic UI can reconcile
  taskId: string;
  status?: string;                  // present for start/done/pause; absent for today/untoday
  applied: boolean;                 // the write landed in JOURNEY; the mirror lags ~1-3s
}
```

## Server function signatures

From `src/features/huddle/lib/tasks/widgets.functions.ts` (TanStack `createServerFn`, POST):

```ts
getScheduleWidget({ data: { caller?, timeZone? } })   => Promise<ScheduleWidgetData>
getPrioritiesWidget({ data: { caller?, timeZone?, includeTopics? } }) => Promise<PrioritiesWidgetData>
updateWidgetTask({ data: { caller?, taskId, action, timeZone? } })    => Promise<WidgetActionResult>
```

- `caller` is the usual `{ entra_object_id?, entra_email? }`.
- `timeZone` is the BROWSER's IANA zone, optional: `resolveTimeZone` prefers the stored profile
  zone and falls back to this, then UTC. **Pass it** from the client — it is what makes "today"
  right for a caller with no stored profile zone.
- `includeTopics: false` skips journey's round-trip (band only). Default is to fetch topics.
- **None of the three ever throws.** Every failure is a normal return with `ok:false` + `error`.

## Lane C notes (behavior that is deliberate, not accidental)

1. **`currentlyDoing: []` is success.** Render "Nothing in progress"; do not show an error.
2. **`topics.roots: []` with `topics.reason` is success too.** `tool-absent` is the expected state
   until journey deploys Lane A. The band still renders — that was a hard requirement.
3. **The mirror is eventually consistent (~1-3s).** After a `updateWidgetTask` that returns
   `applied:true`, an immediate refetch can still show the OLD value. Apply an optimistic update
   or refetch after a beat. This lag is the documented pipeline behavior, not a bug.
4. **Parked tasks (`parking-lot` tag) and DONE/completed tasks never appear** in any section, in
   line with the standing rule that a parked task must not surface.
5. **`upNext` is de-duplicated** against `todaySchedule` and `currentlyDoing`, so one task never
   renders twice inside the SCHEDULE widget.
6. **`BLOCKED` tasks stay visible** (the board and standup both keep them); only DONE/completed
   are filtered.

---

# GROUND TRUTH — what was verified against real source, and how

Everything in this section was read from the file this session. Nothing here is recalled.

### 1. Mirror DDL — `tasks.journey_tasks` (`lib/tasks/tasks.server.ts`, BOOTSTRAP_SQL lines 29-53)
Confirmed present, with these exact types:
`id TEXT PK`, `user_id TEXT`, `user_email TEXT`, `title TEXT NOT NULL`, `description TEXT`,
`status TEXT`, `priority TEXT NOT NULL DEFAULT 'MEDIUM'`, `category TEXT`,
`is_priority BOOLEAN NOT NULL DEFAULT false`, `priority_rank INTEGER`, `due_date TIMESTAMPTZ`,
`start_time TIMESTAMPTZ`, `end_time TIMESTAMPTZ`, `is_scheduled BOOLEAN NOT NULL DEFAULT false`,
`pushed_count INTEGER`, `board_id TEXT`, `completed_at TIMESTAMPTZ`, `assigned_agent TEXT`,
`tags TEXT[] NOT NULL DEFAULT '{}'`, `definition_of_done TEXT`, `created_at`, `updated_at`,
`synced_at`. So every column the SCHEDULE widget needs already exists — no migration.

### 2. `getBoardTasks` did NOT select the scheduling columns — found by reading, not assuming
`BoardTaskRow` (tasks.server.ts:1561) and both SELECTs in `getBoardTasks` carried
`id,title,status,priority,category,is_priority,priority_rank,due_date,completed_at,
assigned_agent,tags,definition_of_done` — **no `start_time`, `end_time` or `is_scheduled`.**
So "TODAY'S SCHEDULE" was NOT reachable through the existing read as it stood.

Resolved by **extending** that read (the brief's instruction and CLAUDE.md's "Extend, don't
duplicate"), not by adding a second query: the three columns were added to both SELECTs, and
declared **optional** on `BoardTaskRow`. Optional is deliberate and follows the file's own
precedent — `artifacts?` is optional because `getOpenAssignedTasks` (the auto-work path) returns
`BoardTaskRow` without selecting it. The same is now true of the scheduling columns, so an
auto-work consumer is not told they are present when they are not.

**Upstream/downstream trace of that change** (it is a shared type):
- Producers of `BoardTaskRow`: `getBoardTasks` (now selects all three) and `getOpenAssignedTasks`
  (unchanged — does not select them, which is why they are optional).
- Consumers: `board.functions.ts` (passes rows through verbatim), `autowork.server.ts`
  (`import type { BoardTaskRow }`; reads status/tags/rank only), `standup.server.ts`,
  `BoardView.tsx` (Lane C). The change is **purely additive** — three new optional fields — so no
  consumer's existing field access changes meaning and none needed editing.
- `LIMIT 500 ORDER BY updated_at DESC` on `getBoardTasks` is unchanged and is therefore also the
  widgets' horizon. Worth knowing: on a board with >500 tasks the widgets see the 500
  most-recently-updated. **Not established** whether the real board exceeds 500 rows.

### 3. Email scoping — reused verbatim, not re-implemented
`getBoardTasks(email)` internally calls `resolveScopeByEmail(userEmail)` and filters
`lower(user_email) = ANY($1)` — the caller's whole alias SET. The read path resolves the email
with `resolveTaskEmail(caller) ?? caller.entra_email`, exactly as `board.functions.ts:18-21`,
`artifacts.functions.ts:15` and `confirm-ask.functions.ts:15-18` all do.

### 4. Timezone — `resolveTimeZone` exists and is the right edge (`lib/journey/identity.ts:145`)
`resolveTimeZone(caller, browserTimeZone)` → stored profile zone → browser zone → `"UTC"`, and its
own comment calls it "the ONE value every display edge should localize with". "Today"/"this week"
are computed in that zone via `Intl.DateTimeFormat(...).formatToParts`, **not** offset arithmetic,
so a DST transition inside the week cannot shift a row into the wrong day.

Proven by the run below: a task at `2026-09-13T02:00:00Z` (22:00 the previous day in
`America/New_York`) correctly lands in **today's** schedule, which naive UTC-date slicing would
have put on tomorrow.

### 5. journey `update_task` status enum — read from journey's own catalog
`journey-voice/supabase/functions/_shared/tool-definitions.ts`, `update_task.parameters.status.enum`:
```
["BACKLOG", "TODO", "READY", "UP_NEXT", "DOING", "IN_REVIEW", "DONE", "BLOCKED", "PLANNING"]
```
Also read there: `category.enum = ["LIFE","CAREER","VENTURES","EDUCATION"]`, and `tags` is
documented as **"Replaces existing tags"** (so the widget actions never send `tags` at all).

Button → tool mapping, every value from that file:

| button | tool | args |
|---|---|---|
| ▶ start | `update_task` | `{task_id, status:"DOING"}` |
| ✓ done | `update_task` | `{task_id, status:"DONE"}` |
| ⏸ pause | `update_task` | `{task_id, status:"UP_NEXT"}` |
| ▲ Today | `move_task_to_day` | `{task_id, date:"YYYY-MM-DD"}` (journey's scheduler picks the time) |
| ✓ Today (off) | `unschedule_task` | `{task_id}` |

`move_task_to_day` schema as read: `{task_id (req), date "Target date YYYY-MM-DD" (req), window?
enum[morning|business_hours|after_work|evening|weekends]}`. `unschedule_task`: `{task_id}` only.
`⏸ pause → UP_NEXT` is a **judgment call** among real enum values — UP_NEXT is the staged lane
immediately before DOING per CLAUDE.md's WIP flow, so pausing returns the task to the queue rather
than burying it in BACKLOG. Journey does not define a "paused" status; **not established** that
UP_NEXT is what journey's own Android widget writes for ⏸.

### 6. No second writer, and no allow-list in the way
`huddle-proxy/index.ts` (237 lines) has **no tool allow-list** — it forwards any `toolName`
straight to `execute-tool` (lines 197-211), so `move_task_to_day` and `unschedule_task` are
reachable from Huddle today. Verified by reading the whole dispatch path, not inferred.

Response envelope, read at `huddle-proxy/index.ts:221-229`:
```ts
const ok = !!exec.success;
const payload = ok ? (exec.result ?? exec.message ?? {}) : { error: exec.error ?? "tool failed" };
return json({ ok, output: typeof payload === "string" ? payload : JSON.stringify(payload), ... });
```
So `output` is **always a string** and must be `JSON.parse`d before use — which the topic
passthrough does, falling back to `reason:"error"` on non-JSON rather than throwing.

All writes go to journey (`public.tasks`, canonical) via `invokeJourneyTool`; the mirror is never
written. This is the same shape as the two existing writers (`board.functions.ts:72-80`,
`confirm-ask.functions.ts:655-662`), so there is no new write path.

### 7. Ownership gate — reused the repo's existing primitive
`updateWidgetTask` calls `getOwnedTaskForConfirmAsk(taskId, email)` (tasks.server.ts:1331) before
any write. It filters `t.id = $1 AND lower(t.user_email) = ANY($2)` and returns null for "doesn't
exist" and "not yours" **indistinguishably**, so a guessed id cannot be used to probe.

This matters: `board.functions.ts`'s `updateBoardTask` does **no** ownership check, and
`confirm-ask.functions.ts:7-9` says why that was a gap — "`tasks.journey_tasks` /
`tasks.task_engagement_state` have no per-row access control below this layer, so a
forged/guessed taskId must be rejected HERE." A widget button is the same exposure, so it gets the
same gate.

### 8. Lane A's topic tool — shape NOT yet published, so the passthrough is defensive
`/home/user/journey-voice/docs/LANE-A-get-task-topics.md` exists and records the **tables and
columns** it reads, but its checklist still has "Implement + register" **unchecked**, so there is
no final response envelope to code against. Established from that doc:
- The topics live in **`task_topic_index`** itself (its own correction to its brief), columns
  `id, user_id, topic_name, position, category_affinity, parent_topic_id, window_affinity`.
- `task_topic_mappings (task_id, topic_id)` joins topics to tasks — i.e. per-topic counts are
  derivable, which is what the spec's `25`/`40`/`2` numbers are.
- `category_affinity` can be **null**; `parent_topic_id` null ⇒ top-level; `window_affinity` is an
  **array**.

So `buildTopicTree` accepts **either** a pre-nested tree **or** the flat `parent_topic_id` shape,
and tolerates key-name variation (`topic_name|name|label|title`, `count|task_count|open_count|…`).
**Not established:** the tool's actual wrapper key, whether it returns counts at all, and whether
it nests. If Lane A's final shape differs, only `findTopicArray`/`toTopicNode` need adjusting — the
`TopicNode` type Lane C builds against does not.

---

# Verification

## `npx tsc --noEmit -p tsconfig.json`

```
src/features/huddle/components/HuddleView.tsx(82,37): error TS2322: Type 'View' is not assignable to type '"board" | "huddle" | "artifacts"'.
  Type '"schedule"' is not assignable to type '"board" | "huddle" | "artifacts"'.
EXIT:2
```

**One error, and it is NOT Lane B's.** It comes from Lane C's in-flight change to
`src/features/huddle/store.ts`, which widened `export type View` to
`"huddle" | "board" | "artifacts" | "priorities" | "schedule"` (store.ts:26) while
`HuddleView.tsx:82` still narrows to the old three. Both files are Lane C's and I am forbidden to
edit them. Attribution evidence: `git status` shows `store.ts` modified (35 insertions) with
`docs/LANE-C-widget-ui.md` present, and my changes touch neither `View` nor `HuddleView`.

**Errors in Lane B's files: 0** — measured with
`npx tsc --noEmit -p tsconfig.json 2>&1 | grep -cE "widgets\.(server|functions)\.ts|tasks\.server\.ts"` → `0`.

So the typecheck does not currently exit 0 on the branch, and it will not until Lane C's
`HuddleView.tsx` catches up to its own `store.ts`. That is the honest status: **Lane B is clean;
the tree is not.**

## Behavioral run of the pure composition (`bun`, zero API spend)

Fixture: 10 rows, `America/New_York`, now = `2026-09-12T14:00:00Z` (Sat, 10:00 EDT).

```
todayKey 2026-09-12 week 2026-09-07 -> 2026-09-13
todaySchedule [[a, 2026-09-12T14:00:00Z, true], [b, 2026-09-12T15:30:00Z, true], [i, 2026-09-13T02:00:00Z, true]]
currentlyDoing [c]
upNext [d, e]
EMPTY doing -> []
band [[d, true, 1]]
weekBounds(Sunday 2026-09-13) { weekStartKey: "2026-09-07", weekEndKey: "2026-09-13" }
badTZ -> UTC | null date -> null
nested tree [[Life, 1]]
garbage -> [] [] []
cycle -> [x, y]
ACTION_STATUS { start: "DOING", done: "DONE", pause: "UP_NEXT" }
```

What each line proves:
- `todaySchedule` ordered by time, and row **`i` (02:00Z = 22:00 EDT the prior day) is correctly
  TODAY** — the timezone handling is real, not nominal. Row `z` (tomorrow) is excluded.
- `currentlyDoing [c]`, and `[]` when no DOING row exists — the expected empty state.
- `upNext [d, e]`: `d` (priority lane) and `e` (due Fri, inside the week). Excluded: `f` (due next
  week), `g` (parking-lot), `h` (DONE), and `a`/`b`/`c` (already shown above — de-dup works).
- `band [[d, true, 1]]` — only the priority-lane row; parked and DONE rows dropped.
- `weekBounds("2026-09-13")` (a Sunday) → Mon 09-07..Sun 09-13, i.e. Sunday is the END of its
  week, not the start of the next.
- `badTZ -> UTC` — an invalid IANA name degrades instead of throwing a RangeError per row.
- `garbage -> [] [] []` — a string, null, and an unrecognized object all yield an empty tree.

Flat-tree normalization, from Lane A's proven column names:
```json
[{"id":"1","name":"Career","parentId":null,"categoryAffinity":"CAREER","position":1,"count":25,
  "children":[{"id":"2","name":"Presentation Development","parentId":"1","position":1,"count":2,"children":[]},
              {"id":"3","name":"Grooming Management","parentId":"1","position":2,"count":null,"children":[]}]},
 {"id":"9","name":"Orphan","parentId":"missing","position":null,"count":null,"children":[]}]
```
This reproduces the spec's structure (Career 25 → Presentation Development 2, Grooming Management
with **no** count), and the orphan whose parent is absent is **promoted to a root rather than
dropped**.

## A real defect this run found, and the mutation proof of its fix

The first run printed **`cycle -> []`**: two topics naming each other as parent were each attached
to the other, so **neither** reached `roots` and **both silently disappeared**. Fixed by
`hasAncestorCycle`, which promotes a node in a parent loop to a root.

Mutation-proved (anchor asserted to match **exactly once** before mutating):

| step | result |
|---|---|
| baseline | `PASS cycle-guard: both topics preserved` (exit 0) |
| mutation — deleted `&& !hasAncestorCycle(n, byId)` | `FAIL cycle-guard: expected both topics preserved as roots, got []` (exit 1) |
| restore | anchor back in source (grep count 1), `PASS` (exit 0) |

Outcome: **FIRED** — the guard is real, not inert. The restore was asserted, not assumed.

The assertion test, for re-running (it lives in the scratchpad, not the repo, because `scripts/`
is outside Lane B's ownership):

```ts
import { buildTopicTree } from "src/features/huddle/lib/tasks/widgets.server";
const out = buildTopicTree([
  { id: "x", topic_name: "X", parent_topic_id: "y" },
  { id: "y", topic_name: "Y", parent_topic_id: "x" },
]);
const ids = out.map((n) => n.id).sort().join(",");
if (ids !== "x,y") { console.error(`FAIL cycle-guard: got [${ids}]`); process.exit(1); }
console.log("PASS cycle-guard: both topics preserved");
```

## NOT verified — stated plainly

- **No live DB or live journey call was made.** TCP 5432 is blocked from a CCR session and the
  session holds no Azure/PG creds (CLAUDE.md), and `JOURNEY_PROXY_URL`/`TOKEN` are not in this
  environment. So the SQL was verified against the **DDL as written in source**, and the tool
  args against **journey's own tool definitions**, not against a live round-trip. Status:
  **mechanism verified offline, NOT confirmed live.**
- **`get_task_topics` has never been called** — it does not exist yet. The `tool-absent` branch is
  therefore reasoned from `execute-tool`'s error wording, not observed. If journey words an
  unknown tool differently, the result degrades to `reason:"error"` instead of `"tool-absent"` —
  the tree is still empty and the widget still renders, so the failure mode is cosmetic.
- **Whether ⏸ pause should write `UP_NEXT`** — a defensible pick among journey's real enum values,
  not a fact read from journey's Android widget.
- **Whether the live board exceeds `getBoardTasks`'s existing `LIMIT 500`.**
