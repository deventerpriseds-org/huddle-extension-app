// WHAT:       The SCHEDULE BRIEF — two pushed editions a day of the user's meetings and classes.
//             MORNING edition covers today; EVENING edition covers tomorrow.
// WHY:        Asked 2026-10-01: "I need to know why i am not reciving daily alerts of what meetings
//             i have on my calendar nor courses I have to attend that night", then "I want seperate
//             alerts (8am and 8pm). for the evening before looking at the day after and the morning
//             of looking at the current day". A probe on 2026-10-05 proved NONE of it existed:
//             `JobTypeKey` was a closed union naming no calendar or coursework job, no workflow
//             carried a `schedule:` cron, `standup.server.ts` and `review-digest.server.ts` held
//             ZERO references to any calendar or class reader, and `identity.scheduling_config` had
//             zero override rows. The data and both readers were already built; nothing called them
//             on a clock. THIS FILE IS THAT CALL, and it is the only genuinely new thing here.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:schedule-brief. Scope (DBA only, owner-instructed 2026-10-05:
//             "Let's focus on DBA program", "Ignore EMBA and mit") lives in
//             SCHEDULE_BRIEF_PROGRAM_CODES_DEFAULT, overridable per user.
//
// EXTENDS, DOES NOT DUPLICATE. Every input and every output already existed:
//   classes   <- get_nexus_class_schedule (nexus.server.ts) -> nexus GET /api/d1/class-schedules
//   meetings  <- getGraphCalendarEvents  (graph-email.server.ts), the same app-only Graph client
//   delivery  <- a durable turn in the owner's DM, which fires the EXISTING away-notification
//                (send_push -> Android bridge). No new sender, no new secret.
// The programme filter rides d1's OWN allow-list -- `class-schedules.filters` already names
// `program_id` (nexus-hub api/src/functions/d1.ts:376), so scoping to DBA needed no change on the
// Nexus side at all. It is only expressible because class_schedules.program_id was backfilled on
// 2026-10-05; before that the column was NULL on all 132 rows.

import {
  DEFAULT_TZ,
  SCHEDULE_BRIEF_PROGRAM_CODES_DEFAULT,
  type JobCadence,
} from "../identity/scheduling-config.server";

export type BriefEdition = "morning" | "evening";

export interface BriefItem {
  /** Stable source id — a class_schedules row id, or the Graph event id. Used for the T-60 key. */
  sourceId: string;
  kind: "class" | "meeting";
  title: string;
  /** ISO instant. Null ONLY for an all-day meeting; a class always has one (NOT NULL in Nexus). */
  startIso: string | null;
  endIso: string | null;
  location: string | null;
  /** The item's LOCAL date (yyyy-mm-dd) — set on lookahead items so an all-day one keeps its day. */
  day?: string;
}

/** A scheduled journey task, as Iris names it. Never fed to the T-60 seeder (journey alarms tasks). */
export interface BriefTask {
  id: string;
  title: string;
  startIso: string | null;
}

/** A journey time window in LOCAL hours, e.g. { name: "business_hours", start: 9, end: 17 }. */
export interface BriefWindow {
  name: string;
  start: number;
  end: number;
}

export interface ScheduleBrief {
  ok: boolean;
  edition: BriefEdition;
  /** The local date the edition is ABOUT (yyyy-mm-dd), not the date it was sent. */
  forDate: string;
  items: BriefItem[];
  /** Populated when a source failed. An empty brief with an error is NOT "you have nothing". */
  errors: string[];
  /**
   * LATER THIS WEEK: the 6 days after `forDate` (owner, 2026-10-15: "...and later in the week you
   * have a tomorrow, b the next day"). Briefed only -- the T-60 seeder reads `items`, never this.
   */
  upcoming?: BriefItem[];
  /** A failed lookahead read. Never turns the edition into a read-error; it is mentioned softly. */
  upcomingErrors?: string[];
  /** The day's (or the window's) scheduled, open tasks. undefined = not read (no task email). */
  tasks?: BriefTask[];
  /** The task read failed — said plainly rather than implying the task list is empty. */
  tasksError?: string;
  /** Set for a WINDOW message: items and tasks are narrowed to what is still ahead in it. */
  window?: BriefWindow;
}

/**
 * Narrow to what is STILL AHEAD inside a window: start at/after `nowMs` and the local start hour in
 * [window.start, window.end). Undated items (all-day meetings) are dropped — they belong to the day,
 * not to a window. Pure, so the boundary rules are unit-tested.
 */
export function inWindow(startIso: string | null, w: BriefWindow, tz: string, nowMs: number): boolean {
  if (!startIso) return false;
  const t = Date.parse(startIso);
  if (!Number.isFinite(t) || t < nowMs) return false;
  const h = localHour(t, tz);
  return h >= w.start && h < w.end;
}

/** yyyy-mm-dd plus N calendar days (pure date math on the local date, DST-proof). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

/**
 * Which edition a fire at `nowMs` is. DERIVED FROM THE LOCAL HOUR, never stored on the job row.
 *
 * The ask is "the evening before looking at the day after and the morning of looking at the current
 * day" — a shape, not two fixed clock times. Deriving it means a user who changes
 * `scheduleBrief.hours` from [8,20] to [7,21] still gets one of each, and a user who sets a single
 * hour gets whichever one that hour falls in. Storing the edition on the row would freeze whatever
 * was true when the row was written, which is the stale-cadence trap scheduler.server.ts's own
 * JOB_TYPE_KEY comment describes.
 *
 * Noon is the split, and 12 itself is INCLUSIVE of morning. A brief about "today" delivered at
 * midday is still about today — half the day is ahead of it — whereas calling 12:00 the evening
 * edition would skip today entirely for a user who set a single midday hour.
 *
 * This read `< 12` when first written, which made 12:00 the EVENING edition and contradicted the
 * paragraph above it. scripts/schedule-brief.test.ts A3 caught it before it shipped; it is exactly
 * the class of defect that is invisible in a diff, because both operators look equally plausible.
 */
export function editionForHour(localHour: number): BriefEdition {
  return localHour <= 12 ? "morning" : "evening";
}

/** `yyyy-mm-dd` for `nowMs` in `tz`, plus `addDays`. Uses en-CA because it formats as ISO. */
export function localDate(nowMs: number, tz: string, addDays = 0): string {
  const d = new Date(nowMs + addDays * 86_400_000);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * The local date an edition is ABOUT: morning = today, evening = tomorrow.
 *
 * EXTRACTED SO IT CAN BE PROVEN. This was an inline `edition === "evening" ? 1 : 0` inside
 * buildScheduleBrief, and a mutation flipping it to `: 0 : 0` — which makes the evening brief
 * describe the day just finished, the single worst defect this feature can have — came back INERT,
 * because the suite exercised `localDate` directly and never the line that CHOOSES the offset.
 * A guard that cannot see its most important line is believed and protects nothing.
 */
export function dateForEdition(nowMs: number, tz: string, edition: BriefEdition): string {
  return localDate(nowMs, tz, edition === "evening" ? 1 : 0);
}

/** The local hour (0-23) at `nowMs` in `tz`. */
export function localHour(nowMs: number, tz: string): number {
  try {
    const h = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).format(new Date(nowMs));
    const n = Number(h);
    return Number.isFinite(n) ? n % 24 : new Date(nowMs).getHours();
  } catch {
    return new Date(nowMs).getHours();
  }
}

/**
 * Resolve programme CODES to ids through the existing Nexus programs read.
 *
 * Codes, not ids, are what the setting stores — see SCHEDULE_BRIEF_PROGRAM_CODES_DEFAULT. An
 * unmatched code is dropped and reported rather than silently widening the scope: returning "no
 * filter" on a typo would brief the user on every programme, which is the opposite of what the
 * scope instruction asked for. An EMPTY result therefore means "filter to nothing", and the caller
 * treats it as an error, never as "show everything".
 */
export async function resolveProgramIds(
  codes: string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const { executeNexusTool } = await import("../nexus/nexus.server");
  const r = (await executeNexusTool("get_nexus_courses", {}, DEFAULT_TZ)) as {
    ok?: boolean;
    error?: string;
    programs?: { id?: unknown; code?: unknown; name?: unknown }[];
  };
  if (!r?.ok) return { ok: false, error: r?.error || "could not read the programme list" };
  const want = new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean));
  const ids: string[] = [];
  for (const p of r.programs ?? []) {
    const code = typeof p.code === "string" ? p.code.trim().toUpperCase() : "";
    if (code && want.has(code) && typeof p.id === "string") ids.push(p.id);
  }
  if (!ids.length) {
    return {
      ok: false,
      error: `no programme matched ${[...want].join(", ") || "(none configured)"}`,
    };
  }
  return { ok: true, ids };
}

/** One day's CLASSES for the configured programmes, from Nexus. */
export async function classesForDate(
  forDate: string,
  programIds: string[],
  tz: string,
  toDate: string = forDate,
): Promise<{ items: BriefItem[]; error?: string }> {
  const { executeNexusTool } = await import("../nexus/nexus.server");
  const items: BriefItem[] = [];
  for (const programId of programIds) {
    const r = (await executeNexusTool(
      "get_nexus_class_schedule",
      { from: forDate, to: toDate, program_id: programId },
      tz,
    )) as { ok?: boolean; error?: string; sessions?: Record<string, unknown>[] };
    if (!r?.ok) return { items, error: r?.error || "class schedule read failed" };
    for (const s of r.sessions ?? []) {
      const id = typeof s.id === "string" ? s.id : null;
      if (!id) continue; // without a stable id a T-60 cannot be keyed idempotently — skip, don't guess
      items.push({
        sourceId: id,
        kind: "class",
        title: String(s.course_name ?? "Class").trim() || "Class",
        startIso: typeof s.start_time === "string" ? s.start_time : null,
        endIso: typeof s.end_time === "string" ? s.end_time : null,
        location: typeof s.location === "string" && s.location.trim() ? s.location.trim() : null,
      });
    }
  }
  return { items };
}

/** Offset (ms) of `tz` from UTC at instant `at` — positive east of UTC. */
function tzOffsetMs(tz: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(
      g("year"),
      g("month") - 1,
      g("day"),
      g("hour") % 24,
      g("minute"),
      g("second"),
    );
    return asUtc - at.getTime();
  } catch {
    return 0;
  }
}

/**
 * The UTC INSTANTS bounding one LOCAL day in `tz`: [local 00:00, next local 00:00).
 *
 * WHY (2026-10-15): the brief used to hand Graph `${date}T00:00:00`..`T23:59:59` with no offset.
 * calendarView reads an offset-less startDateTime/endDateTime as UTC — the Prefer `outlook.timezone`
 * header only changes how the RESPONSE is rendered — so the "day" queried in New York was 20:00 the
 * previous evening to 20:00 that evening, dropping every evening meeting. DST-correct: the offset is
 * measured at each boundary instead of assumed.
 */
export function localDayBoundsUtc(
  forDate: string,
  tz: string,
): { startIso: string; endIso: string } {
  const [y, m, d] = forDate.split("-").map(Number);
  const at = (day: number) => {
    const guess = Date.UTC(y, m - 1, day, 0, 0, 0);
    // Two passes so a boundary near a DST change resolves to the offset in force AT that boundary.
    let t = guess - tzOffsetMs(tz, new Date(guess));
    t = guess - tzOffsetMs(tz, new Date(t));
    return new Date(t).toISOString();
  };
  return { startIso: at(d), endIso: at(d + 1) };
}

/**
 * Graph renders `start.dateTime` with NO offset (e.g. `2026-10-15T13:00:00.0000000`) in whatever zone
 * the Prefer header named. meetingsForDate asks for UTC, so this pins the value as UTC and trims the
 * 7-digit fraction JS cannot portably parse. Before this, `new Date()` on the server read a NEW YORK
 * wall time as UTC and printed every meeting 4-5 hours early.
 */
export function graphUtcToIso(dt: string | null | undefined): string | null {
  if (!dt) return null;
  if (/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(dt)) return dt; // already carries an offset
  const iso = `${dt.replace(/(\.\d{3})\d+$/, "$1")}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * One day's MEETINGS from Microsoft Graph, read from the OWNER's mailbox.
 *
 * `mailbox` is REQUIRED on purpose. Root cause of "the 8am brief never arrives" (2026-10-15): this
 * call passed no mailbox, so getGraphCalendarEvents fell back to defaultFrom() — the first
 * HUDDLE_EMAIL_FROM entry, the app's SENDING mailbox — and read that calendar instead of the owner's.
 * The working agent tool (`get_external_calendar_events`) resolves the mailbox with
 * resolveTaskEmail(caller); runScheduleBrief now does the same and passes it down to here.
 */
export async function meetingsForDate(
  forDate: string,
  tz: string,
  mailbox: string,
  toDate: string = forDate,
): Promise<{ items: BriefItem[]; error?: string }> {
  const { getGraphCalendarEvents, graphEmailConfigured } =
    await import("../email/graph-email.server");
  if (!graphEmailConfigured()) {
    // Honest absence: say the source is off rather than reporting an empty calendar.
    return { items: [], error: "Microsoft Graph is not configured, so meetings were not read" };
  }
  try {
    // One Graph read covering forDate..toDate (inclusive) — a single day unless a range is asked for.
    const { startIso } = localDayBoundsUtc(forDate, tz);
    const { endIso } = localDayBoundsUtc(toDate, tz);
    const r = await getGraphCalendarEvents({
      mailbox,
      startISO: startIso,
      endISO: endIso,
      timeZone: "UTC", // response rendered in UTC so graphUtcToIso can pin it unambiguously
    });
    if (!r.ok) return { items: [], error: r.error || "calendar read failed" };
    const items: BriefItem[] = [];
    for (const e of r.events ?? []) {
      // An event with no id cannot be keyed for an idempotent T-60, so it is still BRIEFED (the
      // user should see it) but the seeder skips it rather than minting a duplicate-prone key.
      items.push({
        sourceId: e.id || "",
        kind: "meeting",
        title: e.subject?.trim() || "Meeting",
        // An all-day event's start is a midnight, not a time — render it "all day" (startIso null).
        startIso: e.isAllDay ? null : graphUtcToIso(e.start),
        endIso: e.isAllDay ? null : graphUtcToIso(e.end),
        location: e.location,
        // All-day: Graph's start IS the date. Timed: the instant's local date.
        day: e.isAllDay
          ? String(e.start ?? "").slice(0, 10) || undefined
          : (() => {
              const iso = graphUtcToIso(e.start);
              return iso ? localDate(Date.parse(iso), tz) : undefined;
            })(),
      });
    }
    return { items };
  } catch (err) {
    return { items: [], error: err instanceof Error ? err.message : "calendar read failed" };
  }
}

/**
 * Assemble one edition. PURE with respect to the clock — `nowMs` is passed in, so the edition and
 * the date it covers are deterministic and testable rather than read from the wall.
 */
export async function buildScheduleBrief(opts: {
  nowMs: number;
  cadence?: Pick<JobCadence, "tz">;
  programCodes?: string[];
  /** Force an edition instead of deriving it (the manual/test path). */
  edition?: BriefEdition;
  /** The OWNER's Graph mailbox (resolveTaskEmail(caller)). Required — see meetingsForDate. */
  mailbox: string;
  /** The email the task mirror is keyed by. Omitted -> tasks are not read (legacy callers). */
  taskEmail?: string;
  /** A window message: narrow to what is still ahead in this window; no week lookahead. */
  window?: BriefWindow;
}): Promise<ScheduleBrief> {
  const tz = opts.cadence?.tz || DEFAULT_TZ;
  const edition = opts.edition ?? editionForHour(localHour(opts.nowMs, tz));
  // morning = today; evening = tomorrow — the whole "two shapes of window", via the extracted
  // helper so the choice itself is covered by a mutation rather than only its inputs.
  const forDate = dateForEdition(opts.nowMs, tz, edition);
  const errors: string[] = [];

  const codes = opts.programCodes?.length
    ? opts.programCodes
    : SCHEDULE_BRIEF_PROGRAM_CODES_DEFAULT;
  const prog = await resolveProgramIds(codes);
  let items: BriefItem[] = [];
  if (!prog.ok) {
    errors.push(prog.error);
  } else {
    const cls = await classesForDate(forDate, prog.ids, tz);
    if (cls.error) errors.push(`classes: ${cls.error}`);
    items = items.concat(cls.items);
  }

  const mtg = await meetingsForDate(forDate, tz, opts.mailbox);
  if (mtg.error) errors.push(`meetings: ${mtg.error}`);
  items = items.concat(mtg.items);

  // Earliest first; an item with no start (an all-day meeting) sorts to the end rather than to 1970.
  items.sort((a, b) => {
    const at = a.startIso ? Date.parse(a.startIso) : Number.POSITIVE_INFINITY;
    const bt = b.startIso ? Date.parse(b.startIso) : Number.POSITIVE_INFINITY;
    return at === bt ? a.title.localeCompare(b.title) : at - bt;
  });

  // TASKS for the day — the owner's own list (owner, 2026-10-15: "i have tasks everyday"). Separate
  // from `items` on purpose: items also seed the T-60 reminders, and journey already alarms tasks.
  let tasks: BriefTask[] | undefined;
  let tasksError: string | undefined;
  if (opts.taskEmail) {
    try {
      const { getScheduledTasksBetween } = await import("./tasks.server");
      const { startIso, endIso } = localDayBoundsUtc(forDate, tz);
      const rows = await getScheduledTasksBetween(opts.taskEmail, startIso, endIso);
      tasks = rows.map((r) => ({
        id: r.id,
        title: String(r.title ?? "").trim() || "(untitled)",
        startIso: r.start_time ? new Date(r.start_time).toISOString() : null,
      }));
    } catch (err) {
      tasksError = err instanceof Error ? err.message : "task read failed";
    }
  }

  // A WINDOW message: only what is still ahead in that window, and no week lookahead — the morning
  // message (and the email) already carry the wider view.
  if (opts.window) {
    const w = opts.window;
    items = items.filter((i) => inWindow(i.startIso, w, tz, opts.nowMs));
    if (tasks) tasks = tasks.filter((t) => inWindow(t.startIso, w, tz, opts.nowMs));
    return {
      ok: errors.length < 2, edition, forDate, items, errors, upcoming: [], upcomingErrors: [],
      ...(tasks ? { tasks } : {}), ...(tasksError ? { tasksError } : {}), window: w,
    };
  }

  // LATER THIS WEEK — the 6 days after forDate, both sources, one read each. Best-effort: a failure
  // here is reported softly and never turns today's brief into a read-error.
  const from = addDays(forDate, 1);
  const to = addDays(forDate, 6);
  let upcoming: BriefItem[] = [];
  const upcomingErrors: string[] = [];
  if (prog.ok) {
    const c = await classesForDate(from, prog.ids, tz, to);
    if (c.error) upcomingErrors.push(`classes: ${c.error}`);
    upcoming = upcoming.concat(
      c.items.map((i) => ({ ...i, day: i.startIso ? localDate(Date.parse(i.startIso), tz) : undefined })),
    );
  }
  const um = await meetingsForDate(from, tz, opts.mailbox, to);
  if (um.error) upcomingErrors.push(`meetings: ${um.error}`);
  upcoming = upcoming.concat(um.items);
  upcoming.sort((a, b) => {
    const ad = a.day ?? "", bd = b.day ?? "";
    if (ad !== bd) return ad.localeCompare(bd);
    const at = a.startIso ? Date.parse(a.startIso) : Number.NEGATIVE_INFINITY; // all-day first in a day
    const bt = b.startIso ? Date.parse(b.startIso) : Number.NEGATIVE_INFINITY;
    return at - bt;
  });

  // ok:false ONLY when EVERY source failed. One source failing with the other returning rows is a
  // partial brief that still says something true, and the error rides along so the gap is visible.
  return {
    ok: errors.length < 2, edition, forDate, items, errors, upcoming, upcomingErrors,
    ...(tasks ? { tasks } : {}), ...(tasksError ? { tasksError } : {}),
  };
}
