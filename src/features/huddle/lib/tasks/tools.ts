// The reusable, agent-callable prioritization tool. Any agent can call `prioritize`
// with a dynamic category; it scores the user's mirrored journey tasks (Azure PG) with the
// ported journey engine and returns a ranked list. Shared like the router — Iris (day),
// Liam (life), Tess (product), Sam (venture) all use the same tool with a different category.
// Modeled on rag/tools.ts (schema + dispatch + system hint).
import { formatInTz } from "../time";
// Type-only: the widget payload contract (Lane B). `widgets.server.ts` is dependency-free, and this
// import is erased, so requiring it here costs nothing at runtime but makes the two widget
// dispatchers below type-checked against the same shape the client renders.
import type { PrioritiesWidgetData, ScheduleWidgetData } from "./widgets.server";

export const PRIORITIZE_TOOL = {
  type: "function",
  // Wire name the model calls. Renamed from "prioritize" (unintuitive for schedule asks) to
  // "schedule_and_priorities" — it serves BOTH the day/schedule and the backlog/priorities lanes via
  // `view`. The JS const stays PRIORITIZE_TOOL and the dispatcher stays dispatchPrioritize (internal).
  name: "schedule_and_priorities",
  description:
    "Read and rank the user's real SCHEDULE and tasks from their live schedule data — their nightly-planned schedule (the scheduled items for a day) plus their open tasks/backlog, scored by priority, due dates, and staleness. This is the source of truth and the ONLY way to answer ANY question about the user's schedule, calendar, agenda, day, \"what's on my calendar/plate/today\", meetings, appointments, free/busy, tasks, backlog, priorities, or what's next — never answer those from memory or a guess. For \"what's on my schedule/calendar/day today\" use view 'scheduled' — it returns that ONE day's meetings, classes AND tasks together, merged in time order and labelled (pass `date` for another day). Use `view` to pick the slice, optionally scoped to a `category`. (ONLY an explicit \"external calendar\" / \"Outlook calendar\" ask should use get_external_calendar_events instead.) Returns a scored, ordered list.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      view: {
        type: "string",
        enum: ["priorities", "backlog", "up_next", "scheduled", "overdue", "blocked"],
        description:
          "Which slice to return (default 'priorities'). 'priorities' = ranked across all open tasks (what to focus on). 'backlog' = tasks not yet scheduled onto a day. 'up_next' = tasks explicitly marked up-next or on the priority lane. 'scheduled' = tasks already placed on a day/time (returns EVERY scheduled item unless you pass a limit). 'overdue' = past their due date. All slices are returned ranked by the same scoring. 'blocked' = ONLY the user's BLOCKED tasks, in the `blocked` array, with the blocker reason — use it for 'anything blocking me?', 'what's stuck?'.",
      },
      include_blocked: {
        type: "boolean",
        description:
          "Set true for ANY blocker or status question ('anything blocking me?', 'what's stuck?', 'where do things stand?', 'status of my work'). BLOCKED tasks are never in the ranked list; with this set they come back separately in `blocked` (with `blocker_reason`) and `blocked_count`. Without it you CANNOT see blocked tasks, so never say 'no blockers' unless you set this and `blocked_count` is 0.",
      },
      category: {
        type: "string",
        description:
          "Optional domain to scope to, e.g. LIFE, VENTURES, JOB, CAREER, EDUCATION, PERSONAL, PROF_EDUCATION (JOB = work for the user's employer; CAREER = getting their next role). Omit to span everything. Composes with any view (e.g. view='priorities', category='CAREER').",
      },
      date: {
        type: "string",
        description:
          "For view 'scheduled' only: which day. Omit (or 'today') for today, 'tomorrow', a weekday name like 'thursday' (the next one, today included), yyyy-mm-dd, or 'all' for every scheduled TASK on every day (tasks only, no calendar).",
      },
      limit: {
        type: "number",
        description:
          "Max items to return (default 10; view 'scheduled' defaults to every item, maximum 200). Pass a HIGH value (e.g. 200) whenever the user wants the COMPLETE set rather than a summary -- in particular before build_checklist, which should list everything that matches, not a sample.",
      },
    },
    required: [],
  },
  strict: false,
} as const;

// NO ROW CAP, deliberately. An earlier version sliced to 10 and showed a "+N more -- open the board"
// link. That was wrong twice over: it hid part of the answer the user asked for, and the escape hatch
// sent them to a surface that does NOT have the checklist's controls, so the hidden items were harder
// to act on than the visible ones. The checklist renders everything the query resolved, however long.

// The in-chat CHECKLIST widget. Deliberately a SEPARATE tool from schedule_and_priorities rather than a
// flag on it, because the two answer different asks: "what are the tasks about my kids" wants prose, and
// only an explicit request for a checklist should render tick-boxes. Making that a distinct tool lets the
// model's own tool choice BE the intent gate, instead of a keyword regex over the user's message — the
// same reason routing lives in the LLM router and not in a verb list.
export const CHECKLIST_TOOL = {
  type: "function",
  name: "build_checklist",
  description:
    "Render an INTERACTIVE CHECKLIST of the user's existing tasks in the chat: tick-boxes that mark a task done, plus a per-row control to move it to Doing, Backlog, or the parking lot. ONLY call this when the user EXPLICITLY asks for a checklist or to 'track' items as one — e.g. 'give me a checklist of...', 'make a checklist for...', 'what do I need to track for X, as a checklist'. Do NOT call it for an ordinary question about tasks: 'what are the tasks related to my kids', 'what's on my plate', 'list my backlog' all want a NORMAL PROSE ANSWER from schedule_and_priorities, not a checklist. If you are unsure which the user wants, answer in prose and offer to turn it into a checklist. For a CATEGORY of work (\"financial tasks\", \"kids stuff\") pass `match` keywords and let the app sweep every open task — that is complete by construction. Only pass `task_ids` for a specific hand-picked set.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: {
        type: "string",
        description:
          "Short heading for the checklist describing what it covers, e.g. 'Kids — things to track'. Keep it under ~40 characters; the chat column is narrow.",
      },
      match: {
        type: "array",
        items: { type: "string" },
        description:
          "PREFERRED. Keywords describing the set the user asked for; the app sweeps ALL of their open tasks server-side and includes every one whose title, tags or category contains ANY of these terms. Use this instead of task_ids whenever the ask is a CATEGORY of work ('financial tasks', 'kids stuff', 'house things') -- it guarantees nothing is missed. Be generous and concrete: for finance use e.g. [\"financ\",\"pay\",\"transfer\",\"bill\",\"card\",\"amex\",\"klarna\",\"hsa\",\"budget\",\"bank\"].",
      },
      category: {
        type: "string",
        description:
          "Optional journey category to scope the sweep to (e.g. LIFE, VENTURES, JOB, CAREER; JOB = work for the user's employer; CAREER = getting their next role). Composes with `match`.",
      },
      task_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Only for an EXPLICIT, hand-picked set of specific tasks. For any category-shaped ask use `match` instead -- enumerating ids means YOU are doing the filtering, which silently drops tasks. When given, these ids are used verbatim and `match` is ignored.",
      },
      // Task proposals (2026-11-12, AC-correspondence-checklist section 5): the SAME widget, a second row
      // kind. Inert unless HUDDLE_ONEDRIVE_FEEDS.correspondence.proposals is on (the dispatcher says so).
      proposals: {
        type: "boolean",
        description:
          "Set true ONLY when the user asks to see their PROPOSED tasks -- to-dos found in their email, Teams chats or meetings that are waiting for them to approve, edit, mark done or dismiss (e.g. 'show my proposed tasks'). Ignores match/task_ids. These are suggestions, NOT tasks on their board.",
      },
    },
    required: ["title"],
  },
  strict: false,
} as const;

export const CHECKLIST_SYSTEM_HINT =
  "When the user EXPLICITLY asks for a checklist (\"give me a checklist of…\", \"make a checklist for…\", \"what do I need to track for X as a checklist\"), call `build_checklist` with `match` keywords describing the set (e.g. financial -> [\"financ\",\"pay\",\"transfer\",\"bill\",\"card\",\"amex\",\"klarna\",\"hsa\",\"budget\"]). The app sweeps ALL their open tasks itself, so nothing is missed -- do NOT hand-pick ids for a category-shaped ask, and do not pre-filter with schedule_and_priorities first — the app renders it as real tick-boxes wired to their board. An ordinary question about tasks (\"what are the tasks related to my kids\", \"what's on my plate\") is NOT a checklist request: answer it in prose. When you do render a checklist, keep your own message SHORT — one line of context at most — because the checklist itself is the answer; do not also list the tasks in text.";

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
  // Proposals mode: the same widget, proposal rows from the server-side proposal store (AC-5.15).
  if (args.proposals === true) {
    try {
      const { proposalChecklistForUser } = await import("../proposals/proposals.server");
      const out = await proposalChecklistForUser(userEmail);
      console.info(`[checklist] proposals mode ${JSON.parse(out).error ?? "rendered"}`);
      return out;
    } catch {
      console.info("[checklist] SKIPPED reason=proposals_exception");
      return JSON.stringify({ error: "checklist_failed", message: "Could not load the proposed tasks." });
    }
  }
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Checklist";
  const rawIds = Array.isArray(args.task_ids) ? args.task_ids : [];
  const ids = rawIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  const terms = (Array.isArray(args.match) ? args.match : [])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().toLowerCase());
  const category = typeof args.category === "string" && args.category.trim() ? args.category.trim().toLowerCase() : "";
  if (!ids.length && !terms.length && !category) {
    console.info(`[checklist] SKIPPED title=${JSON.stringify(title)} reason=no_selector`);
    return JSON.stringify({
      error: "no_selector",
      message:
        "Supply `match` keywords (preferred) or explicit `task_ids`. For a category of work, use `match` so nothing is missed.",
    });
  }
  try {
    const { getBoardTasks } = await import("./tasks.server");
    // Reading the user's OWN rows is the ownership check — nothing else is needed, and nothing weaker
    // would do: filtering ids client-side would let a hallucinated or borrowed id through.
    const mine = await getBoardTasks(userEmail);
    let found: typeof mine;
    let mode: string;
    if (ids.length) {
      const byId = new Map(mine.map((t) => [t.id, t]));
      found = ids.map((id) => byId.get(id)).filter((t): t is (typeof mine)[number] => Boolean(t));
      mode = "ids";
    } else {
      // SERVER-SIDE SWEEP. This exists because the id-only contract made the MODEL the filter: it had
      // to judge every task AND transcribe 36-char UUIDs across the user's whole board. Measured on a
      // 68-task board, the same "checklist of my financial tasks" returned 12 one turn and 11 the next
      // with NO code change between them, and the owner's reply was "this ain't everything". A keyword
      // sweep over the real rows is deterministic and complete: the same ask returns the same set, and
      // the set is decided by the data rather than by what the model managed to recall.
      const open = mine.filter((t) => (t.status ?? "").toUpperCase() !== "DONE");
      const scoped = category
        ? open.filter((t) => (t.category ?? "").toLowerCase().includes(category))
        : open;
      found = terms.length
        ? scoped.filter((t) => {
            // Match across title, tags AND category — the finance rows on this board carry EMPTY tags,
            // so a tags-only filter would have missed exactly the items the owner said were absent.
            const hay = `${t.title ?? ""} ${(t.tags ?? []).join(" ")} ${t.category ?? ""}`.toLowerCase();
            return terms.some((term) => hay.includes(term));
          })
        : scoped;
      mode = `sweep(terms=${terms.length},category=${category || "-"})`;
    }
    if (!found.length) {
      console.info(
        `[checklist] SKIPPED title=${JSON.stringify(title)} reason=no_matching_tasks mode=${mode} requested=${ids.length}`,
      );
      return JSON.stringify({
        error: "no_matching_tasks",
        message: "Nothing on this user's board matched. Widen the `match` keywords and try again.",
      });
    }
    const shown = found;
    // Log the DECISION, not just the outcome. Intent gating is a model tool-choice, so without a
    // recorded reason a wrong call is indistinguishable from the tool never having been offered --
    // the same blindness that had six rounds of router prompt-tweaks chasing a quota fallback until
    // decision.reason was surfaced. `requested` vs `matched` is what shows a hallucinated id.
    console.info(
      `[checklist] rendered title=${JSON.stringify(title)} mode=${mode} requested=${ids.length} matched=${found.length} shown=${shown.length}`,
    );
    const payload = {
      title,
      rows: shown.map((t) => ({
        taskId: t.id,
        title: t.title,
        status: (t.status ?? "BACKLOG").toUpperCase(),
        tags: t.tags ?? [],
      })),
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

/* ══ The two journey home widgets, as agent-invokable in-chat widgets ════════════════════════════
 * Modelled on CHECKLIST_TOOL directly above: a tool whose result carries a structured payload the
 * client renders, plus a system hint that makes the MODEL'S TOOL CHOICE the intent gate rather than a
 * keyword regex over the user's message. Spec: docs/widgets/spec-*.jpg; UI: components/JourneyWidgets.tsx.
 *
 * WHY SEPARATE FROM schedule_and_priorities, which reads the same mirror: that tool answers in PROSE.
 * These render an interactive card. "What's on my plate" wants the former; "show me my priorities
 * widget" wants the latter. Two tools let the model's own tool choice decide; one tool with a flag
 * would need a keyword regex over the user's message, which is what we do not do here.
 *
 * THE PAYLOADS ARE LANE B'S, COMPOSED BY LANE B'S OWN FUNCTIONS. These dispatchers call
 * `buildScheduleSections` / `buildPrioritiesBand` from `widgets.server.ts` over the same
 * `getBoardTasks` read its server fns use, so a widget an agent surfaces and a widget the user opens
 * from the side menu are byte-for-byte the same shape. A second composition here would be a second
 * definition of "today" and "up next" — exactly the divergence the mirror-is-one-read-model rule
 * exists to prevent. Nothing in this file re-derives a section.
 *
 * NO ROW CAP in either dispatcher, deliberately — same rule as the checklist above. The widget
 * scrolls; it never truncates and never offers a "+N more" escape hatch.
 *
 * These two names are also in `breadcrumbToolsFor`'s HIDDEN_FROM_BREADCRUMBS set (data/seed.ts): the
 * tool `detail` carries the whole payload, and the breadcrumb chip renders `detail` into its tooltip,
 * so leaving them in dumps raw JSON on hover for a widget already visible on screen. */

export const PRIORITIES_WIDGET_TOOL = {
  type: "function",
  name: "show_priorities_widget",
  description:
    "Render the user's PRIORITIES WIDGET in the chat: an interactive card listing their priority tasks, each with its category chip and a toggle for whether it sits on today, plus journey's topic breakdown with counts. ONLY call this when the user asks for the WIDGET or for an interactive/tappable view — e.g. 'show me my priorities widget', 'pull up priorities', 'show my priorities so I can move things to today'. An ordinary question about priorities ('what are my top priorities', 'what should I focus on') wants a NORMAL PROSE ANSWER from schedule_and_priorities instead. If you are unsure which the user wants, answer in prose and offer the widget.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: {
        type: "string",
        description:
          "Optional heading for the card. Defaults to 'Priorities'. Keep it under ~30 characters; the chat column is narrow.",
      },
    },
    required: [],
  },
  strict: false,
} as const;

export const SCHEDULE_WIDGET_TOOL = {
  type: "function",
  name: "show_schedule_widget",
  description:
    "Render the user's SCHEDULE WIDGET in the chat: an interactive card with today's timed schedule (each row startable and completable), what they are currently doing, and what is up next this week. ONLY call this when the user asks for the WIDGET or an interactive view of their day — e.g. 'show me my schedule widget', 'pull up my schedule', 'show my day so I can start things'. An ordinary 'what's on my schedule today' wants a PROSE answer from schedule_and_priorities with view 'scheduled'. If you are unsure, answer in prose and offer the widget.",
  parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
  strict: false,
} as const;

export const WIDGET_SYSTEM_HINT =
  "Two of the user's journey home widgets are available IN CHAT as interactive cards: `show_priorities_widget` (their priority tasks with category chips and a Today toggle, plus journey's topic breakdown) and `show_schedule_widget` (today's timed schedule with start/done controls, what they're currently doing, and what's up next this week). Call one ONLY when the user asks for the WIDGET itself or for a tappable/interactive view (\"show me my priorities widget\", \"pull up my schedule so I can start something\"). A plain question about their day, priorities or backlog is NOT a widget request — answer that in prose from `schedule_and_priorities`. When you do render a widget, keep your own message to ONE short line: the widget IS the answer, so do not also list its rows in text.";

/**
 * Execute `show_priorities_widget`.
 *
 * Ownership works exactly as it does for the checklist: the rows come from the caller's OWN
 * email-scoped mirror read, so a task belonging to someone else simply is not there to render.
 *
 * The topic tree IS fetched here now, BOUNDED. This used to skip it, on the sound reasoning that a
 * tool call inside an agent's turn is the worst place to spend journey latency. But this is the card
 * the owner actually reads (a scheduled 6am/8pm check is posted through this path), and he needs
 * the Category -> Topic -> Task layer on it. So the call happens with a ceiling
 * (TOPIC_FETCH_TIMEOUT_MS): a slow or missing journey degrades the card to the category-only tree,
 * never to an error and never to a stalled reply.
 */
export async function dispatchPrioritiesWidget(
  userEmail: string | undefined,
  args: Record<string, unknown>,
  timeZone?: string,
): Promise<string> {
  if (!userEmail) {
    return JSON.stringify({
      error: "no_caller_identity",
      message: "The priorities widget needs the signed-in user's email; none was provided this turn.",
    });
  }
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Priorities";
  try {
    const { safeTimeZone, composePrioritiesWidget } = await import("./widgets.server");
    const tz = safeTimeZone(timeZone);
    // THE ONE composition — same band, same ordering and the SAME CATEGORY TREE the docked widget
    // and the Settings view render. This used to build its own payload with a hardcoded
    // `topics: {ok:false, roots:[], reason:"ok"}`, so an agent-surfaced card showed "No topics yet."
    // while the identical data rendered a full tree on the other surfaces. Measured on the owner's
    // own 6am/8pm check card, 2026-10-15.
    //
    // ANNOTATED, not inferred: the result of this function is a JSON *string*, so tsc cannot check
    // the payload once stringified. Naming the type here is what makes a contract drift a compile
    // error instead of a widget that renders blank.
    const priorities: PrioritiesWidgetData = await composePrioritiesWidget(userEmail, tz, {
      caller: { entra_email: userEmail },
    });
    const band = priorities.band;
    console.info(`[priorities-widget] rendered title=${JSON.stringify(title)} band=${band.length} tz=${tz}`);
    return JSON.stringify({
      rendered: true,
      title,
      // `priorities` is the key the reply-assembly looks for (mirrors `checklist`).
      priorities,
      message: `Priorities widget rendered with ${band.length} item(s). Do not repeat the items in your reply.`,
    });
  } catch (err) {
    console.info(`[priorities-widget] SKIPPED reason=exception`);
    return JSON.stringify({
      error: "priorities_widget_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Execute `show_schedule_widget`. Same composition path as `getScheduleWidget` — one definition of
 *  each section, in Lane B's `buildScheduleSections`. */
export async function dispatchScheduleWidget(
  userEmail: string | undefined,
  _args: Record<string, unknown>,
  timeZone?: string,
  ctx?: { caller?: { entra_object_id?: string; entra_email?: string } },
): Promise<string> {
  if (!userEmail) {
    return JSON.stringify({
      error: "no_caller_identity",
      message: "The schedule widget needs the signed-in user's email; none was provided this turn.",
    });
  }
  try {
    const { getBoardTasks } = await import("./tasks.server");
    const { safeTimeZone, buildScheduleSections } = await import("./widgets.server");
    const tz = safeTimeZone(timeZone);
    const ds = await import("./day-schedule.server");
    const { localDate } = await import("./schedule-brief.server");
    const nowMs = Date.now();
    // Same merged Today as the Schedule tab (getScheduleWidget) — meetings + classes + tasks. A failed
    // task read must not hide meetings that were read fine (verifier loop 1 D3).
    const [rowsR, cal] = await Promise.all([
      getBoardTasks(userEmail).then(
        (rows) => ({ rows, error: undefined as string | undefined }),
        (err) => ({ rows: [] as Awaited<ReturnType<typeof getBoardTasks>>, error: err instanceof Error ? err.message : String(err) }),
      ),
      ds.readTodayCalendar(localDate(nowMs, tz), tz, ctx?.caller, userEmail),
    ]);
    const sections = buildScheduleSections(rowsR.rows, tz, nowMs);
    const today = ds.composeTodayItems({ todayKey: sections.todayKey, tz, cal, todaySchedule: sections.todaySchedule, tasksError: rowsR.error });
    // Annotated for the same reason as the priorities payload above — see that comment.
    const schedule: ScheduleWidgetData = { ok: !rowsR.error, ...(rowsR.error ? { error: rowsR.error } : {}), timeZone: tz, ...sections, ...today };
    console.info(
      `[schedule-widget] rendered today=${today.todayItems.length} (tasks=${sections.todaySchedule.length}) problems=${today.todayProblems.length} doing=${sections.currentlyDoing.length} upNext=${sections.upNext.length} tz=${tz}`,
    );
    return JSON.stringify({
      rendered: true,
      // `schedule` is the key the reply-assembly looks for.
      schedule,
      message: `Schedule widget rendered (${today.todayItems.length} today${today.todayProblems.length ? ` — NOTE: ${today.todayProblems.join(" ")}` : ""}, ${sections.currentlyDoing.length} in progress, ${sections.upNext.length} up next). Do not repeat the items in your reply.`,
    });
  } catch (err) {
    console.info(`[schedule-widget] SKIPPED reason=exception`);
    return JSON.stringify({
      error: "schedule_widget_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}


export const PRIORITIZE_SYSTEM_HINT =
  "For ANY question about the user's schedule, calendar, agenda, day, tasks, backlog, priorities, meetings, appointments, free/busy, or what to do next — including 'what's on my schedule/calendar/day today', 'what's on my plate', 'what's in my backlog', 'what's up next', 'what's overdue', 'what are my <area> priorities' — call the `schedule_and_priorities` tool and answer from its ranked results. It is the user's nightly-planned schedule + tasks, the source of truth. Use view 'scheduled' for 'what's on my schedule/calendar/day today' (it returns that day's meetings, classes and tasks together; pass `date` for another day, e.g. 'tomorrow' or 'thursday'). Follow its `answer_rule`: if `complete` is false a source could not be read, so say which one and NEVER call the day empty, clear or free; otherwise pick the matching `view` (backlog / up_next / overdue / priorities) and the relevant `category`. Only an EXPLICIT 'external calendar' / 'Outlook calendar' request should use get_external_calendar_events instead. The start/due times it returns are ALREADY in the user's local timezone (each carries its zone abbreviation, e.g. '10:00 AM EDT') — state them exactly as given; do NOT convert or shift them. For a schedule question, list EVERY item it returns for the day asked about — do not shorten the day to a few highlights — and if `truncated` is true, say the list is partial. BLOCKED tasks are never in the ranked list: for ANY blocker or status question ('anything blocking me?', 'what's stuck?', 'where do things stand?') pass `include_blocked: true` (or use view 'blocked') and name every task in `blocked` with its `blocker_reason`; only say there are no blockers when you did that and `blocked_count` is 0. Never invent an ordering, and never tell the user their tasks/schedule aren't in your files or ask them to upload anything. If it returns an error, say you couldn't reach their schedule and offer to retry.";

/**
 * Execute a `prioritize` (schedule_and_priorities) tool call. Returns a JSON string (the model reads
 * it verbatim). `userEmail` is the caller's identity (data.caller.entra_email); without it we cannot
 * scope to the user's tasks. `timeZone` (IANA, e.g. "America/New_York") localizes the returned times.
 */
export async function dispatchPrioritize(
  userEmail: string | undefined,
  args: Record<string, unknown>,
  timeZone?: string,
  /** The signed-in caller, so the day view can read THEIR calendar (mailbox + work feed). */
  ctx?: { caller?: { entra_object_id?: string; entra_email?: string } },
): Promise<string> {
  if (!userEmail) {
    return JSON.stringify({
      error: "no_caller_identity",
      message: "Prioritization needs the signed-in user's email; none was provided this turn.",
    });
  }
  const category = typeof args.category === "string" && args.category.trim() ? args.category.trim() : undefined;
  // DEFAULT stays 10 -- a prose answer to "what's on my plate" should not recite fifty rows. The hard
  // CEILING is what moved: it was 25, which silently truncated any caller that genuinely wants the
  // whole set. The checklist is exactly that caller, and a cap it cannot opt out of made "give me a
  // checklist of X" quietly incomplete with nothing on screen saying so. Raising the ceiling changes
  // nothing for callers that omit `limit`.
  const VIEWS = new Set(["priorities", "backlog", "up_next", "scheduled", "overdue", "blocked"]);
  const view = typeof args.view === "string" && VIEWS.has(args.view) ? args.view : "priorities";
  // SCHEDULE ANSWERS ARE COMPLETE (owner-approved B, 2026-11-04). The default 10 is right for a prose
  // "what's on my plate", and wrong for a schedule: the scheduled view spans EVERY day and rankTasks puts
  // starred items first, so 8 starred future items filled 8 of 10 slots and "what's on today" showed 2 of
  // 6 (reproduced offline on main 32f50e4, scripts/status-answers.test.ts B1). So the scheduled view
  // defaults to the ceiling. An explicit `limit` is still honoured, and `total`/`truncated` below say
  // when a list was cut. Ranking is unchanged: this only moves where the slice ends.
  const LIMIT_CEILING = 200;
  const limit =
    typeof args.limit === "number" && args.limit > 0
      ? Math.min(args.limit, LIMIT_CEILING)
      : view === "scheduled"
        ? LIMIT_CEILING
        : 10;
  // BLOCKER / STATUS QUESTIONS REACH BLOCKED TASKS (owner-approved A, 2026-11-04). Every read but the
  // ceremony report dropped BLOCKED, so "anything blocking me?" could only ever answer "no blockers"
  // (memory.md "Blocker DESYNC", 2026-08-06). Blocked tasks come back in a SEPARATE `blocked` array and
  // never enter `ranked`, so priority ranking and the priority widget are untouched.
  const wantBlocked = view === "blocked" || args.include_blocked === true;

  // ONE DAY = MEETINGS + CLASSES + TASKS (2026-11-10 incident: "no items scheduled for today" on a day
  // with 8 meetings and a class, because this view read tasks only and had no day filter, so it also
  // offered Wednesday's task as today's). The 'scheduled' view now answers ONE local day from the merged
  // reader the brief's sources feed. `date: "all"` keeps the old every-day task list. A `category` narrows
  // the TASKS only -- meetings and classes carry no category and are still listed, so a category can never
  // bring back the tasks-only, every-day answer (verifier loop 1 D2).
  if (view === "scheduled") {
    const tz = timeZone || "UTC";
    const ds = await import("./day-schedule.server");
    const date = ds.resolveDayArg(args.date, Date.now(), tz);
    if (date === null) {
      return JSON.stringify({
        error: "bad_date",
        message: `date must be "today", "tomorrow", a weekday name, "all" or yyyy-mm-dd (got ${JSON.stringify(args.date)}).`,
      });
    }
    if (date !== "all") {
      const day = await ds.readDaySchedule(date, tz, {
        ...ds.realCalendarDeps({ caller: ctx?.caller, fallbackMailbox: userEmail }),
        tasks: ds.realTaskReader(userEmail),
      });
      // A category narrows the day's TASKS after they are counted (verifier loop 2 D7), so a filtered-out
      // task is reported as "other tasks", never read as an empty day.
      const out = ds.dayScheduleToolJson({ date, tz, ...day, ...(category ? { category } : {}) });
      if (category) {
        out.category_note = `Tasks are limited to ${category}; meetings and classes carry no category, so all of them are listed.`;
      }
      // "Tomorrow" asked between midnight and 4 AM is the day that just started -- say so, so the answer and
      // the Schedule tab's Today name the same day.
      if (typeof args.date === "string" && /^tomorrow/i.test(args.date.trim()) && date === ds.resolveDayArg("today", Date.now(), tz)) {
        out.date_note = `It is just after midnight, so "tomorrow" means ${ds.weekdayOf(date)} ${date}, the day that has just started (the same day as the Schedule tab's Today). Name that day in your answer and mention you read "tomorrow" that way.`;
      }
      if (wantBlocked) {
        try {
          const b = JSON.parse(await dispatchPrioritize(userEmail, { ...args, view: "blocked" }, timeZone, ctx)) as Record<string, unknown>;
          if (!b.error) Object.assign(out, { blocked_count: b.blocked_count, blocked: b.blocked });
        } catch {
          /* blockers are an add-on to the day answer */
        }
      }
      console.info(
        `[day-schedule] date=${date} tz=${tz} items=${day.items.length} complete=${String(out.complete)} sources=${JSON.stringify(out.sources)}`,
      );
      return JSON.stringify(out);
    }
  }

  try {
    const { getTasksForUser, getTaskBlockers } = await import("./tasks.server");
    const { rankTasks } = await import("./scoring");
    // includeBlocked widens ONLY the read; rankTasks drops BLOCKED itself, so `ranked` is identical either
    // way (status-answers.test.ts A5 pins that).
    const tasks = await getTasksForUser(userEmail, category, wantBlocked ? { includeBlocked: true } : undefined);
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
        case "blocked":
          return false; // a pure blocker question: the answer is the `blocked` array, not a ranking
        default:
          return true; // "priorities" — all open tasks
      }
    });
    // Third and final REMINDER WINDOW filter site (groom.ts and autowork.server.ts are the other two).
    // All three must exclude, or a deferred task leaks back into automation from whichever one was
    // missed — the exact failure the parking-lot rollout hit when it was applied in only one place.
    const { taskIdsInReminderWindow } = await import("./turns.server");
    // Rank the WHOLE view, then slice: the order is exactly rankTasks' order, and `total` is honest.
    const all = rankTasks(inView, Number.POSITIVE_INFINITY, await taskIdsInReminderWindow(userEmail));
    const ranked = all.slice(0, limit);
    const tz = timeZone || "UTC";
    let blockedOut: Record<string, unknown> = {};
    if (wantBlocked) {
      // Same parking-lot rule as the ceremony report (getStandupTasks): a task the user set aside is not
      // reported, blocked or not. A failed reason lookup degrades to reason=null, never to "no blockers".
      const rows = tasks.filter((t) => t.status === "BLOCKED" && !(t.tags ?? []).includes("parking-lot"));
      let reasons = new Map<string, { reason: string; agentId: string | null }>();
      try {
        reasons = await getTaskBlockers(userEmail);
      } catch {
        /* reasons are a bonus; the blocked rows themselves are the answer */
      }
      blockedOut = {
        blocked_count: rows.length,
        blocked: rows.map((t) => ({
          id: t.id,
          title: t.title,
          category: t.category,
          status: t.status,
          assigned_agent: t.assigned_agent ?? null,
          blocker_reason: reasons.get(t.id)?.reason ?? null,
          due_date: formatInTz(t.due_date, tz),
          start_time: formatInTz(t.start_time ?? null, tz),
        })),
      };
    }
    return JSON.stringify({
      view,
      category: category ?? "all",
      count: view === "blocked" ? (blockedOut.blocked_count as number) : ranked.length,
      // How many matched before the limit, and whether this list was cut. A schedule answer that is
      // `truncated` must say so rather than present a partial day as the whole day.
      total: all.length,
      truncated: all.length > ranked.length,
      // Times below are ALREADY in this timezone (with the zone abbreviation) — read them as-is.
      timezone: tz,
      ...blockedOut,
      ranked: ranked.map((r, i) => ({
        rank: i + 1,
        // The task's real id. REQUIRED, and its absence was a live bug: build_checklist's schema tells
        // the model to pass ids "from a schedule_and_priorities call in this same turn", but this
        // mapping omitted `id`, so the model had none to pass and every checklist built from the
        // priorities lane returned no_task_ids. Measured live: the agent said outright that "the task
        // data didn't include the IDs needed to render tickable checklist items" -- it was right.
        // Any tool that acts on a task by id depends on this being here.
        id: r.id,
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

// ---------------------------------------------------------------------------
// focus_on — "start these" (owner 2026-10-16). The agent-facing door to the SAME core the Priorities
// tab's input uses (focus.server.ts): existing tasks are started, missing ones created then started.
// ---------------------------------------------------------------------------

export const FOCUS_TOOL = {
  type: "function",
  name: "focus_on",
  description:
    "START the things the user says they want to work on — now. Pass each item; for each one the app finds the user's existing open task and starts it (moves it to Doing and puts it at the top of This Week), and if no such task exists it CREATES the task first and then starts it. Call this ONLY when the user explicitly says to start or begin working on something now ('start X', 'begin working on X now', 'work on these now'), or when he replies to your scheduled priority check with what he wants to work on (e.g. 'the deck, interview prep, gym'). Do NOT call it when he asks you to PLAN, ORGANIZE or LAY OUT his day or a list — planning moves nothing to Doing. Pass the user's own wording as `title`; pass `task_id` only when a schedule_and_priorities result in this same turn gave you that task's id. Do NOT also call create_huddle_task for these — this tool already creates what is missing. Report what it says it started and created, nothing more.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        description: "What to start, in the order the user gave them (most important first).",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", description: "The item in the user's own words." },
            task_id: { type: "string", description: "Only when a tool result this turn gave you the exact task id." },
          },
          required: ["title"],
        },
      },
    },
    required: ["items"],
  },
  strict: false,
} as const;

// Owner-approved 2026-11-03 (docs/qc-evidence/BUILD-plan-and-answer-first.md). The trigger used to be
// "what they want to work on or focus on — a list", so "plan my activities for the day" (2026-10-28)
// moved every listed item to Doing. focus_on now fires ONLY on an explicit start, or on a reply to the
// scheduled priority check (the owner's 2026-10-16 design — REPLY_LINE in priority-check.server.ts).
export const FOCUS_SYSTEM_HINT =
  "Call `focus_on` ONLY when the user explicitly tells you to START something — 'start X', 'begin working on X now', 'work on these now' — or when he replies to your scheduled priority check (your earlier message listed his priorities and said he can reply with what he wants to work on) with the items he wants to work on. It starts the ones that already exist and creates-then-starts the ones that don't, in one step; do not create them separately first and do not ask for confirmation. Then say in one or two lines what it started and what it newly created. A request to PLAN, ORGANIZE or LAY OUT his day or a list is NOT a start: never call `focus_on` for it — follow the planning contract instead.";

/** The planning contract (owner-approved 2026-11-03). Shared runtime layer, appended on both backends next
 *  to FOCUS_SYSTEM_HINT — never baked into a per-agent snapshot. Semantic: the model judges intent; there is
 *  no keyword forcing. Read tools only, plus create for missing items; times are saved only on request. */
export const PLANNING_SYSTEM_HINT =
  "PLANNING CONTRACT — when the user gives you things to PLAN, ORGANIZE or LAY OUT (e.g. 'plan my activities for the day: gym at 3pm, the vitamin shop, my papers'):" +
  " (1) Read his fixed commitments first with your read-only tools — `schedule_and_priorities`, `get_calendar_events`, and `find_open_slots` if you have it — so the plan fits around what is already booked." +
  " (2) Reply with a SHORT plan, one line per item in time order, each line `time · item · short note` (a few words), plain text, no essay, no preamble beyond one short line. This IS the list he asked for." +
  " (3) Items that are not already on his board: create them as tasks with `create_huddle_tasks` (one call). Do NOT start anything: never call `focus_on` and never move a task to Doing while planning." +
  " (4) Do NOT save the times onto tasks or his calendar unless he explicitly asks ('add the times', 'put it on my calendar'); only then use the existing schedule tools.";

/** Execute `focus_on`. Returns JSON the model reads verbatim. */
export async function dispatchFocusOn(
  caller: { entra_object_id?: string; entra_email?: string } | undefined,
  args: Record<string, unknown>,
): Promise<string> {
  const raw = Array.isArray(args.items) ? (args.items as unknown[]) : [];
  const items = raw
    .map((i) => (typeof i === "string" ? { title: i } : (i as { title?: unknown; task_id?: unknown })))
    .map((i) => ({
      title: typeof i?.title === "string" ? i.title : "",
      task_id: typeof i?.task_id === "string" ? i.task_id : null,
    }))
    .filter((i) => i.title.trim() || i.task_id);
  const text = typeof args.text === "string" ? args.text : undefined;
  const { focusOn } = await import("./focus.server");
  const out = await focusOn(caller ?? {}, items.length ? { items } : { text });
  return JSON.stringify({
    ok: out.ok,
    summary: out.summary,
    started: out.results.filter((r) => r.started).map((r) => ({ title: r.title, created: r.created })),
    failed: out.results.filter((r) => !r.started).map((r) => ({ title: r.title, error: r.error ?? "not started" })),
    ...(out.error ? { error: out.error } : {}),
  });
}
