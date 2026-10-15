// WHAT:       PUSH into This Week — a task ("I choose"), or a category / topic ("you choose": Huddle stars
//             its best task now, and the next one each time the starred one is finished).
// WHY:        Owner, 2026-10-15, option C with guardrails: "Huddle stars the top task, pins it so
//             Monday's groom can't clear it, and stars the next one as soon as you finish. Journey's 1am
//             job puts it on your calendar inside that category's hours. No journey changes." Plus
//             decision A: the groom no longer stars anything, so a star is only ever the user's.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/AC-category-push.md (independent ACs, written before this code);
//             .claude/memory.md "The STAR" (the star -> 1am calendar chain, read in journey's code).
//
// THE STAR IS JOURNEY'S `is_priority`, written ONLY through journey's existing `set_priority_rank` tool.
// Rank 0: journey's nightly scheduler sorts stars by `priority_rank ?? 9999`, so 0 puts a push ahead of
// any other star for calendar time; a NULL rank would queue it LAST (AC OQ-1). Huddle never schedules
// anything itself and never calls `move_task_to_day` — the 1am job does the placing, inside the
// category's own working-hour window.
//
// The mirror (`tasks.journey_tasks`) stays single-writer: every write here goes to journey and comes
// back through the sync webhook.
//
// The pure half (eligibility, picking, event classification) takes rows as arguments and is what the
// tests import; only the functions below the divider touch the database or journey.

import { orderForAutowork } from "./scoring";
import { CATEGORY_ROOT_PREFIX, displayCategory, UNCATEGORISED_CATEGORY } from "./widgets.server";
import type { PushCandidateRow, PriorityPushRow } from "./tasks.server";

/** The rank a push writes. 0 sorts ahead of every other star in journey's nightly placement. */
export const PUSH_RANK = 0;

const PARKING_LOT_TAG = "parking-lot";

export type PushNode = { kind: "category"; key: string } | { kind: "topic"; topicId: string };

/** `category:CAREER` -> category CAREER; anything else is a journey topic id. Uncategorised: null. */
export function parseNodeId(nodeId: string): PushNode | null {
  if (!nodeId) return null;
  if (nodeId.startsWith(CATEGORY_ROOT_PREFIX)) {
    const key = nodeId.slice(CATEGORY_ROOT_PREFIX.length).toUpperCase();
    if (!key || key === UNCATEGORISED_CATEGORY) return null;
    return { kind: "category", key };
  }
  return { kind: "topic", topicId: nodeId };
}

function upper(s: string | null | undefined): string {
  return (s ?? "").toUpperCase();
}

function isParkedRow(row: { tags?: string[] | null }): boolean {
  return (row.tags ?? []).some((t) => String(t).toLowerCase() === PARKING_LOT_TAG);
}

/**
 * Can a push star this task? Every exclusion journey's own nightly scheduler would apply, so a star
 * is never a promise the 1am job cannot keep:
 *   - status one the scheduler actually places — READY, UP_NEXT, TODO, BACKLOG. Its unmapped-task pool
 *     takes exactly those (nightly-schedule-builder ~969-998); DOING / IN_REVIEW / PLANNING are never
 *     placed from it, so a push picking one starred work that never reached the calendar
 *     (VERIFY-category-push-1 D3);
 *   - no `completed_at` (journey skips reopened tasks that kept one); not parked; not waiting on a
 *     scheduled reminder; title not matching the scheduler's own "Test Task" exclusion;
 *   - and NOT ALREADY STARRED (a push never adopts or rewrites someone else's star).
 */
export const SCHEDULABLE_STATUSES: ReadonlySet<string> = new Set(["READY", "UP_NEXT", "TODO", "BACKLOG"]);

export function isPushEligible(
  row: PushCandidateRow,
  inReminderWindow: ReadonlySet<string> = new Set(),
): boolean {
  const s = upper(row.status);
  if (s && !SCHEDULABLE_STATUSES.has(s)) return false;
  if (/test task/i.test(row.title ?? "")) return false;
  if (row.completed_at) return false;
  if (isParkedRow(row)) return false;
  if (inReminderWindow.has(row.id)) return false;
  if (row.is_priority) return false;
  return true;
}

/** Does `row` belong to `node`? Category: the task's OWN category (display-folded, so PERSONAL counts
 *  as LIFE) — that is the category whose hours journey will schedule it in. Topic: its mapping. */
export function inNode(
  row: PushCandidateRow,
  node: PushNode,
  topicTaskIds?: ReadonlySet<string>,
): boolean {
  if (node.kind === "category") return !!row.category && displayCategory(row.category) === node.key;
  return !!topicTaskIds?.has(row.id);
}

/**
 * The task a push stars: the best eligible task in the node by the SAME scorer that orders the agents'
 * work (journey's keys: rank, score, due date). Deterministic — rows are put in id order first, so the
 * stable sort breaks every full tie the same way no matter what order the database returned them in.
 */
export function pickForNode(
  rows: readonly PushCandidateRow[],
  node: PushNode,
  opts: {
    topicTaskIds?: ReadonlySet<string>;
    inReminderWindow?: ReadonlySet<string>;
    skip?: string | null;
    now?: Date;
  } = {},
): PushCandidateRow | null {
  const eligible = rows
    .filter((r) => r.id !== opts.skip)
    .filter((r) => inNode(r, node, opts.topicTaskIds))
    .filter((r) => isPushEligible(r, opts.inReminderWindow))
    .sort((a, b) => a.id.localeCompare(b.id));
  return orderForAutowork(eligible, opts.now)[0] ?? null;
}

export type ActiveEvent = "refill" | "unpush" | "none";

/** Milliseconds from an ISO string OR a Date. node-postgres hands TIMESTAMPTZ back as a Date, and
 *  `Date.parse(date)` stringifies it first and DROPS the milliseconds — which let a same-second stale
 *  event cancel a push (VERIFY-category-push-2 N2). */
export function toMs(v: string | Date | null | undefined): number {
  if (v == null) return NaN;
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/**
 * The row the reconcile classifies: the MIRROR row for what journey's single-task read does not return,
 * overlaid with the fields journey DOES return (status, is_priority, priority_rank — plus anything else
 * it happens to send). `explain_task_score` reads `*` but returns only id/title/priority/due_date/status/
 * is_priority/priority_rank/pushed_count (execute-tool ~2686) — no category, tags or completed_at. Using
 * that bare row made EVERY category push look "moved to another category" and refill on every tick,
 * starring one more task each time (VERIFY-category-push-2 N1). journey's status/star are what a lost
 * webhook leaves stale in the mirror, so those come from journey; category and tags come from the mirror.
 */
export function mergeJourneyRow(
  mirror: PushCandidateRow | null,
  journey: Partial<PushCandidateRow> & { id: string },
): PushCandidateRow {
  const base: PushCandidateRow = mirror ?? {
    id: journey.id,
    title: journey.title ?? "",
    status: null,
    priority: null,
    category: null,
    is_priority: null,
    priority_rank: null,
    due_date: null,
    pushed_count: null,
    created_at: null,
    completed_at: null,
    tags: null,
  };
  const defined = Object.fromEntries(Object.entries(journey).filter(([, v]) => v !== undefined));
  return { ...base, ...defined } as PushCandidateRow;
}

/**
 * What a mirror change to a push's ACTIVE task means for that push.
 *   refill — it is finished or can no longer be done in this node: DONE (from any surface, including
 *            journey's own 1am auto-archive), deleted, BLOCKED, parked, or moved to another category.
 *   unpush — the user took the star off it (on any surface) while it is still open: they are done
 *            with this push, so nothing is re-starred.
 *   none   — anything else, including Huddle's own star write echoing back (it is still starred).
 */
export function classifyActiveEvent(
  op: string,
  row: PushCandidateRow | null,
  node: PushNode,
  pushSince?: string | Date | null,
): ActiveEvent {
  if (upper(op) === "DELETE" || !row) return "refill";
  const s = upper(row.status);
  if (s === "DONE" || s === "BLOCKED" || row.completed_at) return "refill";
  if (isParkedRow(row)) return "refill";
  if (node.kind === "category" && !(row.category && displayCategory(row.category) === node.key))
    return "refill";
  if (row.is_priority === false) {
    // A STALE "not starred" — an edit made BEFORE this push starred the task, delivered late (pg_net
    // does not order deliveries) — must not end the push. Only an un-star at or after the moment the push
    // took this task counts as the user removing it (VERIFY-category-push-1 D2).
    const at = toMs(row.updated_at);
    const since = toMs(pushSince);
    if (Number.isFinite(at) && Number.isFinite(since) && at <= since) return "none";
    return "unpush";
  }
  return "none";
}

// ---------------------------------------------------------------------------
// Effects — database + journey
// ---------------------------------------------------------------------------

type Caller = { entra_email?: string; entra_object_id?: string };

export interface PushResult {
  ok: boolean;
  error?: string;
  /** False when nothing needed writing (already starred / already pushed / not pushed). */
  applied: boolean;
  /** The task a node push starred (or already had starred), when there is one. */
  task?: { id: string; title: string } | null;
  message?: string;
}

async function star(caller: Caller, taskId: string): Promise<{ ok: boolean; error?: string }> {
  const { invokeJourneyTool } = await import("../journey/proxy.functions");
  const r = await invokeJourneyTool({
    toolName: "set_priority_rank",
    args: { task_id: taskId, rank: PUSH_RANK },
    caller,
    context: { source: "huddle" },
  });
  return { ok: !!r.ok, error: r.ok ? undefined : (r.error ?? "journey rejected the star") };
}

async function unstar(caller: Caller, taskId: string): Promise<{ ok: boolean; error?: string }> {
  const { invokeJourneyTool } = await import("../journey/proxy.functions");
  const r = await invokeJourneyTool({
    toolName: "set_priority_rank",
    args: { task_id: taskId, unset: true },
    caller,
    context: { source: "huddle" },
  });
  return { ok: !!r.ok, error: r.ok ? undefined : (r.error ?? "journey rejected the change") };
}

/** Task ids journey links to `topicId` (newest link wins, the phone's rule). Null when journey's topic
 *  list could not be read — the caller must then pick NOTHING rather than guess. */
async function topicTaskIds(caller: Caller, topicId: string): Promise<Set<string> | null> {
  const { fetchTopicPayload, findTopicMappings } = await import("./widgets.server");
  const t = await fetchTopicPayload(caller);
  if (!t.ok || t.payload === undefined) return null;
  const out = new Set<string>();
  for (const [taskId, tid] of findTopicMappings(t.payload)) if (tid === topicId) out.add(taskId);
  return out;
}

async function pickContext(email: string, caller: Caller, node: PushNode) {
  const { getPushCandidates } = await import("./tasks.server");
  const { taskIdsInReminderWindow } = await import("./turns.server");
  const [rows, inReminderWindow, topicIds] = await Promise.all([
    getPushCandidates(email),
    taskIdsInReminderWindow(email).catch(() => new Set<string>()),
    node.kind === "topic" ? topicTaskIds(caller, node.topicId) : Promise.resolve(undefined),
  ]);
  return {
    rows,
    inReminderWindow,
    topicTaskIds: topicIds ?? undefined,
    topicUnavailable: topicIds === null,
  };
}

/** Push ONE task ("I choose"). Ownership-checked; a task that is already starred is left exactly as is. */
export async function pushTask(email: string, caller: Caller, taskId: string): Promise<PushResult> {
  const { getOwnedTaskForConfirmAsk } = await import("./tasks.server");
  const owned = await getOwnedTaskForConfirmAsk(taskId, email);
  if (!owned) return { ok: false, applied: false, error: "Task not found." };
  const { getPushCandidate } = await import("./tasks.server");
  const row = await getPushCandidate(email, taskId);
  if (!row) return { ok: false, applied: false, error: "Task not found." };
  const s = upper(row.status);
  if (s === "DONE") return { ok: false, applied: false, error: "That task is already done." };
  if (s === "BLOCKED") return { ok: false, applied: false, error: "That task is blocked." };
  if (row.completed_at)
    return { ok: false, applied: false, error: "That task is marked complete." };
  if (isParkedRow(row))
    return { ok: false, applied: false, error: "That task is parked — bring it back first." };
  if (row.is_priority)
    return {
      ok: true,
      applied: false,
      task: { id: row.id, title: row.title },
      message: "Already in This Week.",
    };
  const r = await star(caller, taskId);
  if (!r.ok) return { ok: false, applied: false, error: r.error };
  return { ok: true, applied: true, task: { id: row.id, title: row.title } };
}

/** Take a task out of This Week. If a node push had starred it, that push ends too (nothing refills —
 *  the user removed it on purpose). */
export async function unstarTask(
  email: string,
  caller: Caller,
  taskId: string,
): Promise<PushResult> {
  const { getOwnedTaskForConfirmAsk, getPriorityPushes, deletePriorityPush } =
    await import("./tasks.server");
  const owned = await getOwnedTaskForConfirmAsk(taskId, email);
  if (!owned) return { ok: false, applied: false, error: "Task not found." };
  const r = await unstar(caller, taskId);
  if (!r.ok) return { ok: false, applied: false, error: r.error };
  for (const p of await getPriorityPushes(email)) {
    if (p.active_task_id === taskId) await deletePriorityPush(email, p.node_id);
  }
  return { ok: true, applied: true };
}

/** Push a category or topic ("you choose"). Idempotent: a node already pushed with a live star reports
 *  that star and writes nothing. A node with nothing to pick stays pushed and WAITS for its next task. */
export async function pushNode(
  email: string,
  caller: Caller,
  nodeId: string,
  nodeName: string | null,
): Promise<PushResult> {
  const node = parseNodeId(nodeId);
  if (!node) return { ok: false, applied: false, error: "That row can't be pushed." };
  const { getPriorityPushes, upsertPriorityPush, deletePriorityPush, getPushCandidate } =
    await import("./tasks.server");
  const existing = (await getPriorityPushes(email)).find((p) => p.node_id === nodeId);
  if (existing) {
    // Pushed and WAITING: re-pushing is the user asking again — try a fresh pick now rather than only
    // reporting "already pushed" (VERIFY-category-push-1 D10).
    if (!existing.active_task_id && (await refill(existing, null)) === "refilled") {
      const now = (await getPriorityPushes(email)).find((p) => p.node_id === nodeId);
      const t = now?.active_task_id ? await getPushCandidate(email, now.active_task_id) : null;
      return { ok: true, applied: true, task: t ? { id: t.id, title: t.title } : null };
    }
    const active = existing.active_task_id
      ? await getPushCandidate(email, existing.active_task_id)
      : null;
    return {
      ok: true,
      applied: false,
      task: active ? { id: active.id, title: active.title } : null,
      message: "Already pushed.",
    };
  }
  const ctx = await pickContext(email, caller, node);
  if (ctx.topicUnavailable) {
    return {
      ok: false,
      applied: false,
      error: "Couldn't read this topic's tasks from journey just now — try again.",
    };
  }
  const pick = pickForNode(ctx.rows, node, {
    topicTaskIds: ctx.topicTaskIds,
    inReminderWindow: ctx.inReminderWindow,
  });
  await upsertPriorityPush(email, nodeId, nodeName, pick?.id ?? null);
  if (!pick) {
    return {
      ok: true,
      applied: true,
      task: null,
      message: `Nothing to pick in ${nodeName ?? "this"} yet — the next task that lands there gets starred.`,
    };
  }
  const r = await star(caller, pick.id);
  if (!r.ok) {
    await deletePriorityPush(email, nodeId); // never leave a record claiming a star journey refused
    return { ok: false, applied: false, error: r.error };
  }
  return { ok: true, applied: true, task: { id: pick.id, title: pick.title } };
}

/** Stop pushing a node. Un-stars only the task THIS push starred, and only while it is still open. */
export async function unpushNode(
  email: string,
  caller: Caller,
  nodeId: string,
): Promise<PushResult> {
  const { getPriorityPushes, deletePriorityPush, getPushCandidate } =
    await import("./tasks.server");
  const existing = (await getPriorityPushes(email)).find((p) => p.node_id === nodeId);
  if (!existing) return { ok: true, applied: false };
  await deletePriorityPush(email, nodeId);
  if (existing.active_task_id) {
    const row = await getPushCandidate(email, existing.active_task_id);
    const open = row && !["DONE", "BLOCKED"].includes(upper(row.status)) && !row.completed_at;
    if (open) {
      const r = await unstar(caller, existing.active_task_id);
      if (!r.ok) return { ok: false, applied: true, error: r.error };
    }
  }
  return { ok: true, applied: true };
}

/**
 * Move a push from `finishedId` to its next task. The compare-and-set is the gate: whoever moves the
 * record first does the star write; a racing webhook delivery or reconcile tick finds the record already
 * moved and does nothing. If journey refuses the star, the record is put BACK so the next reconcile retries.
 */
async function refill(
  push: PriorityPushRow,
  finishedId: string | null,
): Promise<"refilled" | "waiting" | "lost-race" | "error"> {
  const email = push.user_email;
  const caller: Caller = { entra_email: email };
  const node = parseNodeId(push.node_id);
  if (!node) return "error";
  const { casPriorityPushActive, getPriorityPushes } = await import("./tasks.server");
  const ctx = await pickContext(email, caller, node);
  if (ctx.topicUnavailable) return "error"; // journey's topic list unreadable — leave it for the next tick
  const next = pickForNode(ctx.rows, node, {
    topicTaskIds: ctx.topicTaskIds,
    inReminderWindow: ctx.inReminderWindow,
    skip: finishedId,
  });
  const won = await casPriorityPushActive(email, push.node_id, finishedId, next?.id ?? null);
  if (!won) return "lost-race";
  if (!next) return "waiting";
  const r = await star(caller, next.id);
  if (!r.ok) {
    await casPriorityPushActive(email, push.node_id, next.id, finishedId);
    return "error";
  }
  // "Stop pushing" may have landed WHILE the star call was in flight: the push row is gone (or moved),
  // so this star has no push behind it. Take it back off rather than leave an orphan star in This Week
  // (VERIFY-category-push-1 D5).
  const still = (await getPriorityPushes(email)).find((p) => p.node_id === push.node_id);
  if (!still || still.active_task_id !== next.id) {
    await unstar(caller, next.id);
    return "lost-race";
  }
  return "refilled";
}

/**
 * The sync webhook's hook, called AFTER the mirror upsert/delete succeeded. Never throws: a refill
 * failure must not turn the webhook into a 500 (that would make journey's sync look broken), and the
 * next reconcile tick retries anything missed.
 */
export async function onMirrorEvent(
  op: string,
  task: Record<string, unknown> | undefined,
  ownerEmail: string | null,
): Promise<void> {
  try {
    const id = task?.id != null ? String(task.id) : null;
    if (!id) return;
    const { getPushesByActiveTask, getPriorityPushes, hasWaitingPushes } =
      await import("./tasks.server");
    const row = upper(op) === "DELETE" ? null : (task as unknown as PushCandidateRow);

    // 1. This task was some push's active task.
    for (const push of await getPushesByActiveTask(id)) {
      const node = parseNodeId(push.node_id);
      if (!node) continue;
      const ev = classifyActiveEvent(op, row, node, push.updated_at ?? null);
      if (ev === "refill") await refill(push, id);
      else if (ev === "unpush") {
        const { deletePriorityPush } = await import("./tasks.server");
        await deletePriorityPush(push.user_email, push.node_id);
      }
    }

    // 2. A push is WAITING and this task just became something it can star (a new task, or one
    //    unparked / unblocked). Only when the owner actually has a waiting push — one indexed count.
    //    Cheap filters first: the changed task must itself be starrable, and for a CATEGORY push it must
    //    be in that category — so an ordinary edit to an unrelated task costs one count query, no pick.
    if (row && ownerEmail && isPushEligible(row) && (await hasWaitingPushes(ownerEmail))) {
      for (const push of await getPriorityPushes(ownerEmail)) {
        if (push.active_task_id) continue;
        const node = parseNodeId(push.node_id);
        if (!node || (node.kind === "category" && !inNode(row, node))) continue;
        await refill(push, null);
      }
    }
  } catch (err) {
    console.error("[push] mirror event hook failed", err instanceof Error ? err.message : err);
  }
}

/** journey's own row for one task, read by id (user-scoped `explain_task_score`, which selects `*`).
 *  null = journey says it does not exist; "unknown" = could not tell (left for the next tick). */
async function journeyTaskState(
  caller: Caller,
  taskId: string,
): Promise<PushCandidateRow | null | "unknown"> {
  const { invokeJourneyTool } = await import("../journey/proxy.functions");
  const r = await invokeJourneyTool({
    toolName: "explain_task_score",
    args: { task_id: taskId },
    caller,
    context: { source: "huddle" },
  });
  if (!r.ok) return /not found/i.test(`${r.error ?? ""} ${r.output ?? ""}`) ? null : "unknown";
  try {
    const p = JSON.parse(r.output || "{}") as Record<string, unknown>;
    const t = (p.task ?? (p.result as Record<string, unknown> | undefined)?.task) as
      Record<string, unknown> | undefined;
    if (!t || t.id == null) return "unknown";
    return t as unknown as PushCandidateRow;
  } catch {
    return "unknown";
  }
}

/**
 * The safety net, run on the 9/13/17 auto-work tick. journey's sync is fire-and-forget and never
 * retried, so a lost "done" would strand a push forever if this read the MIRROR — the mirror is exactly
 * what is stale then. So each active task's state is read from JOURNEY (one read per pushed node, never
 * per backlog task). Waiting pushes get another pick.
 */
export async function reconcilePushes(
  email: string,
): Promise<{ checked: number; refilled: number; unpushed: number }> {
  const out = { checked: 0, refilled: 0, unpushed: 0 };
  try {
    const { getPriorityPushes, deletePriorityPush } = await import("./tasks.server");
    const caller: Caller = { entra_email: email };
    for (const push of await getPriorityPushes(email)) {
      out.checked++;
      if (!push.active_task_id) {
        if ((await refill(push, null)) === "refilled") out.refilled++;
        continue;
      }
      const state = await journeyTaskState(caller, push.active_task_id);
      if (state === "unknown") continue;
      const node = parseNodeId(push.node_id);
      if (!node) continue;
      const { getPushCandidate } = await import("./tasks.server");
      const merged =
        state === null
          ? null
          : mergeJourneyRow(await getPushCandidate(push.user_email, push.active_task_id), state);
      // The SAME classification the webhook uses, on journey's CURRENT row — so a lost "parked", "moved
      // to another category" or "un-starred" is caught here too, not only a lost "done"
      // (VERIFY-category-push-1 D10). journey's row is current, so no staleness cut-off applies.
      const ev = classifyActiveEvent(state === null ? "DELETE" : "UPDATE", merged, node);
      if (ev === "refill") {
        if ((await refill(push, push.active_task_id)) === "refilled") out.refilled++;
      } else if (ev === "unpush") {
        await deletePriorityPush(push.user_email, push.node_id);
        out.unpushed++;
      }
    }
  } catch (err) {
    console.error("[push] reconcile failed", err instanceof Error ? err.message : err);
  }
  return out;
}
