// WHAT:       Pure composition layer for the two in-chat journey widgets (SCHEDULE, PRIORITIES).
//             Turns the EXISTING Azure-mirror board read (getBoardTasks) into the three schedule
//             sections + the priorities band, and normalizes journey's topic tree into a nested
//             shape the UI can render.
// WHY:        The widgets need day/week-bounded, timezone-correct slices of data that already
//             exists in `tasks.journey_tasks`. Building a SECOND query layer for them would fork
//             the mirror read (CLAUDE.md "Extend, don't duplicate" + single-writer read-model),
//             so the slicing is done here, in memory, off the one existing board read.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/LANE-B-widget-data.md (DDL + tool schemas quoted as read); specs at
//             docs/widgets/spec-schedule-widget.jpg and docs/widgets/spec-priorities-widget.jpg.
//
// DELIBERATELY DEPENDENCY-FREE: no `pg`, no journey fetch, no server-only import. Everything here
// is a pure function of its arguments so it is unit-testable offline (the cheap inner loop this
// repo's CLAUDE.md asks for) and so the widget server fns stay thin.

import type { BoardTaskRow } from "./tasks.server";

// ---------------------------------------------------------------------------
// Exported payload types — Lane C builds the UI against EXACTLY these.
// ---------------------------------------------------------------------------

/**
 * One task as a widget row. A flat, camelCase projection of the mirror columns the widgets
 * actually render — nothing more, so the payload is not the whole board row.
 *
 * `startTime`/`endTime`/`dueDate` are RAW ISO timestamps (the mirror's TIMESTAMPTZ verbatim).
 * The client formats them ("10:00AM" in the spec); the server never pre-formats a clock time,
 * because the widget renders in the viewer's locale.
 */
export interface WidgetTaskRow {
  id: string;
  title: string;
  /** journey status verbatim: BACKLOG|TODO|READY|UP_NEXT|DOING|IN_REVIEW|DONE|BLOCKED|PLANNING. */
  status: string | null;
  /** journey category: LIFE|CAREER|VENTURES|EDUCATION, or null. Drives the category chip. */
  category: string | null;
  isPriority: boolean;
  priorityRank: number | null;
  /** ISO timestamp or null. */
  dueDate: string | null;
  /** ISO timestamp or null — raw; the client formats the clock time. */
  startTime: string | null;
  endTime: string | null;
  isScheduled: boolean;
  tags: string[];
  assignedAgent: string | null;
  /**
   * True when this task already sits on TODAY in the user's timezone — scheduled with a
   * `start_time` today, or due today. Drives the toggle's two states in both specs:
   * `✓ Today` (green, already today) vs `▲ Today` (grey, tap to move it to today).
   */
  isToday: boolean;
}

/** The SCHEDULE widget's payload — the three sections in the spec, top to bottom. */
export interface ScheduleWidgetData {
  ok: boolean;
  /** Populated only when `ok` is false. The sections are then empty — this never throws. */
  error?: string;
  /** The IANA zone every date boundary below was computed in (from resolveTimeZone). */
  timeZone: string;
  /** Local `YYYY-MM-DD` of "today" in `timeZone`. */
  todayKey: string;
  /** Local `YYYY-MM-DD` bounds of the current week, Monday-start, both inclusive. */
  weekStartKey: string;
  weekEndKey: string;
  /** `TODAY'S SCHEDULE`: is_scheduled rows whose start_time falls today, earliest first. */
  todaySchedule: WidgetTaskRow[];
  /**
   * `CURRENTLY DOING`: status = 'DOING'.
   * AN EMPTY ARRAY IS A VALID, EXPECTED RESULT — the spec renders "Nothing in progress".
   * Never treat empty as an error.
   */
  currentlyDoing: WidgetTaskRow[];
  /**
   * `UP NEXT` / "This Week": priority-lane tasks (is_priority or priority_rank) plus anything
   * due inside the current week. De-duplicated against the two sections above so a task is
   * never rendered twice in one widget.
   */
  upNext: WidgetTaskRow[];
}

/** One node of journey's priorities topic tree. */
export interface TopicNode {
  id: string;
  name: string;
  /** null = top-level. */
  parentId: string | null;
  /** journey's `category_affinity`; null when it supplies none (proven nullable — Lane A). */
  categoryAffinity: string | null;
  /** journey's `position` (its own ordering), or null. */
  position: number | null;
  /** Task count journey reports for this topic; null when it reports none (the spec shows
   *  sub-topics both with and without a count, so null is a real, renderable state). */
  count: number | null;
  children: TopicNode[];
  /**
   * The tasks that belong to this node, already ordered (`byPriorityThenDue`) and already filtered
   * to live, unparked work. **Always present — `[]`, never undefined** — so the renderer needs no
   * guard and a node that simply holds no tasks is indistinguishable from one built before this
   * field existed.
   *
   * The TASKS always come from the mirror Huddle already reads, never from journey: journey's
   * `get_task_topics` (deployed 2026-10-15, journey-voice#42) returns only topics and task->topic
   * LINKS, and `buildPrioritiesTree` hangs the mirror's rows on them. The read paths that DO return
   * tasks were rejected on measurement: `get_tasks` caps at `.limit(50)` of 101 open tasks, and
   * `get_tasks_by_topic` costs one call per topic, orders by the `priority` TEXT column (MEDIUM above
   * HIGH), drops BLOCKED, and answers `success:true, count:0` for a duplicated topic name.
   */
  tasks: WidgetTaskRow[];
}

/**
 * The state of journey's topic read (`get_task_topics`, DEPLOYED 2026-10-15 via journey-voice#42).
 * It decides only whether the SUB-CATEGORY layer appears: the category rows always render from the
 * mirror. Every failure is a renderable degraded state, never an exception:
 *  - `ok`             — journey answered; the tree has its topics.
 *  - `not-configured` — JOURNEY_PROXY_URL/TOKEN absent in this environment.
 *  - `tool-absent`    — the proxy answered but does not know the tool (a journey rollback, or an
 *                       environment pointed at a journey without #42).
 *  - `error`          — anything else (network, non-JSON, timeout).
 */
export type TopicTreeReason = "ok" | "not-configured" | "tool-absent" | "error";

export interface TopicTreeResult {
  ok: boolean;
  /** Top-level nodes, children nested. Empty is valid — see `reason`. */
  roots: TopicNode[];
  reason: TopicTreeReason;
  /** Human-readable detail for the empty state. Never thrown. */
  error?: string;
}

/** The PRIORITIES widget's payload — the task band plus journey's topic tree. */
export interface PrioritiesWidgetData {
  ok: boolean;
  /** Populated only when the MIRROR read failed. A failed topic tree does NOT set this — the
   *  band must still render (half the widget works before journey deploys anything). */
  error?: string;
  timeZone: string;
  todayKey: string;
  /** The task band: open priority-lane tasks, highest priority first. */
  band: WidgetTaskRow[];
  /** Journey's topic tree via the proxy. Degrades to `{roots: [], reason}` — never throws. */
  topics: TopicTreeResult;
}

/** The five widget buttons, as one closed set. */
export type WidgetTaskAction = "start" | "done" | "pause" | "reopen" | "today" | "untoday";

export interface WidgetActionResult {
  ok: boolean;
  error?: string;
  /** Echoed so an optimistic UI can reconcile which button's request this answers. */
  action: WidgetTaskAction;
  taskId: string;
  /**
   * The journey status this action wrote, when it wrote one (start/done/pause). Absent for the
   * today/untoday toggle, which changes the SCHEDULE, not the status.
   */
  status?: string;
  /**
   * True when the write landed. The mirror behind every read above is EVENTUALLY CONSISTENT
   * (journey → pg_net → webhook → mirror, ~1-3s): a widget refetch immediately after an action
   * can still show the old value. That lag is expected, not a bug — the client should either
   * apply an optimistic update or refetch after a beat.
   */
  applied: boolean;
}

// ---------------------------------------------------------------------------
// Timezone-correct date keys
// ---------------------------------------------------------------------------

/**
 * A timezone we can actually format in. An unknown/garbage IANA name makes Intl throw a
 * RangeError, which would take out every date comparison below — so it is validated once here
 * and degraded to UTC, rather than caught per-row.
 */
export function safeTimeZone(tz: string | null | undefined): string {
  const candidate = (tz ?? "").trim();
  if (!candidate) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
}

/**
 * The LOCAL calendar date of an instant, as `YYYY-MM-DD`, in the given zone. Returns null for a
 * null/unparseable input.
 *
 * Why `Intl` and not offset arithmetic: the mirror stores TIMESTAMPTZ (absolute instants), and
 * "does this fall today" is a question about the USER's calendar day. Intl resolves the zone's
 * real offset for that specific instant, so a DST boundary inside the week can't shift a row into
 * the wrong day — which hand-rolled `getTimezoneOffset()` maths gets wrong twice a year.
 */
export function localDateKey(value: string | number | Date | null | undefined, timeZone: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (!y || !m || !day) return null;
    return `${y}-${m}-${day}`;
  } catch {
    return null;
  }
}

/**
 * The Monday-start week (both ends inclusive) containing a `YYYY-MM-DD` key, as two keys.
 *
 * Date keys are compared LEXICALLY everywhere below (`start <= key && key <= end`), which is exact
 * for zero-padded ISO dates and needs no further timezone maths — the keys are already local.
 * The arithmetic here runs on UTC midnight of a pure calendar date, so it never crosses a zone.
 */
export function weekBounds(todayKey: string): { weekStartKey: string; weekEndKey: string } {
  const ms = Date.parse(`${todayKey}T00:00:00Z`);
  if (!Number.isFinite(ms)) return { weekStartKey: todayKey, weekEndKey: todayKey };
  const dow = new Date(ms).getUTCDay(); // 0 = Sunday
  const backToMonday = (dow + 6) % 7; // Monday = 0 … Sunday = 6
  const DAY = 86_400_000;
  const startMs = ms - backToMonday * DAY;
  return {
    weekStartKey: new Date(startMs).toISOString().slice(0, 10),
    weekEndKey: new Date(startMs + 6 * DAY).toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Board row → widget row
// ---------------------------------------------------------------------------

/** Statuses that mean "no longer live work". Kept out of every widget section. */
const CLOSED_STATUSES = new Set(["DONE"]);

/** A task the user deliberately set aside must never surface in a widget (same rule the ceremony
 *  read enforces at source in getStandupTasks). */
export const PARKING_LOT_TAG = "parking-lot";

function upper(s: string | null | undefined): string {
  return (s ?? "").trim().toUpperCase();
}

export function isParked(row: BoardTaskRow): boolean {
  return (row.tags ?? []).some((t) => String(t).toLowerCase() === PARKING_LOT_TAG);
}

/**
 * THE ONE park-tag union. journey's `update_task` REPLACES the tag array ("Replaces existing tags."
 * — journey-voice `_shared/tool-definitions.ts`), so every parking write must send existing + the
 * tag, or it silently wipes every other label the task carries (blocked, reminder, quick-win…).
 *
 * Both park paths call this: `confirm-ask.functions.ts`'s Park button (the original implementation,
 * which this is extracted from) and `widgets.functions.ts`'s ⏸ pause. Two inline copies had already
 * drifted apart on case handling (VERIFY-journey-widgets-2.md N-3, and N-2 which fell out of it).
 *
 * IT APPENDS THE EXACT LOWERCASE TAG even when a differently-cased one is present. That looks like a
 * duplicate and is not: `autowork.server.ts:533`, `groom.ts:121` and `scoring.ts:137` all filter with
 * an EXACT `.includes("parking-lot")`, so a task carrying only `Parking-Lot` reads as parked in the
 * UI while remaining an automation candidate — N-2. Writing the canonical form is what actually
 * parks it; the odd-cased tag is left untouched because it is the user's data, not ours to rewrite.
 */
export function withParkingLotTag(existing: readonly unknown[] | null | undefined): string[] {
  const tags = (existing ?? []).map((t) => String(t));
  return tags.includes(PARKING_LOT_TAG) ? tags : [...tags, PARKING_LOT_TAG];
}

/**
 * Open = the STATUS is not closed. (BLOCKED stays visible: a blocked item is still live work the user
 * may want to see, and the board and standup both keep it.)
 *
 * STATUS IS THE SOURCE OF TRUTH; `completed_at` IS NOT. This used to return false for any row that
 * had a `completed_at`. journey keeps that date when a task is REOPENED, so a task the owner had
 * finished and then brought back stayed hidden from every widget section while his phone showed it.
 * Measured on his journey board, 2026-10-15: 6 tasks have a live status (UP_NEXT or BACKLOG) and an
 * old completed_at, among them "Complete 2 MIT assignments" (UP_NEXT), which his phone widget
 * shows. Found by an independent verifier comparing Huddle's tree with the phone, category by
 * category. Completing a task sets status DONE, which CLOSED_STATUSES still excludes.
 */
export function isOpen(row: BoardTaskRow): boolean {
  return !CLOSED_STATUSES.has(upper(row.status));
}

/**
 * Is this task shown in the CATEGORY / TOPIC TREE? The owner's phone's rule, exactly:
 * `status=not.in.(DONE,BLOCKED)` (SupabaseTaskClient.getTasksForTopics), with no parking filter.
 *
 * DELIBERATELY DIFFERENT FROM `isOpen`, which the This Week band and the schedule use. Owner,
 * 2026-10-15, after the tree's counts were compared with his Android widget and did not match (Life
 * 15 vs 18, Ventures 57 vs 66): "why dont life and ventures line up and why are you pushing past it
 * instead of fixing it?" The three differences were ones I had chosen, not ones he asked for:
 *   - PARKED tasks: the phone shows them, and the tree hid them. 15 of the 21 missing tasks.
 *   - BLOCKED tasks: the phone hides them, and the tree showed them.
 *   - Tasks linked to NO topic: the phone hides them (see buildPrioritiesTree), and the tree showed them.
 * Measured with docs/verify-subcategories-1/compare.ts on his real data before and after.
 */
export function isTreeLive(row: BoardTaskRow): boolean {
  const s = upper(row.status);
  return s !== "DONE" && s !== "BLOCKED";
}

/** Project one mirror board row into the widget row shape, resolving `isToday` in `timeZone`. */
export function toWidgetRow(row: BoardTaskRow, timeZone: string, todayKey: string): WidgetTaskRow {
  const startTime = row.start_time ?? null;
  const dueDate = row.due_date ?? null;
  const isScheduled = row.is_scheduled === true;
  const startKey = localDateKey(startTime, timeZone);
  const dueKey = localDateKey(dueDate, timeZone);
  return {
    id: row.id,
    title: row.title,
    status: row.status ?? null,
    category: row.category ?? null,
    isPriority: row.is_priority === true,
    priorityRank: row.priority_rank ?? null,
    dueDate,
    startTime,
    endTime: row.end_time ?? null,
    isScheduled,
    tags: row.tags ?? [],
    assignedAgent: row.assigned_agent ?? null,
    isToday: (isScheduled && startKey === todayKey) || dueKey === todayKey,
  };
}

// ---------------------------------------------------------------------------
// SCHEDULE widget composition
// ---------------------------------------------------------------------------

/** Priority-lane ordering, matching journey's own (`is_priority.desc, priority_rank.asc.nullslast`,
 *  read from Lane A's proven REST query), then soonest-due, then title for a stable result. */
function byPriorityThenDue(a: WidgetTaskRow, b: WidgetTaskRow): number {
  if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
  const ar = a.priorityRank ?? Number.POSITIVE_INFINITY;
  const br = b.priorityRank ?? Number.POSITIVE_INFINITY;
  if (ar !== br) return ar - br;
  const ad = a.dueDate ? Date.parse(a.dueDate) : Number.POSITIVE_INFINITY;
  const bd = b.dueDate ? Date.parse(b.dueDate) : Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  // `|| id` makes this a TOTAL order. Without it the comparator returns 0 for two rows agreeing on
  // star, rank, due date AND title, so their order falls through to `getBoardTasks`' own
  // `ORDER BY updated_at DESC` and FLIPS whenever either row is touched.
  //
  // Not hypothetical — MEASURED on the owner's live mirror by an independent verifier, which asked
  // the database directly whether any real pair ties:
  //     Prepare my office camera quality              | n=2 | distinct_sort_keys=1
  //     Research someone to install brakes and rotors | n=2 | distinct_sort_keys=1
  // The first is visible in his Life & Personal list. Duplicate titles are ordinary on a board fed
  // by an agent, so this is a steady-state condition, not an edge case.
  //
  // It matters most for the thing the tree is FOR: "so if an agent in the future is asked to
  // autopull one or two from the categories it knows whats next." A next-up that reorders itself
  // when an unrelated field is written is not an answer. `id` is the mirror's primary key, so it is
  // unique by construction and the order is now stable across reads.
  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

/**
 * Split the board rows into the SCHEDULE widget's three sections.
 *
 * Pure: `nowMs` is passed in rather than read from the clock, so the sectioning is deterministic
 * and testable. All three sections drop parked and closed tasks first.
 */
export function buildScheduleSections(
  rows: BoardTaskRow[],
  timeZone: string,
  nowMs: number,
): Pick<ScheduleWidgetData, "todayKey" | "weekStartKey" | "weekEndKey" | "todaySchedule" | "currentlyDoing" | "upNext"> {
  const tz = safeTimeZone(timeZone);
  const todayKey = localDateKey(nowMs, tz) ?? new Date(nowMs).toISOString().slice(0, 10);
  const { weekStartKey, weekEndKey } = weekBounds(todayKey);

  const live = rows.filter((r) => isOpen(r) && !isParked(r));
  const widgetRows = live.map((r) => toWidgetRow(r, tz, todayKey));

  // TODAY'S SCHEDULE — scheduled, with a start_time landing on today's local date. Earliest first
  // (the spec lists 10:00AM, 11:30AM, 12:30PM in order).
  const todaySchedule = widgetRows
    .filter((r) => r.isScheduled && localDateKey(r.startTime, tz) === todayKey)
    .sort((a, b) => (Date.parse(a.startTime ?? "") || 0) - (Date.parse(b.startTime ?? "") || 0));

  // CURRENTLY DOING — status DOING. Empty is the expected "Nothing in progress" state.
  const currentlyDoing = widgetRows.filter((r) => upper(r.status) === "DOING").sort(byPriorityThenDue);

  // UP NEXT / This Week — the priority lane plus anything due inside the current week. De-duped
  // against the sections above so one task never appears twice in the same widget.
  const shown = new Set<string>([...todaySchedule, ...currentlyDoing].map((r) => r.id));
  const upNext = widgetRows
    .filter((r) => {
      if (shown.has(r.id)) return false;
      if (r.isPriority || r.priorityRank !== null) return true;
      const dueKey = localDateKey(r.dueDate, tz);
      return !!dueKey && dueKey >= weekStartKey && dueKey <= weekEndKey;
    })
    .sort(byPriorityThenDue);

  return { todayKey, weekStartKey, weekEndKey, todaySchedule, currentlyDoing, upNext };
}

/**
 * Apply the user's explicit This Week ordering on top of journey's computed one.
 *
 * WHY A SEPARATE LIST RATHER THAN WRITING `priority_rank`. `priority_rank` is the obvious place to
 * put "the order", and it is the wrong place: grooming REWRITES it wholesale every Monday
 * (`groom.ts:206` — "Normalize ranks to a dense 1..N ordering… include every task id exactly once",
 * capped at `SCHEDULED_MAX = 80`, which is exactly the `max(priority_rank)` measured on live data).
 * An order stored there is erased weekly. Tags are no safer: `groom.ts:225` replaces the tag array
 * and preserves only `CONTROL_TAGS`. So the user's ordering lives in a Huddle-owned list that
 * grooming cannot reach.
 *
 * SPARSE BY DESIGN. `pinned` holds only the ids the user has explicitly placed. Anything not in it
 * keeps journey's ordering underneath, so a fresh user sees the computed order and only the rows
 * they actually moved are pinned. Ids that have since left the band (unstarred, closed, parked) are
 * simply absent from `rows` and drop out here — no pruning pass, no stale-id handling.
 */
export function applyWeekOrder(rows: WidgetTaskRow[], pinned: readonly string[]): WidgetTaskRow[] {
  if (!pinned.length) return rows;
  const rank = new Map<string, number>();
  pinned.forEach((id, i) => {
    if (id && !rank.has(id)) rank.set(id, i);
  });
  // Stable: equal keys keep their incoming (byPriorityThenDue) order, so unpinned rows are not
  // reshuffled among themselves.
  return rows
    .map((row, i) => ({ row, i, pin: rank.get(row.id) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.pin !== b.pin ? a.pin - b.pin : a.i - b.i))
    .map((e) => e.row);
}

/** The PRIORITIES widget's task band: open priority-lane tasks, journey's own ordering, with the
 *  user's explicit This Week order applied on top. `order` is the sparse pin list — see
 *  `applyWeekOrder` for why it is not `priority_rank`. */
export function buildPrioritiesBand(
  rows: BoardTaskRow[],
  timeZone: string,
  nowMs: number,
  order: readonly string[] = [],
): WidgetTaskRow[] {
  const tz = safeTimeZone(timeZone);
  const todayKey = localDateKey(nowMs, tz) ?? new Date(nowMs).toISOString().slice(0, 10);
  const band = rows
    .filter((r) => isOpen(r) && !isParked(r))
    .filter((r) => r.is_priority === true || r.priority_rank !== null)
    .map((r) => toWidgetRow(r, tz, todayKey))
    .sort(byPriorityThenDue);
  return applyWeekOrder(band, order);
}

// ---------------------------------------------------------------------------
// Topic tree normalization (journey's `get_task_topics` — Lane A)
// ---------------------------------------------------------------------------

const MAX_TREE_DEPTH = 8;

function firstString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function firstNumber(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function firstWindowAffinity(o: Record<string, unknown>): string | null {
  const w = o.window_affinity ?? o.windowAffinity;
  if (!Array.isArray(w)) return null;
  for (const v of w) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function firstArray(o: Record<string, unknown>, keys: string[]): unknown[] | null {
  for (const k of keys) {
    const v = o[k];
    if (Array.isArray(v)) return v;
  }
  return null;
}

/**
 * Find the topic array inside whatever journey returns. `get_task_topics` returns
 * `{topics, mappings}` (journey-voice#42), which the `topics` key below matches directly. The wider
 * set of keys and the one level of nesting predate that tool and are kept, because a tolerant reader
 * costs nothing. Anything it cannot find becomes an empty tree with a reason, never a throw.
 */
export function findTopicArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  const direct = firstArray(o, ["topics", "topic_groups", "topicGroups", "groups", "nodes", "items", "tree", "roots"]);
  if (direct) return direct;
  for (const k of ["result", "data", "output", "payload"]) {
    const v = o[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      const nested = firstArray(v as Record<string, unknown>, [
        "topics", "topic_groups", "topicGroups", "groups", "nodes", "items", "tree", "roots",
      ]);
      if (nested) return nested;
    }
  }
  return null;
}

/** Map one raw entry to a TopicNode, recursing into an already-nested children array if present. */
function toTopicNode(raw: unknown, depth: number): TopicNode | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = firstString(o, ["topic_name", "topicName", "name", "label", "title"]);
  const id = firstString(o, ["id", "topic_id", "topicId"]) ?? name;
  if (!id || !name) return null;
  const nestedRaw = depth < MAX_TREE_DEPTH ? firstArray(o, ["children", "topics", "subtopics", "sub_topics"]) : null;
  const children: TopicNode[] = [];
  for (const child of nestedRaw ?? []) {
    const node = toTopicNode(child, depth + 1);
    if (node) children.push(node);
  }
  return {
    id,
    name,
    parentId: firstString(o, ["parent_topic_id", "parentTopicId", "parent_id", "parentId"]),
    // The owner's Android widget rule, read from PrioritiesWidgetFactory.rebuildItems:
    // `categoryAffinity ?: windowAffinity?.firstOrNull()`. Without the fallback, a topic placed by
    // its window alone lands in no category here while his phone files it under one.
    categoryAffinity:
      firstString(o, ["category_affinity", "categoryAffinity", "category"]) ?? firstWindowAffinity(o),
    position: firstNumber(o, ["position", "order", "sort_order"]),
    count: firstNumber(o, ["count", "task_count", "taskCount", "open_count", "openCount", "n", "total"]),
    children,
    // journey's payload never carries a topic's tasks (see TopicNode.tasks). The mirror supplies
    // them, merged in by mergeTopicTree, so a parsed topic node starts empty rather than undefined.
    tasks: [],
  };
}

/**
 * journey MERGES raw category keys into DISPLAY categories. Six keys collapse to five rows.
 *
 * Read from journey's live Priorities view, `claude/priority-widget-nesting-1jtwa9` commit
 * `f0ab561` — `CATEGORY_DISPLAY_MAP` / `CATEGORY_LABELS` / `DISPLAY_CATEGORIES`. That branch is
 * **NOT on journey's `origin/main` and is nevertheless what the owner is looking at**: `main`
 * renders one row per raw config key (six, no Family), while the branch renders exactly the five in
 * his screenshot — Career, Ventures, Education, Life, Family — and FAMILY holds no rows in
 * `task_topic_index`, which is why that row carries no count. journey's repo has a truncated
 * history, so `git log origin/main` cannot be used to argue a thing was never shipped.
 *
 * An earlier version of this file mapped one label per raw key (a separate "Personal" row and a
 * separate "Prof. Education" row). That is what `main` does and it is NOT what the owner sees.
 */
const CATEGORY_DISPLAY_MAP: Record<string, string> = {
  LIFE: "LIFE",
  PERSONAL: "LIFE",
  CAREER: "CAREER",
  VENTURES: "VENTURES",
  EDUCATION: "EDUCATION",
  PROF_EDUCATION: "EDUCATION",
  FAMILY: "FAMILY",
};

/** The fixed order journey renders known categories in (`DISPLAY_CATEGORIES`, f0ab561:46).
 *  Anything not in here is a DYNAMIC category and is appended alphabetically after these — the
 *  "hybrid dynamic category detection" of `532da6b`, which exists so an unknown key passes through
 *  instead of being silently dropped. Keep that property: this is an ORDERING, not an allow-list. */
const DISPLAY_CATEGORY_ORDER = ["LIFE", "CAREER", "VENTURES", "EDUCATION", "FAMILY"] as const;

const CATEGORY_LABELS: Record<string, string> = {
  LIFE: "Life & Personal",
  CAREER: "Career",
  VENTURES: "Ventures",
  EDUCATION: "Education",
  FAMILY: "Family",
};

/** Raw `category_affinity` → the display bucket it renders in. `PROF_EDUCATION` → `EDUCATION`,
 *  `PERSONAL` → `LIFE`. An unknown key is its own bucket rather than being dropped. */
export function displayCategory(key: string): string {
  const k = key.toUpperCase();
  return CATEGORY_DISPLAY_MAP[k] ?? k;
}

/** `LIFE` → `Life & Personal`; an unknown `SIDE_HUSTLE` → `Side Hustle`. */
export function categoryLabel(key: string): string {
  const k = key.toUpperCase();
  const known = CATEGORY_LABELS[k];
  if (known) return known;
  return k
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Synthetic category roots are ids, not topics — prefixed so they can never collide with a
 *  journey topic uuid, and so a click handler can tell them apart. */
export const CATEGORY_ROOT_PREFIX = "category:";

/**
 * Wrap already-nested topic roots in synthetic CATEGORY roots.
 *
 * journey's tree is FOUR levels — `category > group > sub-group > task`
 * (journey-voice `f0ab561`, "fix: priority widget proper nesting with category > group > sub-group >
 * task tree"). Category is the OUTERMOST level; `parent_topic_id` produces the group → sub-group
 * level INSIDE it. **The two compose; they are not alternatives.**
 *
 * THIS FUNCTION'S FIRST VERSION GOT THAT WRONG and bailed out entirely on
 * `roots.some(n => n.children.length > 0)` — i.e. the moment any topic gained a sub-group, the whole
 * category level vanished. That is the "sub-groups and epics" work this must not clobber: journey is
 * actively building toward populated `parent_topic_id`, so the state this had to survive is the one
 * where SOME topics nest and others do not. Caught by the owner before it shipped.
 *
 * Why the category level is needed at all — measured 2026-09-13 (journey wwxgajrtmslzklnyplah):
 *
 *     select count(*), count(parent_topic_id), count(distinct category_affinity)
 *       from public.task_topic_index;
 *     -> 158 topics, 0 with a parent, 5 distinct categories
 *
 * `parent_topic_id` is NULL on every row TODAY, so nesting alone yields 158 flat rows. That is a
 * MEASUREMENT WITH A DATE, not a structural fact — do not turn it back into an assumption.
 *
 * Skipped only when there is genuinely nothing to do: no node carries a category, or the producer
 * already sent category roots (double-wrapping them would add a level journey does not draw).
 * A topic with no category stays a top-level row rather than being dropped or bucketed as "Other".
 */
/** Depth-first: the first `categoryAffinity` anywhere under these nodes, or null. */
function firstCategoryInSubtree(nodes: TopicNode[]): string | null {
  for (const n of nodes) {
    if (n.categoryAffinity) return n.categoryAffinity;
    const deeper = firstCategoryInSubtree(n.children);
    if (deeper) return deeper;
  }
  return null;
}

function groupByCategory(roots: TopicNode[]): TopicNode[] {
  if (roots.some((n) => n.id.startsWith(CATEGORY_ROOT_PREFIX))) return roots; // already categorised
  // "Nothing to group on" must look at the WHOLE SUBTREE, not just each root's own field — a group
  // can be uncategorised while its sub-group carries the category, and an own-field-only check
  // returned early and left that tree flat.
  if (!roots.some((n) => n.categoryAffinity ?? firstCategoryInSubtree(n.children))) return roots;

  const byCat = new Map<string, TopicNode>();
  const out: TopicNode[] = [];

  for (const n of roots) {
    // A group with no category of its own takes the first one found beneath it, so a sub-group's
    // category still places the group. journey does the richer version of this — a majority vote
    // over the topic's tasks' categories, then `category_affinity`, then `window_affinity[0]`
    // (f0ab561:239-254) — but Huddle is handed topics, not their tasks, so the vote's input does not
    // exist here. Taking the first is the honest subset; it is NOT a reimplementation of the vote.
    const own = n.categoryAffinity ?? firstCategoryInSubtree(n.children);
    if (!own) {
      out.push(n); // uncategorised topic — a top-level row of its own, never silently dropped
      continue;
    }
    // PROF_EDUCATION and EDUCATION share one row, PERSONAL folds into LIFE — journey's own merge.
    const cat = displayCategory(own);
    let parent = byCat.get(cat);
    if (!parent) {
      parent = {
        id: `${CATEGORY_ROOT_PREFIX}${cat}`,
        name: categoryLabel(cat),
        parentId: null,
        categoryAffinity: cat,
        position: null,
        count: null,
        children: [],
        tasks: [],
      };
      byCat.set(cat, parent);
      out.push(parent);
    }
    parent.children.push(n);
  }

  for (const parent of byCat.values()) {
    // journey renders its five known categories in a FIXED order and appends unknown ones after
    // them (`DISPLAY_CATEGORIES` + the dynamic scan in 532da6b). `position` is the sort key
    // sortNodes already uses, so encode the rank there; an unknown category gets a rank past the
    // end and therefore sorts after every known one, alphabetically by name via sortNodes' tiebreak.
    const rank = DISPLAY_CATEGORY_ORDER.indexOf(parent.categoryAffinity as (typeof DISPLAY_CATEGORY_ORDER)[number]);
    parent.position = rank >= 0 ? rank : DISPLAY_CATEGORY_ORDER.length;

    // A category's count is the sum over its whole SUBTREE, not just its direct children — a
    // sub-group's tasks are still that category's tasks. It stays NULL when nothing underneath
    // reports a count, because the spec draws a BLANK there, never a "0" (the owner's screenshot
    // has exactly one such row: Family, which holds no topics at all).
    let sum = 0;
    let sawCount = false;
    const walk = (nodes: TopicNode[]) => {
      for (const c of nodes) {
        if (c.count !== null) {
          sum += c.count;
          sawCount = true;
        }
        walk(c.children);
      }
    };
    walk(parent.children);
    parent.count = sawCount ? sum : null;
  }

  return out;
}

/**
 * Would attaching `n` to its declared parent close a loop? Walks the ancestor chain looking for
 * `n` itself (or any repeat).
 *
 * Not hypothetical paranoia — MEASURED. Without this, two topics naming each other as parent were
 * each attached to the other and NEITHER ended up in `roots`: `buildTopicTree` returned `[]` and
 * both topics silently disappeared. A malformed row must cost its own nesting, never its existence,
 * so a node in a cycle is promoted to a root instead.
 */
function hasAncestorCycle(node: TopicNode, byId: Map<string, TopicNode>): boolean {
  const seen = new Set<string>([node.id]);
  let cur = node.parentId ? byId.get(node.parentId) : undefined;
  while (cur) {
    if (seen.has(cur.id)) return true;
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

function sortNodes(nodes: TopicNode[]): TopicNode[] {
  nodes.sort((a, b) => {
    const ap = a.position ?? Number.POSITIVE_INFINITY;
    const bp = b.position ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    return a.name.localeCompare(b.name);
  });
  for (const n of nodes) sortNodes(n.children);
  return nodes;
}

/**
 * Normalize journey's topic payload into nested roots.
 *
 * journey's shape is FOUR levels — `category > group > sub-group > task` (journey-voice `f0ab561`).
 * Huddle is handed the top three. They are built in two INDEPENDENT, COMPOSING steps:
 *
 *   STEP 1 — nesting (group → sub-group), from whatever the payload carries. The two sources COMPOSE
 *     in ONE pass rather than one short-circuiting the other:
 *     · already nested by the producer → that nesting is kept as sent;
 *     · flat with real `parent_topic_id` → nested by parent id. Cycle-safe: see hasAncestorCycle,
 *       which promotes a looping node to a root rather than returning an EMPTY tree and losing both.
 *     An earlier version RETURNED EARLY the instant any entry arrived pre-nested, so a MIXED payload
 *     — some entries nested, others declaring `parent_topic_id` — left the flat ones unnested and
 *     rendered a child as its parent's sibling. No data lost, wrong tree.
 *     · flat with no parent at all → one level, which is journey's data TODAY (158 topics, all
 *       parentless, measured 2026-09-13). journey is actively working toward populated parents, so
 *       treat that as a dated measurement, never as the shape.
 *
 *   STEP 2 — `groupByCategory` wraps whatever step 1 produced in category roots. It runs on EVERY
 *     branch. It must never be conditional on step 1's outcome: a build where some topics nest and
 *     others do not is the state journey is heading for, and an earlier version of this skipped the
 *     category level entirely the moment ONE sub-group appeared.
 *
 * A node whose declared parent is missing from the payload is promoted to a root rather than
 * dropped, so a partial page can never silently lose topics.
 */
export function buildTopicTree(payload: unknown): TopicNode[] {
  const arr = findTopicArray(payload);
  if (!arr) return [];
  const flat: TopicNode[] = [];
  for (const raw of arr) {
    const node = toTopicNode(raw, 0);
    if (node) flat.push(node);
  }
  if (!flat.length) return [];

  // `byId` is a LOOKUP TABLE FOR RESOLVING PARENTS — it is NOT the list of nodes to emit.
  //
  // IT USED TO BE BOTH, AND THAT SILENTLY DELETED TOPICS. The loop below iterated `byId.values()`,
  // so when two entries shared an id the second never reached `roots` at all. Measured:
  //
  //   in  [{topic_name:"Admin", category_affinity:"LIFE",   task_count:7},
  //        {topic_name:"Admin", category_affinity:"CAREER", task_count:9}]
  //   out one row — LIFE/7. The CAREER topic and its whole category row were gone.
  //
  // That input is not contrived. `toTopicNode` falls back to `id = name` when the payload carries no
  // id (see its `firstString(o, ["id","topic_id","topicId"]) ?? name`), which this parser tolerates
  // ON PURPOSE because journey's envelope is unpublished — so any two same-named topics collide, and
  // a duplicate name is ordinary in a 158-topic tree. Found by an independent verifier, not a test.
  //
  // The invariant, and the reason this reads from `flat`: EVERY parsed node is emitted exactly once,
  // as a child or as a root. A malformed row may cost its own NESTING; it must never cost its
  // EXISTENCE. That is the same rule `hasAncestorCycle` exists to uphold for cycles — the cycle case
  // was fixed and this one was not, because both were reasoned about rather than executed.
  const byId = new Map<string, TopicNode>();
  for (const n of flat) if (!byId.has(n.id)) byId.set(n.id, n);
  const roots: TopicNode[] = [];
  // Keyed by NODE, never by id: with colliding ids an id-keyed set would re-create the same bug in a
  // second place, letting only one of two same-id nodes ever attach.
  const attached = new Set<TopicNode>();
  for (const n of flat) {
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    if (parent && parent !== n && !attached.has(n) && !hasAncestorCycle(n, byId)) {
      parent.children.push(n);
      attached.add(n);
    } else {
      roots.push(n);
    }
  }
  return sortNodes(groupByCategory(roots));
}

// ---------------------------------------------------------------------------
// Tasks under categories (the mirror-sourced half of the tree)
// ---------------------------------------------------------------------------

/**
 * Build the category tree FROM THE MIRROR, with each category's tasks attached.
 *
 * This is the source decision this feature turns on, so it is recorded here rather than in a PR
 * body that nobody greps. Four candidate sources; three rejected:
 *
 *  · `get_task_topics` (a new journey tool) — REJECTED as unavailable, not as wrong. It is the only
 *    source that yields real topic/theme nodes, and it is what `fetchTopicTree` already calls, but
 *    it is not on journey's `main`, not in any open PR, and commit `ec508a5` is unreachable in this
 *    clone. It cannot be deployed, only written — a change plus a live deploy in another repo.
 *  · `get_tasks` once — REJECTED: `.limit(50)` (execute-tool/index.ts:707) against 101 open tasks,
 *    with no status filter and ordered `start_time asc nullsFirst:false`, so it returns half the
 *    board, silently, skewed toward scheduled rows.
 *  · `get_tasks_by_topic` per topic — REJECTED: ~75 round-trips per render, and three defects
 *    (text-column ordering, no tiebreak, drops BLOCKED, `success:true count:0` on a duplicate
 *    topic name).
 *  · a new mirror column — REJECTED: needs the same journey-side change, and `category` is already
 *    synced on every row.
 *
 * So: `tasks.journey_tasks.category`, which Huddle already reads for the band in the SAME
 * `getBoardTasks` call. Uncapped, complete, zero extra round-trips, no journey dependency.
 *
 * WHAT THIS DELIVERS AND WHAT IT DOES NOT: categories with their tasks — which is the payoff the
 * owner named ("so if an agent in the future is asked to autopull one or two FROM THE CATEGORIES it
 * knows whats next"). It does NOT invent topic/theme sub-nodes; the mirror has no topic column
 * (topics live in journey's `task_topic_mappings`). That layer is `buildPrioritiesTree`'s job: it
 * calls this for the tasks linked to NO topic, and for the whole tree when journey's topics are
 * unavailable.
 *
 * Note it does what the comment in `groupByCategory` says Huddle could not: that code takes "the
 * first category found beneath" a topic because "Huddle is handed topics, not their tasks". Here
 * Huddle IS handed the tasks, so the category comes from the task's own `category` column — no
 * inference at all.
 *
 * Pure: `nowMs` is passed in, so the result is deterministic and testable.
 */
export function buildCategoryTaskTree(
  rows: BoardTaskRow[],
  timeZone: string,
  nowMs: number,
): TopicNode[] {
  const tz = safeTimeZone(timeZone);
  const todayKey = localDateKey(nowMs, tz) ?? new Date(nowMs).toISOString().slice(0, 10);

  // The TREE's liveness rule, which is the owner's phone's rule (isTreeLive), not the band's.
  const live = rows.filter(isTreeLive).map((r) => toWidgetRow(r, tz, todayKey));

  const byCat = new Map<string, WidgetTaskRow[]>();
  for (const row of live) {
    // A task with no category is NOT dropped — it gets its own bucket, the same way an
    // uncategorised topic stays a top-level row rather than disappearing. 3 of the owner's 101
    // open tasks are unmapped, and silently losing them is the failure mode this project keeps
    // hitting (see buildTopicTree's duplicate-id note).
    const raw = (row.category ?? "").trim();
    const cat = raw ? displayCategory(raw) : UNCATEGORISED_CATEGORY;
    const list = byCat.get(cat);
    if (list) list.push(row);
    else byCat.set(cat, [row]);
  }

  const out: TopicNode[] = [];
  for (const [cat, tasks] of byCat) {
    tasks.sort(byPriorityThenDue);
    const rank = DISPLAY_CATEGORY_ORDER.indexOf(cat as (typeof DISPLAY_CATEGORY_ORDER)[number]);
    out.push({
      id: `${CATEGORY_ROOT_PREFIX}${cat}`,
      name: cat === UNCATEGORISED_CATEGORY ? UNCATEGORISED_LABEL : categoryLabel(cat),
      parentId: null,
      categoryAffinity: cat,
      position:
        cat === UNCATEGORISED_CATEGORY
          ? DISPLAY_CATEGORY_ORDER.length + 1 // always last, after any dynamic category
          : rank >= 0
            ? rank
            : DISPLAY_CATEGORY_ORDER.length,
      // DERIVED from the tasks, never passed through from journey's `task_count`. That is the
      // Android widget's own rule (`tasksByTopic[grp.id]?.size`) and it is why the count can never
      // disagree with the rows underneath it — the defect found in PrioritiesWidgetFactory, where a
      // group's count sums only its sub-groups and omits its own directly-mapped tasks.
      count: tasks.length,
      children: [],
      tasks,
    });
  }
  return sortNodes(out);
}

/** Bucket for a live task whose `category` is null/blank. Not a journey value — a Huddle-side
 *  holding row, so an unmapped task is visible instead of silently absent. */
export const UNCATEGORISED_CATEGORY = "UNCATEGORISED";
const UNCATEGORISED_LABEL = "Uncategorised";

/**
 * Merge journey's topic tree INTO the mirror-sourced category tree.
 *
 * The mirror is the BASE, not the overlay. Before journey-voice#42 deployed `get_task_topics`
 * (2026-10-15), journey answered `tool-absent` and an overlay design rendered nothing: the tree had
 * never populated in production. Basing on the mirror means the categories and their tasks render
 * whatever journey does, and topics fold in as children whenever it answers.
 *
 * It also fixes a divergence from the owner's phone: `groupByCategory` only creates a category root
 * when some TOPIC claims that category, so FAMILY — which holds no `task_topic_index` rows — is
 * absent in Huddle while the Android widget draws it. Here a category exists because TASKS are in
 * it, so it renders whether or not a topic ever claims it.
 *
 * Nothing is ever dropped: a journey topic root whose category has no mirror tasks still gets its
 * category row created, and an uncategorised topic root stays top-level.
 */
export function mergeTopicTree(
  topicRoots: readonly TopicNode[],
  categoryRoots: readonly TopicNode[],
): TopicNode[] {
  const out: TopicNode[] = categoryRoots.map(cloneNode);
  const byId = new Map<string, TopicNode>(out.map((n) => [n.id, n]));

  for (const root of topicRoots) {
    // Category roots journey's own grouping produced: fold their children into ours by id.
    if (root.id.startsWith(CATEGORY_ROOT_PREFIX)) {
      const mine = byId.get(root.id);
      if (mine) {
        mine.children.push(...root.children.map(cloneNode));
      } else {
        const copy = cloneNode(root);
        out.push(copy);
        byId.set(copy.id, copy);
      }
      continue;
    }
    // A bare topic root (journey sent no category for it) — keep it top-level rather than
    // guessing a category for it.
    out.push(cloneNode(root));
  }
  for (const root of out) recountSubtree(root);
  return sortNodes(out);
}

/**
 * DEEP copy. A shallow `{...n, children: [...n.children]}` copies two levels and no further, and
 * `sortNodes` then recurses and sorts the CALLER'S grandchild arrays in place — measured by an
 * independent verifier: input `[gz, ga]` came back `[ga, gz]`.
 *
 * The test that was supposed to catch it asserted a `length` on the one level that IS copied, so it
 * passed while the defect was live. A length assertion cannot see a reorder; that is the lesson,
 * not the clone.
 */
function cloneNode(n: TopicNode): TopicNode {
  return { ...n, children: n.children.map(cloneNode), tasks: [...n.tasks] };
}

/**
 * Recompute every node's `count` from what is actually beneath it, bottom-up.
 *
 * WHY, and it only bites once journey's topic tool deploys: a category root built by
 * `buildCategoryTaskTree` counts ITS OWN tasks. Nest journey's topics under it and that number
 * silently UNDERCOUNTS — "Career 10" above a child "Presentation Development 2" with 12 tasks in
 * the subtree. That is precisely the `PrioritiesWidgetFactory.grpTaskCount` defect this feature was
 * written to avoid (its group count sums only sub-groups and omits the group's own tasks), arrived
 * at from the other direction.
 *
 * A node with NOTHING beneath it keeps journey's own `count`. That is deliberate: journey's topic
 * rows legitimately carry a number with no tasks attached — it is what the owner's spec screenshot
 * draws ("Presentation Development 2", "Career Development 15") — and such a row is not expandable,
 * so it never shows a count above an empty list. Only a node that HAS content gets its count
 * derived from that content, so the number and the rows can never disagree.
 */
function recountSubtree(node: TopicNode): number {
  let total = node.tasks.length;
  let sawChildCount = false;
  for (const child of node.children) {
    const sub = recountSubtree(child);
    if (sub !== null) {
      total += sub;
      sawChildCount = true;
    }
  }
  if (node.tasks.length > 0 || sawChildCount) node.count = total;
  return node.count ?? 0;
}

// ---------------------------------------------------------------------------
// THE ONE priorities composition
// ---------------------------------------------------------------------------

/**
 * Build a complete `PrioritiesWidgetData` for one user. **Every surface that shows a priorities
 * card must call this.**
 *
 * WHY THIS EXISTS, measured 2026-10-15: there were THREE independent constructions of this payload
 * — the server fn (`getPrioritiesWidget`), the agent tool (`tools.ts` `show_priorities_widget`) and
 * the scheduled check (`priority-check.server.ts`). The category tree was wired into the server fn
 * ONLY, and `tools.ts` shipped a hardcoded `topics: {ok:false, roots:[], reason:"ok"}`. So the card
 * the owner actually saw — posted by Iris from the 6am/8pm check, which goes through the agent tool
 * — rendered **"No topics yet."** while the same data rendered a full tree elsewhere. The feature
 * looked unbuilt because two of its three doors were never opened.
 *
 * That is the duplication this repo's own rule forbids ("extend, don't duplicate"), and the comment
 * at `huddle.functions.ts:6429` had already warned that a second construction of this payload was
 * the hazard. One function now; a fourth surface gets the tree for free.
 *
 * `journeyRoots` is journey's topic tree when the caller has one (only the server fn fetches it —
 * the agent-tool and scheduled paths must not pay a journey round-trip to render a card). Omitted,
 * the tree is the mirror's categories alone, which is the complete, uncapped set either way.
 */
export async function composePrioritiesWidget(
  email: string,
  timeZone: string,
  opts: { nowMs?: number; caller?: { entra_email?: string; entra_object_id?: string }; includeTopics?: boolean } = {},
): Promise<PrioritiesWidgetData> {
  const tz = safeTimeZone(timeZone);
  const nowMs = opts.nowMs ?? Date.now();
  const { getBoardTasks, getWeekOrder } = await import("./tasks.server");
  const wantTopics = opts.includeTopics !== false && !!opts.caller;
  // The three reads are independent, so they run together. The journey read is the only remote
  // one and it is BOUNDED (fetchTopicPayload) so it can never stall an agent's turn.
  const [rows, order, topic] = await Promise.all([
    getBoardTasks(email),
    // The user's explicit This Week order. Degrades to [] — an ordering read must never block a card.
    getWeekOrder(email).catch(() => [] as string[]),
    wantTopics ? fetchTopicPayload(opts.caller!) : Promise.resolve(NOT_REQUESTED),
  ]);
  return {
    ok: true,
    timeZone: tz,
    todayKey: localDateKey(nowMs, tz) ?? new Date(nowMs).toISOString().slice(0, 10),
    band: buildPrioritiesBand(rows, tz, nowMs, order),
    topics: {
      // `ok`/`reason` describe the JOURNEY read, so the UI can say when the sub-category layer is
      // missing. The category rows render from the mirror either way.
      ok: topic.ok,
      reason: topic.reason,
      ...(topic.error ? { error: topic.error } : {}),
      roots: buildPrioritiesTree(rows, tz, nowMs, topic.ok ? topic.payload : undefined),
    },
  };
}

// ---------------------------------------------------------------------------
// Category -> Topic -> Task: the sub-category layer
// ---------------------------------------------------------------------------

interface TopicFetch {
  ok: boolean;
  reason: TopicTreeReason;
  error?: string;
  payload?: unknown;
}

/** Topics were not asked for (no caller, or `includeTopics:false`). Not a failure, so no banner. */
const NOT_REQUESTED: TopicFetch = { ok: true, reason: "ok" };

/**
 * How long a card waits for journey's topic tree before rendering the category-only tree instead.
 *
 * The agent-tool path deliberately skipped this call before, so a slow journey could not stall an
 * agent mid-reply ("a tool call already inside an agent's turn is the worst place to spend that
 * latency"). The owner now needs the sub-category layer on exactly that card, so the call happens
 * there too, under a ceiling. A timeout degrades to the category tree, never to an error card.
 */
export const TOPIC_FETCH_TIMEOUT_MS = 4000;

/**
 * Journey's `get_task_topics`, through the existing proxy passthrough. MUST DEGRADE, NEVER THROW:
 *   not-configured -> no JOURNEY_PROXY_URL/TOKEN in this environment
 *   tool-absent    -> journey answered but does not know the tool (not deployed yet)
 *   error          -> network, non-JSON, timeout
 */
export async function fetchTopicPayload(
  caller: { entra_email?: string; entra_object_id?: string },
  timeoutMs: number = TOPIC_FETCH_TIMEOUT_MS,
): Promise<TopicFetch> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TopicFetch>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, reason: "error", error: `journey topic tree timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );
  });
  const call = (async (): Promise<TopicFetch> => {
    try {
      const { invokeJourneyTool } = await import("../journey/proxy.functions");
      const r = await invokeJourneyTool({
        toolName: "get_task_topics",
        args: {},
        caller,
        context: { source: "huddle" },
      });
      if (!r.ok) {
        return { ok: false, reason: classifyTopicFailure(r.error, r.output), error: r.error ?? "journey returned ok=false" };
      }
      // The proxy always hands back `output` as a STRING (huddle-proxy JSON.stringifies the result).
      let payload: unknown = r.output;
      if (typeof r.output === "string") {
        try {
          payload = JSON.parse(r.output);
        } catch {
          return { ok: false, reason: "error", error: "journey returned non-JSON output" };
        }
      }
      return { ok: true, reason: "ok", payload };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: msg.toLowerCase().includes("not configured") ? "not-configured" : "error", error: msg };
    }
  })();
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Why journey's topic call failed: the tool not being deployed is a steady state the UI explains
 * ("Sub-themes … aren't available yet"), anything else is an error worth showing. Pure so it can be
 * tested: an independent verifier deleted this detection and no test failed (INERT, 2026-10-15).
 * execute-tool's own wording is "Unknown tool: <name>".
 */
export function classifyTopicFailure(error?: string | null, output?: string | null): TopicTreeReason {
  const detail = `${error ?? ""} ${output ?? ""}`.toLowerCase();
  return ["unknown tool", "unsupported tool", "no such tool", "tool not found", "not implemented"].some((p) =>
    detail.includes(p),
  )
    ? "tool-absent"
    : "error";
}

/**
 * `task_id -> topic_id` from journey's `mappings`, ONE topic per task.
 *
 * A task linked to two topics is placed ONCE, under its NEWEST link (`created_at`), so counts never
 * double and the placement matches the owner's phone. The phone keeps the last link the database
 * returns (`topicByTask[task_id] = topic_id`), and the table returns links in insertion order, so
 * "last" is "newest". Measured 2026-10-15 on the one such task: "Prepare an inspections records
 * database" is linked to Database Management (13:06:59.099) and Inspection Records Management
 * (13:06:59.191), and his phone files it under the second. Unlike the phone, this does not depend on
 * row order: it reads the timestamp. Ties, and links that arrive without a timestamp (a journey
 * before `created_at` was added to get_task_topics), fall back to the smallest topic id, so the
 * result is the same on every read.
 */
export function findTopicMappings(payload: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const arr = (() => {
    if (!payload || typeof payload !== "object") return null;
    const o = payload as Record<string, unknown>;
    if (Array.isArray(o.mappings)) return o.mappings;
    for (const k of ["result", "data", "output", "payload"]) {
      const v = o[k];
      if (v && typeof v === "object" && Array.isArray((v as Record<string, unknown>).mappings)) {
        return (v as Record<string, unknown>).mappings as unknown[];
      }
    }
    return null;
  })();
  const chosenAt = new Map<string, number>(); // task -> created_at (ms) of the link currently chosen
  for (const m of arr ?? []) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    const taskId = typeof r.task_id === "string" ? r.task_id : typeof r.taskId === "string" ? r.taskId : null;
    const topicId = typeof r.topic_id === "string" ? r.topic_id : typeof r.topicId === "string" ? r.topicId : null;
    if (!taskId || !topicId) continue;
    const rawAt = r.created_at ?? r.createdAt;
    const parsed = typeof rawAt === "string" ? Date.parse(rawAt) : NaN;
    const at = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    const prev = out.get(taskId);
    const prevAt = chosenAt.get(taskId) ?? Number.NEGATIVE_INFINITY;
    // Newest link wins; equal timestamps (or none) fall back to the smallest topic id.
    if (prev === undefined || at > prevAt || (at === prevAt && topicId < prev)) {
      out.set(taskId, topicId);
      chosenAt.set(taskId, at);
    }
  }
  return out;
}

/**
 * The whole tree the widget renders: Category -> Topic -> Task, matching the owner's Android widget.
 *
 * With journey's topic payload: every topic is a node under its category (category_affinity, else
 * first window_affinity: the Android rule), each live task is attached under the topic it is linked
 * to, and the category count is the sum beneath it. Measured: this reproduces his phone's "Career 8"
 * exactly, across the same 13 topics.
 *
 * Tasks linked to NO topic are not dropped (the Android widget drops them): they sit directly under
 * their own category, after its topics, so no live work is ever hidden.
 *
 * Without a payload (journey's tool not deployed, timed out, or not asked for): the category-only
 * tree from the mirror, exactly as before. Pure: `nowMs` is passed in.
 */
export function buildPrioritiesTree(
  rows: BoardTaskRow[],
  timeZone: string,
  nowMs: number,
  topicPayload?: unknown,
): TopicNode[] {
  const topicRoots = topicPayload === undefined ? [] : buildTopicTree(topicPayload);
  if (!topicRoots.length) return buildCategoryTaskTree(rows, timeZone, nowMs);

  const tz = safeTimeZone(timeZone);
  const todayKey = localDateKey(nowMs, tz) ?? new Date(nowMs).toISOString().slice(0, 10);
  const mappings = findTopicMappings(topicPayload);

  // First node wins per id. buildTopicTree deliberately emits same-id nodes rather than dropping
  // one, and a task must still land in exactly one place.
  const byId = new Map<string, TopicNode>();
  const index = (ns: TopicNode[]) => {
    for (const n of ns) {
      if (!byId.has(n.id)) byId.set(n.id, n);
      index(n.children);
    }
  };
  index(topicRoots);

  for (const r of rows) {
    if (!isTreeLive(r)) continue;
    const topicId = mappings.get(r.id);
    const node = topicId ? byId.get(topicId) : undefined;
    // Never attach to a synthetic category root: a mapping names a TOPIC.
    if (node && !node.id.startsWith(CATEGORY_ROOT_PREFIX)) node.tasks.push(toWidgetRow(r, tz, todayKey));
    // A task linked to NO topic is NOT shown in the tree when topics are available — the phone's
    // rule (SupabaseTaskClient.getTasksForTopics only fetches tasks reached through a mapping). It
    // stays on the board, and in This Week if starred. The degraded path above is different on
    // purpose: with NO topics at all, every task is "unlinked", and hiding them would empty the tree.
  }
  for (const n of byId.values()) n.tasks.sort(byPriorityThenDue);

  // mergeTopicTree deep-clones, folds the topics into category roots, recounts every node from what
  // is beneath it, and sorts.
  return mergeTopicTree(topicRoots, []);
}

// ---------------------------------------------------------------------------
// Action → journey tool mapping
// ---------------------------------------------------------------------------

/**
 * The journey status each status-writing widget button sets. Values are from the `update_task`
 * tool's own enum, read this session from journey-voice
 * `supabase/functions/_shared/tool-definitions.ts`:
 *   ["BACKLOG","TODO","READY","UP_NEXT","DOING","IN_REVIEW","DONE","BLOCKED","PLANNING"]
 *
 *  ▶ start  → DOING    (the WIP flow's active lane)
 *  ✓ done   → DONE     (the user is the only one who may set DONE — this button IS the user)
 *  ⏸ pause  → BACKLOG  + the `parking-lot` tag. See PAUSE IS A PARK below.
 *  ↺ reopen → BACKLOG  (no tag change — un-ticking ✓ is "not actually done", NOT "stop working it")
 *
 * PAUSE IS A PARK, AND IT MUST BE — this mapping was `UP_NEXT` and that silently un-paused the task.
 * `autowork.server.ts` promotes one UP_NEXT item to DOING whenever the agent has none in flight
 * (cap 1), and ⏸ empties that DOING slot in the same write. So a "paused" task was a promotion
 * candidate at the very next 9/13/17 tick — and the confirm-intent gate waved it straight through,
 * because a task that had already reached DOING had already been confirmed. Pressing pause resumed
 * the task within hours.
 * BACKLOG + `parking-lot` is this repo's EXISTING park mechanism, not a new one: `autowork.server.ts`
 * filters candidates with `!(t.tags ?? []).includes("parking-lot")`, and `BoardView` already renders
 * the tag as a chip. (CLAUDE.md: "parking-lot is JUST a tag, no new lane".)
 *
 * REOPEN EXISTS SO THE TWO GESTURES STOP SHARING ONE ACTION. Un-ticking ✓ on a non-DOING row used to
 * send `pause`; once pause parks, that gesture would have opted the task out of automation — a much
 * bigger side effect than the user asked for by un-ticking a box.
 *
 * `today`/`untoday` are NOT here: they change the SCHEDULE, not the status, and route to
 * `move_task_to_day` / `unschedule_task` instead.
 */
export const ACTION_STATUS: Readonly<Record<"start" | "done" | "pause" | "reopen", string>> = Object.freeze({
  start: "DOING",
  done: "DONE",
  pause: "BACKLOG",
  reopen: "BACKLOG",
});
