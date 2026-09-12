// WHAT:       The three server functions behind the two in-chat journey widgets: one read for the
//             SCHEDULE widget, one read for the PRIORITIES widget, one write for every widget
//             button (▶ start, ✓ done, ⏸ pause, ▲/✓ Today).
// WHY:        The widgets mirror journey's Android home widgets inside Huddle chat. Every
//             dependency already exists — the Azure mirror `tasks.journey_tasks` for the task
//             data, the journey proxy for the topic tree, journey's `update_task` /
//             `move_task_to_day` / `unschedule_task` for the writes — so this file composes them
//             and adds NO store, NO second query layer and NO second writer.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/LANE-B-widget-data.md records the DDL, tool schemas and proxy envelope exactly
//             as they were read, plus the tsc result.
//
// THE TWO ARCHITECTURAL RULES THIS FILE OBEYS (CLAUDE.md, "Prioritization & task-sync"):
//  1. THE MIRROR IS A SINGLE-WRITER READ-MODEL. Only the sync webhook writes
//     `tasks.journey_tasks`. So every read here goes to the mirror and every WRITE goes to
//     JOURNEY (`public.tasks`, the canonical source of truth) via invokeJourneyTool, letting the
//     pg_net trigger update the mirror. The ~1-3s propagation lag is EXPECTED, not a bug.
//  2. EMAIL-SCOPE EVERY QUERY. Reads go through resolveTaskEmail → getBoardTasks (which widens to
//     the caller's whole alias set); the write path re-checks ownership per task id before
//     touching anything.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type {
  PrioritiesWidgetData,
  ScheduleWidgetData,
  TopicTreeResult,
  WidgetActionResult,
  WidgetTaskAction,
} from "./widgets.server";

// pg / journey-fetch deps are imported dynamically inside the handlers so server-only code never
// bundles into the client (the same discipline board.functions.ts uses).

const Caller = z
  .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
  .optional();

/** The browser's IANA zone, when the client knows it. `resolveTimeZone` prefers the stored profile
 *  zone and falls back to this, then UTC — so a server/cron caller may omit it. */
const TimeZoneInput = z.string().max(64).optional();

async function resolveCallerEmail(caller: z.infer<typeof Caller>): Promise<string | null> {
  const { resolveTaskEmail } = await import("../journey/identity");
  return (await resolveTaskEmail(caller)) ?? caller?.entra_email ?? null;
}

// ---------------------------------------------------------------------------
// Widget 1 — SCHEDULE
// ---------------------------------------------------------------------------

/**
 * Data for the SCHEDULE widget: TODAY'S SCHEDULE + CURRENTLY DOING + UP NEXT (This Week).
 *
 * Composes the EXISTING email-scoped mirror read (`getBoardTasks`) rather than issuing its own
 * SQL, then slices it in the user's timezone (`buildScheduleSections`). An unsigned-in or failed
 * call returns `ok:false` with EMPTY sections — it never throws, so the widget always renders.
 *
 * `currentlyDoing: []` is a NORMAL result, not an error: the spec renders "Nothing in progress".
 */
export const getScheduleWidget = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, timeZone: TimeZoneInput }).parse(raw))
  .handler(async ({ data }): Promise<ScheduleWidgetData> => {
    const empty = (ok: boolean, timeZone: string, error?: string): ScheduleWidgetData => {
      const todayKey = new Date().toISOString().slice(0, 10);
      return {
        ok,
        error,
        timeZone,
        todayKey,
        weekStartKey: todayKey,
        weekEndKey: todayKey,
        todaySchedule: [],
        currentlyDoing: [],
        upNext: [],
      };
    };
    if (!data.caller?.entra_email) return empty(false, data.timeZone ?? "UTC", "Sign-in required.");
    try {
      const email = await resolveCallerEmail(data.caller);
      const { resolveTimeZone } = await import("../journey/identity");
      const { safeTimeZone, buildScheduleSections } = await import("./widgets.server");
      const timeZone = safeTimeZone(await resolveTimeZone(data.caller, data.timeZone));
      if (!email) return empty(false, timeZone, "Could not resolve your account.");
      const { getBoardTasks } = await import("./tasks.server");
      const rows = await getBoardTasks(email);
      const sections = buildScheduleSections(rows, timeZone, Date.now());
      return { ok: true, timeZone, ...sections };
    } catch (err) {
      return empty(false, data.timeZone ?? "UTC", err instanceof Error ? err.message : String(err));
    }
  });

// ---------------------------------------------------------------------------
// Widget 2 — PRIORITIES
// ---------------------------------------------------------------------------

/**
 * Journey's priorities TOPIC TREE, via the existing `invokeJourneyTool` passthrough.
 *
 * THIS MUST DEGRADE, NEVER THROW. The tool (`get_task_topics`) is Lane A's and may not be
 * deployed yet; the band half of the widget has to work regardless. Every failure becomes
 * `{ok:false, roots:[], reason}` that the UI renders as an empty state:
 *   not-configured → this environment has no JOURNEY_PROXY_URL/TOKEN
 *   tool-absent    → journey answered but doesn't know the tool yet
 *   error          → network / non-JSON / unparseable payload
 *
 * The response SHAPE is not yet pinned by Lane A (its doc records the tables and columns it reads
 * — `task_topic_index.{id,topic_name,position,category_affinity,parent_topic_id}` — but its
 * register step was still open when this was written), so `buildTopicTree` accepts either a
 * pre-nested tree or the flat parent_topic_id shape. See docs/LANE-B-widget-data.md.
 */
async function fetchTopicTree(caller: z.infer<typeof Caller>): Promise<TopicTreeResult> {
  const { buildTopicTree } = await import("./widgets.server");
  try {
    const { invokeJourneyTool } = await import("../journey/proxy.functions");
    const r = await invokeJourneyTool({
      toolName: "get_task_topics",
      args: {},
      caller: caller ?? {},
      context: { source: "huddle" },
    });
    if (!r.ok) {
      const detail = `${r.error ?? ""} ${r.output ?? ""}`.toLowerCase();
      // execute-tool reports an unregistered tool in its own words; treat any of these as
      // "not deployed yet" rather than a fault, because that is the pre-deploy steady state.
      const absent =
        detail.includes("unknown tool") ||
        detail.includes("unsupported tool") ||
        detail.includes("no such tool") ||
        detail.includes("tool not found") ||
        detail.includes("not implemented");
      return {
        ok: false,
        roots: [],
        reason: absent ? "tool-absent" : "error",
        error: r.error ?? "journey returned ok=false",
      };
    }
    // The proxy always hands back `output` as a STRING (it JSON.stringifies a non-string result —
    // huddle-proxy/index.ts), so parse it before normalizing. A plain-string message is not a tree.
    let payload: unknown = r.output;
    if (typeof r.output === "string") {
      try {
        payload = JSON.parse(r.output);
      } catch {
        return { ok: false, roots: [], reason: "error", error: "journey returned non-JSON output" };
      }
    }
    const roots = buildTopicTree(payload);
    return { ok: true, roots, reason: "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // journeyFetch throws this exact phrase when the env vars are missing.
    const unconfigured = msg.toLowerCase().includes("not configured");
    return { ok: false, roots: [], reason: unconfigured ? "not-configured" : "error", error: msg };
  }
}

/**
 * Data for the PRIORITIES widget: the task band (from the mirror) + journey's topic tree.
 *
 * The two halves are INDEPENDENT by design. A topic-tree failure leaves `ok:true` and a populated
 * band with `topics.ok:false` — half this widget must work before journey deploys anything. Only a
 * MIRROR failure sets the top-level `ok:false`.
 */
export const getPrioritiesWidget = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ caller: Caller, timeZone: TimeZoneInput, includeTopics: z.boolean().optional() }).parse(raw),
  )
  .handler(async ({ data }): Promise<PrioritiesWidgetData> => {
    const noTopics: TopicTreeResult = { ok: false, roots: [], reason: "ok" };
    const empty = (timeZone: string, error?: string): PrioritiesWidgetData => ({
      ok: false,
      error,
      timeZone,
      todayKey: new Date().toISOString().slice(0, 10),
      band: [],
      topics: noTopics,
    });
    if (!data.caller?.entra_email) return empty(data.timeZone ?? "UTC", "Sign-in required.");
    const wantTopics = data.includeTopics !== false;
    try {
      const email = await resolveCallerEmail(data.caller);
      const { resolveTimeZone } = await import("../journey/identity");
      const { safeTimeZone, localDateKey, buildPrioritiesBand } = await import("./widgets.server");
      const timeZone = safeTimeZone(await resolveTimeZone(data.caller, data.timeZone));
      if (!email) return empty(timeZone, "Could not resolve your account.");
      const { getBoardTasks } = await import("./tasks.server");
      // The band read and the topic passthrough are independent, so run them together rather than
      // making the widget wait for journey's round-trip before it can show anything.
      const [rows, topics] = await Promise.all([
        getBoardTasks(email),
        wantTopics ? fetchTopicTree(data.caller) : Promise.resolve(noTopics),
      ]);
      const nowMs = Date.now();
      return {
        ok: true,
        timeZone,
        todayKey: localDateKey(nowMs, timeZone) ?? new Date(nowMs).toISOString().slice(0, 10),
        band: buildPrioritiesBand(rows, timeZone, nowMs),
        topics,
      };
    } catch (err) {
      return empty(data.timeZone ?? "UTC", err instanceof Error ? err.message : String(err));
    }
  });

// ---------------------------------------------------------------------------
// Widget actions — one write path, journey-canonical
// ---------------------------------------------------------------------------

/**
 * Every widget button, in one server function.
 *
 *   ▶ start   → update_task status=DOING
 *   ✓ done    → update_task status=DONE
 *   ⏸ pause   → update_task status=UP_NEXT
 *   ▲ Today   → move_task_to_day {date: today in the user's tz}   (journey picks the time)
 *   ✓ Today   → unschedule_task                                    (toggling today OFF)
 *
 * NO SECOND WRITER. Like board.functions.ts's `updateBoardTask` and confirm-ask.functions.ts's
 * button actions, this writes JOURNEY through `invokeJourneyTool` and lets the sync trigger update
 * the mirror. The status values come from `update_task`'s own enum and the two scheduling tools
 * from journey's own catalog — all read this session, not recalled (see the doc).
 *
 * OWNERSHIP IS CHECKED FIRST, and it is checked the way the repo already does it:
 * `getOwnedTaskForConfirmAsk(taskId, email)` returns null for a task that does not exist OR is not
 * the caller's — indistinguishably, so a guessed/forged id cannot be used to probe or mutate.
 * `board.functions.ts` does NOT do this; the confirm-ask path added it precisely because nothing
 * below this layer has per-row access control. A widget button is the same kind of exposure.
 */
export const updateWidgetTask = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        taskId: z.string().min(1),
        action: z.enum(["start", "done", "pause", "today", "untoday"]),
        timeZone: TimeZoneInput,
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<WidgetActionResult> => {
    const action = data.action as WidgetTaskAction;
    const fail = (error: string): WidgetActionResult => ({
      ok: false,
      error,
      action,
      taskId: data.taskId,
      applied: false,
    });
    if (!data.caller?.entra_email) return fail("Sign-in required.");
    try {
      const email = await resolveCallerEmail(data.caller);
      if (!email) return fail("Could not resolve your account.");

      // Ownership gate. Same error for "doesn't exist" and "not yours" — see the helper's own note.
      const { getOwnedTaskForConfirmAsk } = await import("./tasks.server");
      const owned = await getOwnedTaskForConfirmAsk(data.taskId, email);
      if (!owned) return fail("Task not found.");

      const { ACTION_STATUS, safeTimeZone, localDateKey } = await import("./widgets.server");
      const { invokeJourneyTool } = await import("../journey/proxy.functions");

      let toolName: string;
      let args: Record<string, unknown>;
      let status: string | undefined;
      if (action === "today") {
        const { resolveTimeZone } = await import("../journey/identity");
        const timeZone = safeTimeZone(await resolveTimeZone(data.caller, data.timeZone));
        const dateKey = localDateKey(Date.now(), timeZone);
        if (!dateKey) return fail("Could not resolve today's date.");
        // move_task_to_day takes YYYY-MM-DD and lets journey's scheduler choose the slot — which is
        // what the widget's "Today" affordance means (put it on today), not "start it at 10:00".
        toolName = "move_task_to_day";
        args = { task_id: data.taskId, date: dateKey };
      } else if (action === "untoday") {
        toolName = "unschedule_task";
        args = { task_id: data.taskId };
      } else {
        status = ACTION_STATUS[action];
        toolName = "update_task";
        args = { task_id: data.taskId, status };
      }

      const r = await invokeJourneyTool({
        toolName,
        args,
        caller: data.caller,
        context: { source: "huddle" },
      });
      return {
        ok: r.ok,
        error: r.ok ? undefined : (r.error ?? "journey rejected the change"),
        action,
        taskId: data.taskId,
        status,
        applied: r.ok,
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
