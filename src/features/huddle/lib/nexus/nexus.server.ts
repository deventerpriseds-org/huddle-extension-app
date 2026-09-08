// WHAT:       Direction 1 of the cross-app bridge -- lets a Huddle agent READ the owner's Nexus
//             coursework: assignments (with real due dates), programs and courses, and the class
//             schedule. Three tools, one shared executor, reachable from both live Huddle surfaces.
// WHY:        Two separate problems, and the second is the worse one.
//             (1) Nothing on the Huddle side could reach Nexus at all -- grepped 2026-09-08, zero
//                 references. So "what's due this week in my EMBA?" had no route to the data.
//             (2) journey's `list_pending_assignments` answers that question ANYWAY, from a STALE
//                 FORK of the same dataset. Measured: journey holds 469 assignment rows for the
//                 owner with the newest created 2026-04-06; Nexus holds 534, of which 241 were
//                 created AFTER that date. So the agent answers confidently from a five-month-old
//                 snapshot and looks fine doing it. This is not adding a missing capability -- it
//                 is replacing a silently-wrong one, which is why the descriptions below tell the
//                 model to prefer these tools for coursework.
// SUPERSEDES: nothing yet. `list_pending_assignments` still exists on journey's bus; retiring it is
//             a journey-side change and a separate, deliberate step. Until then, DO NOT leave two
//             answers standing silently -- the description on get_nexus_assignments is what steers
//             the model to the live one.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   nexus-hub/docs/cross-app-agent/SCENARIOS.md A-READ-1/3/6 and B-READ-5 (the stale-fork
//             measurement); CAP-nexus.md §2.2 for the d1 route; the filterable set read from
//             nexus-hub/api/src/functions/d1.ts:522.
//
// READ-ONLY BY CONSTRUCTION. Every call here is a GET against /api/d1/{table}. Nothing in this file
// can write, and the Nexus side blocks writes on this auth path anyway (`requireWrite` rejects the
// owner-parameter identity). Adding a write path is a different decision with a different gate.

/** The owner id Nexus scopes rows by. Configured, never inferred -- see resolveNexusOwner below. */
function nexusOwner(): string {
  return (process.env.NEXUS_OWNER_ID ?? "").trim();
}

function nexusBase(): string {
  return (process.env.NEXUS_API_URL ?? "").trim().replace(/\/+$/, "");
}

/**
 * Both must be present. A half-configured environment reads as "no Nexus tools" rather than as a
 * tool that exists and fails at call time -- a tool the model can see but cannot use is worse than
 * one it never had, because the model will keep retrying it and narrate the failure to the user.
 */
export function nexusReadConfigured(): boolean {
  return !!nexusBase() && !!nexusOwner();
}

const TIMEOUT_MS = 15_000;

type Row = Record<string, unknown>;

/**
 * ONE-WAY IDENTITY NOTE, recorded because it is the sharpest edge in this file.
 *
 * Nexus authorises these reads from an `?owner=<uuid>` query parameter that it does NOT verify --
 * the UUID is the only secret. That is a pre-existing property of the Nexus API (CAP-nexus §2.1,
 * flagged for the owner and not created here), and it is why this module takes the owner id from
 * SERVER CONFIG and never from a tool argument. If an agent could pass an owner id, any prompt
 * could read any user's coursework by guessing a UUID. The model cannot reach this value.
 */
async function nexusGet(table: string, filters: [string, string][] = []): Promise<
  { ok: true; rows: Row[] } | { ok: false; error: string }
> {
  const base = nexusBase();
  const owner = nexusOwner();
  if (!base || !owner) return { ok: false, error: "nexus_not_configured" };

  const url = new URL(`${base}/api/d1/${table}`);
  url.searchParams.set("owner", owner);
  // Nexus takes filters as ONE json param -- repeated query keys get merged into a comma-joined
  // value by the Azure Functions host, which corrupts same-column ranges (a due_date gte AND lte
  // becomes one nonsense value). Read from d1.ts:523-527; do not "simplify" this to ?col=val.
  if (filters.length) url.searchParams.set("filters", JSON.stringify(filters));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const body = (await res.json()) as unknown;
    const rows = Array.isArray(body)
      ? (body as Row[])
      : Array.isArray((body as { rows?: unknown })?.rows)
        ? ((body as { rows: Row[] }).rows)
        : [];
    return { ok: true, rows };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, error: aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

/** yyyy-mm-dd in the caller's zone, so "this week" means their week and not the server's. */
function dayIn(tz: string, offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-CA", { timeZone: tz || "UTC" });
}

export const GET_NEXUS_ASSIGNMENTS_TOOL = {
  type: "function" as const,
  name: "get_nexus_assignments",
  description:
    "The owner's REAL, CURRENT EMBA coursework assignments, read live from Nexus. Use this for ANY question about coursework, assignments, homework, papers, case briefs, submissions or what is due — 'what's due this week', 'what do I still owe', 'what's pending in Corporate Finance'. PREFER THIS OVER list_pending_assignments: that tool reads a separate copy that stopped being updated in April and will answer confidently with months-old data.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      due_within_days: {
        type: "number",
        description: "Only assignments due within this many days from today. Omit for no date bound.",
      },
      status: {
        type: "string",
        description: "Filter by lifecycle status exactly as Nexus stores it (e.g. 'pending', 'submitted'). Omit for all.",
      },
      course_id: { type: "string", description: "Restrict to one course, by Nexus course id." },
      title: {
        type: "string",
        description:
          "Case-insensitive substring of the assignment TITLE, for when the owner names one ('the introduction discussion', 'Discussion Board 1'). Pass the distinctive words only, not the whole phrase.",
      },
    },
    required: [] as string[],
  },
  strict: false,
};

export const GET_NEXUS_COURSES_TOOL = {
  type: "function" as const,
  name: "get_nexus_courses",
  description:
    "The owner's EMBA programs and the courses inside them, read live from Nexus. Use for 'what courses am I taking', 'what's in my program', or to resolve a course NAME the owner mentioned into the id the other Nexus tools take.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
    required: [] as string[],
  },
  strict: false,
};

export const GET_NEXUS_CLASS_SCHEDULE_TOOL = {
  type: "function" as const,
  name: "get_nexus_class_schedule",
  description:
    "The owner's CLASS SCHEDULE — live sessions, lectures and residencies from Nexus. Use for 'when is my next live session', 'when do I have class', 'what's my residency schedule'. This is academic class timetabling and is SEPARATE from get_calendar_events, which answers about their general day, meetings and tasks.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      from: { type: "string", description: "Start date, yyyy-mm-dd. Defaults to today." },
      to: { type: "string", description: "End date, yyyy-mm-dd. Defaults to 60 days out." },
    },
    required: [] as string[],
  },
  strict: false,
};

/** The three tools, or none at all when Nexus is not configured. */
export function nexusReadTools(): unknown[] {
  if (!nexusReadConfigured()) return [];
  return [GET_NEXUS_ASSIGNMENTS_TOOL, GET_NEXUS_COURSES_TOOL, GET_NEXUS_CLASS_SCHEDULE_TOOL];
}

export const NEXUS_TOOL_NAMES = new Set([
  "get_nexus_assignments",
  "get_nexus_courses",
  "get_nexus_class_schedule",
]);

/**
 * ONE executor, called by BOTH surfaces. The text path and the voice path having separate copies is
 * exactly how this estate ends up with tools that work when typed and are silently missing when
 * spoken -- CAP-huddle-journey records nine such divergences, all one-directional, all voice.
 */
export async function executeNexusTool(
  name: string,
  args: Record<string, unknown>,
  timeZone: string,
): Promise<unknown> {
  if (!nexusReadConfigured()) return { ok: false, error: "nexus_not_configured" };

  if (name === "get_nexus_courses") {
    const [programs, courses] = await Promise.all([nexusGet("programs"), nexusGet("courses")]);
    if (!programs.ok) return { ok: false, error: programs.error };
    if (!courses.ok) return { ok: false, error: courses.error };
    return { ok: true, programs: programs.rows, courses: courses.rows };
  }

  if (name === "get_nexus_class_schedule") {
    const from = typeof args.from === "string" && args.from.trim() ? args.from.trim().slice(0, 10) : dayIn(timeZone);
    const to = typeof args.to === "string" && args.to.trim() ? args.to.trim().slice(0, 10) : dayIn(timeZone, 60);
    const r = await nexusGet("class-schedules", [["date", `gte.${from}`], ["date", `lte.${to}`]]);
    if (!r.ok) return { ok: false, error: r.error };
    const sessions = [...r.rows].sort((a, b) =>
      String(a.date ?? "").localeCompare(String(b.date ?? "")),
    );
    return { ok: true, from, to, count: sessions.length, sessions };
  }

  if (name === "get_nexus_assignments") {
    const filters: [string, string][] = [];
    if (typeof args.course_id === "string" && args.course_id.trim()) {
      filters.push(["course_id", `eq.${args.course_id.trim()}`]);
    }
    if (typeof args.status === "string" && args.status.trim()) {
      filters.push(["status", `eq.${args.status.trim()}`]);
    }
    // TITLE SEARCH. The owner names an assignment in words ("the introduction discussion"); without
    // this the model could only filter by course/status/date and had to scan. `ilike` is whitelisted
    // by the Nexus API's operator table (d1.ts:461), so this is a server-side filter, not a fetch-
    // everything-and-sift. Wildcards are stripped from the input so a stray % cannot widen the match
    // back to everything and look like a working search.
    const titleQuery =
      typeof args.title === "string" ? args.title.trim().replace(/[%_]/g, "") : "";
    if (titleQuery) filters.push(["title", `ilike.%${titleQuery}%`]);
    const within = typeof args.due_within_days === "number" ? args.due_within_days : undefined;
    if (within !== undefined && Number.isFinite(within)) {
      filters.push(["due_date", `gte.${dayIn(timeZone)}`]);
      filters.push(["due_date", `lte.${dayIn(timeZone, Math.max(0, Math.trunc(within)))}`]);
    }

    const r = await nexusGet("assignments", filters);
    if (!r.ok) return { ok: false, error: r.error };

    const rows = [...r.rows].sort((a, b) => {
      const da = String(a.due_date ?? ""), db = String(b.due_date ?? "");
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da.localeCompare(db);
    });

    // AN EMPTY RESULT IS REPORTED AS EMPTY, not dressed up. A correct pipeline and a broken one both
    // return zero rows, so an agent answering "you're all caught up!" from an empty set is the
    // confident-wrong-answer failure this whole bridge exists to remove.
    //
    // A COUNT OF LIVE DATA HAS A SHELF LIFE, and this comment previously carried one as though it
    // did not: "534 assignments, 504 with a due date, 0 in the future, latest 2026-08-18", measured
    // 2026-09-03 and used to argue the date filter was untestable. On 2026-09-08 two assignments
    // were due in the FUTURE (2026-09-07 and 2026-09-10) -- the owner had imported a new term. The
    // structural point survives; the number did not, so the number is gone rather than restated.
    const ambiguous = titleQuery !== "" && rows.length > 1;
    return {
      ok: true,
      count: rows.length,
      filtered_by: filters.map(([c, v]) => `${c} ${v}`),
      // WHEN A TITLE SEARCH MATCHES SEVERAL, ASK -- never pick. The owner: "if there are multiple,
      // I'd expect it to clarify for which course before executing." Guessing between two courses'
      // assignments and then DRAFTING against the wrong one wastes the turn and looks like the tool
      // worked. The course name is what disambiguates, so the directive names it explicitly.
      needs_disambiguation: ambiguous || undefined,
      note: ambiguous
        ? `${rows.length} assignments match that title. STOP and ask the owner which COURSE he means -- list the matches with their course and due date, and do not act on any of them until he answers.`
        : rows.length === 0
          ? "No assignments matched. Report this as 'nothing matched those filters' and state the filters used -- do NOT tell the owner he is caught up unless an unfiltered read also returns nothing."
          : undefined,
      assignments: rows,
    };
  }

  return { ok: false, error: `unknown_nexus_tool_${name}` };
}
