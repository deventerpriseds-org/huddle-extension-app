// The reusable, agent-callable prioritization tool. Any agent can call `prioritize`
// with a dynamic category; it scores the user's mirrored journey tasks (Azure PG) with the
// ported journey engine and returns a ranked list. Shared like the router — Iris (day),
// Liam (life), Tess (product), Sam (venture) all use the same tool with a different category.
// Modeled on rag/tools.ts (schema + dispatch + system hint).

export const PRIORITIZE_TOOL = {
  type: "function",
  name: "prioritize",
  description:
    "Read and rank the user's real SCHEDULE and tasks from their live data. This is the user's COMBINED nightly schedule — their tasks AND their external calendar items already merged — plus priority/due-date/staleness scoring, and it is the source of truth. It is the ONLY way to answer ANY question about the user's schedule, calendar, agenda, day, \"what's on my calendar/plate/today\", meetings, appointments, free/busy, tasks, backlog, priorities, or what's next — never answer those from memory or a guess. For \"what's on my schedule/calendar/day today\" use view 'scheduled'. Use `view` to pick the slice, optionally scoped to a `category`. (ONLY an explicit \"external calendar\" / \"Outlook calendar\" ask should use get_calendar_events instead of this.) Returns a scored, ordered list.",
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

export const PRIORITIZE_SYSTEM_HINT =
  "For ANY question about the user's schedule, calendar, agenda, day, tasks, backlog, priorities, meetings, appointments, free/busy, or what to do next — including 'what's on my schedule/calendar/day today', 'what's on my plate', 'what's in my backlog', 'what's up next', 'what's overdue', 'what are my <area> priorities' — call the `prioritize` tool and answer from its ranked results. It is the user's COMBINED nightly schedule (tasks + external calendar already merged), the source of truth. Use view 'scheduled' for 'what's on my schedule/calendar/day today'; otherwise pick the matching `view` (backlog / up_next / overdue / priorities) and the relevant `category`. Only an EXPLICIT 'external calendar' / 'Outlook calendar' request should use get_calendar_events instead. Never invent an ordering, and never tell the user their tasks/schedule aren't in your files or ask them to upload anything. If it returns an error, say you couldn't reach their schedule and offer to retry.";

/**
 * Execute a `prioritize` tool call. Returns a JSON string (the model reads it verbatim).
 * `userEmail` is the caller's identity (data.caller.entra_email); without it we cannot scope
 * to the user's tasks.
 */
export async function dispatchPrioritize(
  userEmail: string | undefined,
  args: Record<string, unknown>,
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
    return JSON.stringify({
      view,
      category: category ?? "all",
      count: ranked.length,
      ranked: ranked.map((r, i) => ({
        rank: i + 1,
        title: r.title,
        category: r.category,
        status: r.status,
        is_scheduled: r.is_scheduled,
        due_date: r.due_date,
        start_time: r.start_time,
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
