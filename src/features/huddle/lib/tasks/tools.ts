// The reusable, agent-callable prioritization tool. Any agent can call `prioritize`
// with a dynamic category; it scores the user's mirrored journey tasks (Azure PG) with the
// ported journey engine and returns a ranked list. Shared like the router — Iris (day),
// Liam (life), Tess (product), Sam (venture) all use the same tool with a different category.
// Modeled on rag/tools.ts (schema + dispatch + system hint).
import { formatInTz } from "../time";

export const PRIORITIZE_TOOL = {
  type: "function",
  // Wire name the model calls. Renamed from "prioritize" (unintuitive for schedule asks) to
  // "schedule_and_priorities" — it serves BOTH the day/schedule and the backlog/priorities lanes via
  // `view`. The JS const stays PRIORITIZE_TOOL and the dispatcher stays dispatchPrioritize (internal).
  name: "schedule_and_priorities",
  description:
    "Read and rank the user's real SCHEDULE and tasks from their live schedule data — their nightly-planned schedule (the scheduled items for a day) plus their open tasks/backlog, scored by priority, due dates, and staleness. This is the source of truth and the ONLY way to answer ANY question about the user's schedule, calendar, agenda, day, \"what's on my calendar/plate/today\", meetings, appointments, free/busy, tasks, backlog, priorities, or what's next — never answer those from memory or a guess. For \"what's on my schedule/calendar/day today\" use view 'scheduled'. Use `view` to pick the slice, optionally scoped to a `category`. (ONLY an explicit \"external calendar\" / \"Outlook calendar\" ask should use get_external_calendar_events instead.) Returns a scored, ordered list.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      view: {
        type: "string",
        enum: ["priorities", "backlog", "up_next", "scheduled", "overdue"],
        description:
          "Which slice to return (default 'priorities'). 'priorities' = ranked across all open tasks (what to focus on). 'backlog' = tasks not yet scheduled onto a day. 'up_next' = tasks explicitly marked up-next or on the priority lane. 'scheduled' = tasks already placed on a day/time. 'overdue' = past their due date. All slices are returned ranked by the same scoring.",
      },
      category: {
        type: "string",
        description:
          "Optional domain to scope to, e.g. LIFE, VENTURES, CAREER, EDUCATION, PERSONAL, PROF_EDUCATION. Omit to span everything. Composes with any view (e.g. view='priorities', category='CAREER').",
      },
      limit: { type: "number", description: "Max items to return (default 10)." },
    },
    required: [],
  },
  strict: false,
} as const;

/** Max rows rendered inline. Beyond this the widget shows "+N more" rather than swallowing the thread. */
export const CHECKLIST_MAX_ROWS = 10;

// The in-chat CHECKLIST widget. Deliberately a SEPARATE tool from schedule_and_priorities rather than a
// flag on it, because the two answer different asks: "what are the tasks about my kids" wants prose, and
// only an explicit request for a checklist should render tick-boxes. Making that a distinct tool lets the
// model's own tool choice BE the intent gate, instead of a keyword regex over the user's message — the
// same reason routing lives in the LLM router and not in a verb list.
export const CHECKLIST_TOOL = {
  type: "function",
  name: "build_checklist",
  description:
    "Render an INTERACTIVE CHECKLIST of the user's existing tasks in the chat: tick-boxes that mark a task done, plus a per-row control to move it to Doing, Backlog, or the parking lot. ONLY call this when the user EXPLICITLY asks for a checklist or to 'track' items as one — e.g. 'give me a checklist of...', 'make a checklist for...', 'what do I need to track for X, as a checklist'. Do NOT call it for an ordinary question about tasks: 'what are the tasks related to my kids', 'what's on my plate', 'list my backlog' all want a NORMAL PROSE ANSWER from schedule_and_priorities, not a checklist. If you are unsure which the user wants, answer in prose and offer to turn it into a checklist. First call schedule_and_priorities to find the relevant tasks, then pass THOSE task ids here — never invent an id.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: {
        type: "string",
        description:
          "Short heading for the checklist describing what it covers, e.g. 'Kids — things to track'. Keep it under ~40 characters; the chat column is narrow.",
      },
      task_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "The journey task ids to include, in the order they should appear. Get these from a schedule_and_priorities call in this same turn. Ids that do not belong to this user are dropped.",
      },
    },
    required: ["title", "task_ids"],
  },
  strict: false,
} as const;

export const CHECKLIST_SYSTEM_HINT =
  "When the user EXPLICITLY asks for a checklist (\"give me a checklist of…\", \"make a checklist for…\", \"what do I need to track for X as a checklist\"), call `schedule_and_priorities` to find the relevant tasks and then `build_checklist` with those task ids — the app renders it as real tick-boxes wired to their board. An ordinary question about tasks (\"what are the tasks related to my kids\", \"what's on my plate\") is NOT a checklist request: answer it in prose. When you do render a checklist, keep your own message SHORT — one line of context at most — because the checklist itself is the answer; do not also list the tasks in text.";

/**
 * Execute a `build_checklist` call. Returns a JSON string for the model AND the structured payload the
 * client renders. Ids are resolved against the user's own mirror rows, which is what scopes the widget
 * to its owner: an id belonging to someone else simply is not found, so it cannot be rendered or acted on.
 */
export async function dispatchBuildChecklist(
  userEmail: string | undefined,
  args: Record<string, unknown>,
): Promise<string> {
  if (!userEmail) {
    return JSON.stringify({
      error: "no_caller_identity",
      message: "A checklist needs the signed-in user's email; none was provided this turn.",
    });
  }
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Checklist";
  const rawIds = Array.isArray(args.task_ids) ? args.task_ids : [];
  const ids = rawIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (!ids.length) {
    console.info(`[checklist] SKIPPED title=${JSON.stringify(title)} reason=no_task_ids`);
    return JSON.stringify({
      error: "no_task_ids",
      message: "No task ids were supplied. Call schedule_and_priorities first, then pass its task ids.",
    });
  }
  try {
    const { getBoardTasks } = await import("./tasks.server");
    // Reading the user's OWN rows is the ownership check — nothing else is needed, and nothing weaker
    // would do: filtering ids client-side would let a hallucinated or borrowed id through.
    const mine = await getBoardTasks(userEmail);
    const byId = new Map(mine.map((t) => [t.id, t]));
    const found = ids.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => Boolean(t));
    if (!found.length) {
      console.info(
        `[checklist] SKIPPED title=${JSON.stringify(title)} reason=no_matching_tasks requested=${ids.length}`,
      );
      return JSON.stringify({
        error: "no_matching_tasks",
        message: "None of those task ids are on this user's board. Re-read their tasks and try again.",
      });
    }
    const shown = found.slice(0, CHECKLIST_MAX_ROWS);
    // Log the DECISION, not just the outcome. Intent gating is a model tool-choice, so without a
    // recorded reason a wrong call is indistinguishable from the tool never having been offered --
    // the same blindness that had six rounds of router prompt-tweaks chasing a quota fallback until
    // decision.reason was surfaced. `requested` vs `matched` is what shows a hallucinated id.
    console.info(
      `[checklist] rendered title=${JSON.stringify(title)} requested=${ids.length} matched=${found.length} shown=${shown.length}`,
    );
    const payload = {
      title,
      rows: shown.map((t) => ({
        taskId: t.id,
        title: t.title,
        status: (t.status ?? "BACKLOG").toUpperCase(),
        tags: t.tags ?? [],
      })),
      ...(found.length > shown.length ? { more: found.length - shown.length } : {}),
    };
    // `checklist` is the key the reply-assembly looks for; `rendered` tells the model the widget is
    // already on screen so it does not also list every task in prose underneath it.
    return JSON.stringify({
      rendered: true,
      dropped: ids.length - found.length,
      checklist: payload,
      message: `Checklist rendered with ${payload.rows.length} item(s). Do not repeat the items in your reply.`,
    });
  } catch (err) {
    console.info(`[checklist] SKIPPED title=${JSON.stringify(title)} reason=exception`);
    return JSON.stringify({
      error: "checklist_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export const PRIORITIZE_SYSTEM_HINT =
  "For ANY question about the user's schedule, calendar, agenda, day, tasks, backlog, priorities, meetings, appointments, free/busy, or what to do next — including 'what's on my schedule/calendar/day today', 'what's on my plate', 'what's in my backlog', 'what's up next', 'what's overdue', 'what are my <area> priorities' — call the `schedule_and_priorities` tool and answer from its ranked results. It is the user's nightly-planned schedule + tasks, the source of truth. Use view 'scheduled' for 'what's on my schedule/calendar/day today'; otherwise pick the matching `view` (backlog / up_next / overdue / priorities) and the relevant `category`. Only an EXPLICIT 'external calendar' / 'Outlook calendar' request should use get_external_calendar_events instead. The start/due times it returns are ALREADY in the user's local timezone (each carries its zone abbreviation, e.g. '10:00 AM EDT') — state them exactly as given; do NOT convert or shift them. Never invent an ordering, and never tell the user their tasks/schedule aren't in your files or ask them to upload anything. If it returns an error, say you couldn't reach their schedule and offer to retry.";

/**
 * Execute a `prioritize` (schedule_and_priorities) tool call. Returns a JSON string (the model reads
 * it verbatim). `userEmail` is the caller's identity (data.caller.entra_email); without it we cannot
 * scope to the user's tasks. `timeZone` (IANA, e.g. "America/New_York") localizes the returned times.
 */
export async function dispatchPrioritize(
  userEmail: string | undefined,
  args: Record<string, unknown>,
  timeZone?: string,
): Promise<string> {
  if (!userEmail) {
    return JSON.stringify({
      error: "no_caller_identity",
      message: "Prioritization needs the signed-in user's email; none was provided this turn.",
    });
  }
  const category = typeof args.category === "string" && args.category.trim() ? args.category.trim() : undefined;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 25) : 10;
  const VIEWS = new Set(["priorities", "backlog", "up_next", "scheduled", "overdue"]);
  const view = typeof args.view === "string" && VIEWS.has(args.view) ? args.view : "priorities";

  try {
    const { getTasksForUser } = await import("./tasks.server");
    const { rankTasks } = await import("./scoring");
    const tasks = await getTasksForUser(userEmail, category);
    // View = a filter over the same open-task set; ranking stays single-sourced via rankTasks.
    const now = Date.now();
    const inView = tasks.filter((t) => {
      switch (view) {
        case "backlog":
          return !t.is_scheduled;
        case "up_next":
          return t.status === "UP_NEXT" || t.is_priority;
        case "scheduled":
          return !!t.is_scheduled;
        case "overdue":
          return !!t.due_date && new Date(t.due_date).getTime() < now;
        default:
          return true; // "priorities" — all open tasks
      }
    });
    const ranked = rankTasks(inView, limit);
    const tz = timeZone || "UTC";
    return JSON.stringify({
      view,
      category: category ?? "all",
      count: ranked.length,
      // Times below are ALREADY in this timezone (with the zone abbreviation) — read them as-is.
      timezone: tz,
      ranked: ranked.map((r, i) => ({
        rank: i + 1,
        title: r.title,
        category: r.category,
        status: r.status,
        is_scheduled: r.is_scheduled,
        due_date: formatInTz(r.due_date, tz),
        start_time: formatInTz(r.start_time, tz),
        score: r.score,
        why: r.why,
      })),
    });
  } catch (err) {
    return JSON.stringify({
      error: "prioritize_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
