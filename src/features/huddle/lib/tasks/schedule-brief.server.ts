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
}

export interface ScheduleBrief {
  ok: boolean;
  edition: BriefEdition;
  /** The local date the edition is ABOUT (yyyy-mm-dd), not the date it was sent. */
  forDate: string;
  items: BriefItem[];
  /** Populated when a source failed. An empty brief with an error is NOT "you have nothing". */
  errors: string[];
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
    return { ok: false, error: `no programme matched ${[...want].join(", ") || "(none configured)"}` };
  }
  return { ok: true, ids };
}

/** One day's CLASSES for the configured programmes, from Nexus. */
export async function classesForDate(
  forDate: string,
  programIds: string[],
  tz: string,
): Promise<{ items: BriefItem[]; error?: string }> {
  const { executeNexusTool } = await import("../nexus/nexus.server");
  const items: BriefItem[] = [];
  for (const programId of programIds) {
    const r = (await executeNexusTool(
      "get_nexus_class_schedule",
      { from: forDate, to: forDate, program_id: programId },
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

/** One day's MEETINGS from Microsoft Graph. */
export async function meetingsForDate(
  forDate: string,
  tz: string,
): Promise<{ items: BriefItem[]; error?: string }> {
  const { getGraphCalendarEvents, graphEmailConfigured } = await import("../email/graph-email.server");
  if (!graphEmailConfigured()) {
    // Honest absence: say the source is off rather than reporting an empty calendar.
    return { items: [], error: "Microsoft Graph is not configured, so meetings were not read" };
  }
  try {
    // calendarView takes INSTANTS, not dates. The window is the whole local day: [00:00, 24:00) in
    // `tz`, expressed as the local wall times Graph is told to interpret via its Prefer header.
    const r = await getGraphCalendarEvents({
      startISO: `${forDate}T00:00:00`,
      endISO: `${forDate}T23:59:59`,
      timeZone: tz,
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
        startIso: e.start,
        endIso: e.end,
        location: e.location,
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
}): Promise<ScheduleBrief> {
  const tz = opts.cadence?.tz || DEFAULT_TZ;
  const edition = opts.edition ?? editionForHour(localHour(opts.nowMs, tz));
  // morning = today; evening = tomorrow. This single line is the whole "two shapes of window".
  const forDate = localDate(opts.nowMs, tz, edition === "evening" ? 1 : 0);
  const errors: string[] = [];

  const codes = opts.programCodes?.length ? opts.programCodes : SCHEDULE_BRIEF_PROGRAM_CODES_DEFAULT;
  const prog = await resolveProgramIds(codes);
  let items: BriefItem[] = [];
  if (!prog.ok) {
    errors.push(prog.error);
  } else {
    const cls = await classesForDate(forDate, prog.ids, tz);
    if (cls.error) errors.push(`classes: ${cls.error}`);
    items = items.concat(cls.items);
  }

  const mtg = await meetingsForDate(forDate, tz);
  if (mtg.error) errors.push(`meetings: ${mtg.error}`);
  items = items.concat(mtg.items);

  // Earliest first; an item with no start (an all-day meeting) sorts to the end rather than to 1970.
  items.sort((a, b) => {
    const at = a.startIso ? Date.parse(a.startIso) : Number.POSITIVE_INFINITY;
    const bt = b.startIso ? Date.parse(b.startIso) : Number.POSITIVE_INFINITY;
    return at === bt ? a.title.localeCompare(b.title) : at - bt;
  });

  // ok:false ONLY when EVERY source failed. One source failing with the other returning rows is a
  // partial brief that still says something true, and the error rides along so the gap is visible.
  return { ok: errors.length < 2, edition, forDate, items, errors };
}
