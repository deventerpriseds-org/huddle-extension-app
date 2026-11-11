// WHAT:       ONE reader for "what is on my day": meetings (Graph + work feed) + classes (Nexus) + scheduled
//             tasks (mirror), merged, de-duplicated, time-ordered and labelled — for Iris's chat answer, the
//             voice answer and the Schedule tab's "Today's schedule".
// WHY:        2026-11-10 07:06 ET Iris told the owner "no items scheduled for today" on a day with 8 meetings
//             and a class. Every chat schedule tool (schedule_and_priorities 'scheduled', get_calendar_events,
//             the Lovable path, voice) ran dispatchPrioritize, which reads TASKS ONLY and had no day filter, and
//             the Schedule tab's today section also read tasks only. Only the 8 AM/8 PM brief read meetings.
// SUPERSEDES: nothing. Extends the brief's own readers (meetingsForDate, classesForDate, localDayBoundsUtc)
//             rather than adding a second Graph / Nexus read (AC-30).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/AC-schedule-meetings.md (46 ACs, independent), scripts/day-schedule.test.ts.
import { addDays, localDate, localDayBoundsUtc, type BriefItem } from "./schedule-brief.server";
import type { ScheduleDayEntry, WidgetTaskRow } from "./widgets.server";

export type DayItemKind = "meeting" | "class" | "task";

/** One row of a merged day. Times are raw ISO instants; callers format them. */
export interface DayItem {
  kind: DayItemKind;
  title: string;
  /** Null only for an all-day calendar item. */
  startIso: string | null;
  endIso: string | null;
  allDay: boolean;
  location: string | null;
  /** The journey task id — set on task rows only, so task actions (done, doing, checklist) still work. */
  taskId?: string;
  /** Task rows only: the task's category, so a category question can narrow tasks without hiding them. */
  category?: string | null;
  status?: string | null;
  /** Calendar source id (Graph event id / class session id). */
  sourceId?: string;
  /** A task that overlaps a meeting or class with a different title. */
  conflict?: boolean;
}

/** Per-source read outcome. `ok:false` means the source's items may be MISSING, not that there are none. */
export interface SourceStatus {
  ok: boolean;
  error?: string;
  warnings?: string[];
  count: number;
}

export interface CalendarDayRead {
  meetings: BriefItem[];
  classes: BriefItem[];
  sources: { meetings: SourceStatus; classes: SourceStatus };
  /** Graph's calendarView returns at most 50 events per read and is not paged (AC-43). */
  meetingsMayBeCut: boolean;
}

export interface TaskForDay {
  id: string;
  title: string;
  startIso: string | null;
  endIso?: string | null;
  status?: string | null;
  category?: string | null;
}

/** Per-source time bound (AC-20/41). The three sources run in parallel, so this is also the tool's bound. */
export const SOURCE_TIMEOUT_MS = 8_000;
const GRAPH_PAGE = 50;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Turn the tool's `date` argument into a local yyyy-mm-dd, "all", or null (invalid).
 * Accepts: omitted / "today", "tomorrow", "yesterday", "yyyy-mm-dd", a weekday name (the next one,
 * today included), and "all" (every scheduled task on every day — the pre-2026-11-10 behaviour).
 */
export function resolveDayArg(arg: unknown, nowMs: number, tz: string): string | "all" | null {
  const today = localDate(nowMs, tz);
  if (arg === undefined || arg === null) return today;
  if (typeof arg !== "string") return null;
  let s = arg.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,!?]+$/, "");
  if (!s || /^(today|now|tonight|this (morning|afternoon|evening)|later today)$/.test(s)) return today;
  if (s === "all") return "all";
  if (s === "tomorrow" || s === "tomorrow morning" || s === "tomorrow night") return addDays(today, 1);
  if (s === "yesterday") return addDays(today, -1);
  // "Nov 12" / "November 12" / "12 Nov" -> this year's date (the user names days near now).
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const md = s.match(/^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?$/) || s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})$/);
  if (md) {
    const [mon, day] = /^\d/.test(md[1]) ? [md[2], md[1]] : [md[1], md[2]];
    // The word must BE a month or a prefix of one ("nov", "sept", "november") -- never merely start with
    // one ("junk", "mayday", "marvel" are rejected; verifier loop 2 D6).
    const mi = mon.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(mon)) : -1;
    if (mi >= 0) {
      const mm = String(mi + 1).padStart(2, "0");
      const dd = String(Number(day)).padStart(2, "0");
      const thisYear = Number(today.slice(0, 4));
      // The NEAREST such date: "jan 3" asked on Dec 30 is next January, not last (D5). A date more than
      // ~6 months behind today is read as next year's.
      let iso = `${thisYear}-${mm}-${dd}`;
      const back = Date.parse(`${today}T12:00:00Z`) - Date.parse(`${iso}T12:00:00Z`);
      if (back > 183 * 86_400_000) iso = `${thisYear + 1}-${mm}-${dd}`;
      return resolveDayArg(iso, nowMs, tz);
    }
  }
  // "this thursday" = the coming one (today included); "next thursday" = the coming one AFTER today.
  let strictlyAfter = false;
  if (s.startsWith("this ")) s = s.slice(5);
  else if (s.startsWith("next ")) {
    s = s.slice(5);
    strictlyAfter = true;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? s : null;
  }
  // A weekday, full or abbreviated ("thu", "thur", "thurs", "tues", "weds").
  const wd = s.length >= 3 ? WEEKDAYS.findIndex((w) => w === s || (w.startsWith(s) && s.length >= 3) || (s === "weds" && w === "wednesday")) : -1;
  if (wd >= 0) {
    const [y, m, d] = today.split("-").map(Number);
    const todayWd = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
    const ahead = (wd - todayWd + 7) % 7;
    return addDays(today, strictlyAfter && ahead === 0 ? 7 : ahead);
  }
  return null;
}

/** Weekday name of a local yyyy-mm-dd. */
export function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const w = WEEKDAYS[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
  return w[0].toUpperCase() + w.slice(1);
}

/** Title key for duplicate detection: case, punctuation and spacing do not make two items different. */
export function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Does a calendar item belong on local `date`? Timed items overlap the local day; all-day items match their date. */
function onDay(item: { startIso: string | null; endIso: string | null; day?: string }, date: string, tz: string): boolean {
  const s = ms(item.startIso);
  // An all-day item carries only its START date (Graph/feed give no end day here), and every reader is
  // scoped to one local day, so an all-day item returned for `date` overlaps it. A multi-day one (a
  // conference 11-09..11-11 read for 11-10) arrives with day 11-09 and MUST still show on 11-10 -- an
  // equality test dropped it and the day was then declared empty (VERIFY-schedule-meetings-1 F1).
  // Only an all-day item dated AFTER this day cannot belong to it.
  if (s === null) return !item.day || item.day <= date;
  const { startIso, endIso } = localDayBoundsUtc(date, tz);
  const dayStart = Date.parse(startIso);
  const dayEnd = Date.parse(endIso);
  const e = ms(item.endIso) ?? s;
  // Overlaps [dayStart, dayEnd): an event 23:00-01:00 belongs to both days (AC-25).
  return s < dayEnd && (e > dayStart || s >= dayStart);
}

/**
 * Merge one local day. PURE.
 *
 * De-duplication is deliberately narrow — it must never hide a real meeting (AC-8):
 *  - the same calendar item twice (same source id, or same title + start + end) is shown once;
 *    a class beats a calendar copy of itself and keeps whichever location exists (AC-7, AC-9, AC-10);
 *  - a task that IS a calendar block (same title, start within 5 min) is shown once, as the task,
 *    so its id and controls survive (AC-11);
 *  - overlapping items with different titles all stay (AC-6), and a task overlapping a meeting/class
 *    is flagged `conflict` (AC-12).
 * Sorted earliest first; all-day items go last, then by title — the brief's rule (AC-26).
 */
export function mergeDayItems(input: {
  date: string;
  tz: string;
  meetings: BriefItem[];
  classes: BriefItem[];
  tasks: TaskForDay[];
}): DayItem[] {
  const { date, tz } = input;
  const cal: DayItem[] = [];
  const bySource = new Set<string>();
  const byKey = new Map<string, DayItem>();
  // Classes first so a class wins over its calendar copy.
  for (const it of [...input.classes, ...input.meetings]) {
    if (!onDay(it, date, tz)) continue;
    const srcKey = it.sourceId ? `${it.kind}|${it.sourceId}` : "";
    if (srcKey && bySource.has(srcKey)) continue;
    const key = `${normTitle(it.title)}|${ms(it.startIso) ?? `allday:${it.day ?? date}`}|${ms(it.endIso) ?? ""}`;
    const prior = byKey.get(key);
    if (prior) {
      if (!prior.location && it.location) prior.location = it.location;
      if (srcKey) bySource.add(srcKey);
      continue;
    }
    const row: DayItem = {
      kind: it.kind,
      title: it.title,
      startIso: it.startIso,
      endIso: it.endIso,
      allDay: it.startIso === null,
      location: it.location,
      ...(it.sourceId ? { sourceId: it.sourceId } : {}),
    };
    if (srcKey) bySource.add(srcKey);
    byKey.set(key, row);
    cal.push(row);
  }

  const out: DayItem[] = [...cal];
  const seenTask = new Set<string>();
  for (const t of input.tasks) {
    if (seenTask.has(t.id)) continue;
    seenTask.add(t.id);
    const ts = ms(t.startIso);
    const row: DayItem = {
      kind: "task",
      title: t.title,
      startIso: t.startIso,
      endIso: t.endIso ?? null,
      allDay: false,
      location: null,
      taskId: t.id,
      status: t.status ?? null,
      category: t.category ?? null,
    };
    // The task IS the calendar block -> replace the block with the task (keeps the location).
    const twin = ts === null ? -1 : out.findIndex(
      (c) => c.kind !== "task" && normTitle(c.title) === normTitle(t.title) && ms(c.startIso) !== null && Math.abs((ms(c.startIso) as number) - ts) <= 5 * 60_000,
    );
    if (twin >= 0) {
      const c = out[twin];
      out[twin] = { ...row, endIso: row.endIso ?? c.endIso, location: c.location };
      continue;
    }
    if (ts !== null) {
      const te = ms(t.endIso) ?? ts + 1; // a task with no end clashes only if it STARTS inside a block
      row.conflict = cal.some((c) => {
        const cs = ms(c.startIso);
        if (cs === null) return false;
        const ce = ms(c.endIso) ?? cs;
        return ts < ce && te > cs;
      }) || undefined;
      if (!row.conflict) delete row.conflict;
    }
    out.push(row);
  }

  return out.sort((a, b) => {
    const at = ms(a.startIso) ?? Number.POSITIVE_INFINITY;
    const bt = ms(b.startIso) ?? Number.POSITIVE_INFINITY;
    return at === bt ? a.title.localeCompare(b.title) : at - bt;
  });
}

/** Race a source against a time bound. A source that never answers becomes a stated "timed out". */
export async function withTimeout<T>(p: Promise<T>, msBound: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(msBound / 1000)}s`)), msBound);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Injected readers — the real ones by default, stubs in tests. */
export interface CalendarDeps {
  meetings: (date: string, tz: string) => Promise<{ items: BriefItem[]; error?: string; warnings?: string[] }>;
  classes: (date: string, tz: string) => Promise<{ items: BriefItem[]; error?: string }>;
}

/** The real readers: the SAME functions the brief uses (AC-30). */
export function realCalendarDeps(opts: {
  caller?: { entra_object_id?: string; entra_email?: string };
  /** Fallback mailbox when the caller's calendar connection cannot be resolved. */
  fallbackMailbox?: string;
  programCodes?: string[];
}): CalendarDeps {
  return {
    meetings: async (date, tz) => {
      const { meetingsForDate } = await import("./schedule-brief.server");
      let mailbox: string | undefined;
      if (opts.caller) {
        const { resolveCalendarMailbox } = await import("../journey/identity");
        mailbox = (await resolveCalendarMailbox(opts.caller)) ?? opts.caller.entra_email;
      }
      mailbox = mailbox ?? opts.fallbackMailbox;
      if (!mailbox) return { items: [], error: "no calendar mailbox is known for this user, so meetings were not read" };
      return meetingsForDate(date, tz, mailbox, date, opts.caller);
    },
    classes: async (date, tz) => {
      const { resolveProgramIds, classesForDate } = await import("./schedule-brief.server");
      const { SCHEDULE_BRIEF_PROGRAM_CODES_DEFAULT } = await import("../identity/scheduling-config.server");
      const prog = await resolveProgramIds(opts.programCodes?.length ? opts.programCodes : SCHEDULE_BRIEF_PROGRAM_CODES_DEFAULT);
      if (!prog.ok) return { items: [], error: prog.error };
      return classesForDate(date, prog.ids, tz);
    },
  };
}

function errText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 200 ? `${m.slice(0, 197)}...` : m;
}

/** Read one local day's meetings and classes, in parallel, each bounded. Never throws. */
export async function readCalendarDay(
  date: string,
  tz: string,
  deps: CalendarDeps,
  timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<CalendarDayRead> {
  const [m, c] = await Promise.allSettled([
    withTimeout(deps.meetings(date, tz), timeoutMs, "calendar read"),
    withTimeout(deps.classes(date, tz), timeoutMs, "class schedule read"),
  ]);
  const meetings = m.status === "fulfilled" ? m.value.items : [];
  const classes = c.status === "fulfilled" ? c.value.items : [];
  const mErr = m.status === "rejected" ? errText(m.reason) : m.value.error;
  const cErr = c.status === "rejected" ? errText(c.reason) : c.value.error;
  const mWarn = m.status === "fulfilled" ? m.value.warnings : undefined;
  return {
    meetings,
    classes,
    sources: {
      meetings: { ok: !mErr, count: meetings.length, ...(mErr ? { error: mErr } : {}), ...(mWarn?.length ? { warnings: mWarn } : {}) },
      classes: { ok: !cErr, count: classes.length, ...(cErr ? { error: cErr } : {}) },
    },
    meetingsMayBeCut: meetings.length >= GRAPH_PAGE,
  };
}

/** Plain-words name of what a failed source would have shown. */
const SOURCE_NOUN: Record<"meetings" | "classes" | "tasks", string> = {
  meetings: "calendar (meetings)",
  classes: "class schedule",
  tasks: "task list",
};

/** True only when every source read cleanly — the ONLY state in which "nothing scheduled" may be said (AC-13). */
export function isComplete(sources: Record<string, SourceStatus>, meetingsMayBeCut = false): boolean {
  return !meetingsMayBeCut && Object.values(sources).every((s) => s.ok && !(s.warnings?.length));
}

/** One sentence per failed or degraded source, for the answer and the trace (AC-14..22). */
export function sourceProblems(sources: Partial<Record<"meetings" | "classes" | "tasks", SourceStatus>>, meetingsMayBeCut = false): string[] {
  const out: string[] = [];
  for (const k of ["meetings", "classes", "tasks"] as const) {
    const s = sources[k];
    if (!s) continue;
    if (!s.ok) {
      const why = s.error ?? "read failed";
      const cause = /\b403\b|forbidden|consent|permission/i.test(why) ? `permission was refused (${why})` : why;
      out.push(`Couldn't read your ${SOURCE_NOUN[k]}: ${cause} — so ${k === "tasks" ? "tasks" : k} may be missing.`);
    }
    for (const w of s.warnings ?? []) out.push(`Your ${SOURCE_NOUN[k]} may be incomplete or out of date: ${w}.`);
  }
  if (meetingsMayBeCut) out.push("The calendar returned its maximum of 50 events, so some meetings may be cut off.");
  return out;
}

/** "9:30 AM" in tz. */
export function clockIn(iso: string | null, tz: string): string | null {
  const t = ms(iso);
  if (t === null) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(t));
  } catch {
    return new Date(t).toISOString().slice(11, 16);
  }
}

/** The JSON the model reads for a one-day schedule question. PURE given its inputs. */
export function dayScheduleToolJson(input: {
  date: string;
  tz: string;
  items: DayItem[];
  sources: { meetings: SourceStatus; classes: SourceStatus; tasks: SourceStatus };
  meetingsMayBeCut?: boolean;
  /** Narrow TASK rows to this category. Meetings and classes are always kept; hidden tasks are counted. */
  category?: string;
}): Record<string, unknown> {
  const { date, tz, sources } = input;
  const want = input.category?.trim().toUpperCase();
  const outside = want ? input.items.filter((i) => i.kind === "task" && String(i.category ?? "").toUpperCase() !== want) : [];
  const items = want ? input.items.filter((i) => !outside.includes(i)) : input.items;
  const complete = isComplete(sources, input.meetingsMayBeCut);
  const problems = sourceProblems(sources, input.meetingsMayBeCut);
  const weekday = weekdayOf(date);
  let tzAbbr = "";
  try {
    tzAbbr =
      new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
        .formatToParts(new Date(Date.parse(localDayBoundsUtc(date, tz).startIso) + 12 * 3_600_000))
        .find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    /* zone label is cosmetic */
  }
  const label = (k: DayItemKind) => (k === "meeting" ? "Meeting" : k === "class" ? "Class" : "Task");
  const otherNote = outside.length
    ? ` ${outside.length} other task(s) outside ${want} are also scheduled that day (not listed) — say so; never call the day empty or free.`
    : "";
  const answer_rule = !items.length
    ? outside.length
      ? `No meetings or classes, and no ${want} tasks, on ${weekday} ${date}.${otherNote}` +
        (complete ? "" : ` ALSO say: ${problems.join(" ")}`)
      : complete
      ? `Every source was read and ${weekday} ${date} has nothing scheduled: no meetings, classes or tasks. You may say so.`
      : `NOT an empty day: ${problems.join(" ")} Say plainly which source you couldn't read and that items may be missing. NEVER say the day is empty, clear or free.`
    : `List EVERY item below for ${weekday} ${date}, in this order, with its time and whether it is a meeting, class or task. Times are already local (${tzAbbr || tz}) — state them as given.` +
      otherNote +
      (complete ? "" : ` ALSO say: ${problems.join(" ")} Never imply the list is complete.`);
  return {
    view: "scheduled",
    date,
    ...(want ? { category: input.category, other_tasks_outside_category: outside.length } : {}),
    weekday,
    timezone: tz,
    complete,
    count: items.length,
    counts: {
      meetings: items.filter((i) => i.kind === "meeting").length,
      classes: items.filter((i) => i.kind === "class").length,
      tasks: items.filter((i) => i.kind === "task").length,
    },
    items: items.map((i) => ({
      kind: label(i.kind),
      title: i.title,
      ...(i.allDay ? { all_day: true } : { start: clockIn(i.startIso, tz), ...(i.endIso ? { end: clockIn(i.endIso, tz) } : {}) }),
      ...(i.location ? { location: i.location } : {}),
      // `id` on task rows only: build_checklist / focus_on act on it.
      ...(i.taskId ? { id: i.taskId, status: i.status ?? null } : {}),
      ...(i.conflict ? { clashes_with_calendar: true } : {}),
    })),
    sources: Object.fromEntries(
      Object.entries(sources).map(([k, s]) => [k, s.ok ? (s.warnings?.length ? `ok with warnings (${s.count})` : `ok (${s.count})`) : `FAILED: ${s.error ?? "read failed"}`]),
    ),
    ...(problems.length ? { problems } : {}),
    answer_rule,
  };
}

/** Read a whole day: calendar + tasks in parallel, each bounded, never throws. */
export async function readDaySchedule(
  date: string,
  tz: string,
  deps: CalendarDeps & { tasks: (date: string, tz: string) => Promise<TaskForDay[]> },
  timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<{ items: DayItem[]; sources: { meetings: SourceStatus; classes: SourceStatus; tasks: SourceStatus }; meetingsMayBeCut: boolean }> {
  const [cal, t] = await Promise.all([
    readCalendarDay(date, tz, deps, timeoutMs),
    withTimeout(deps.tasks(date, tz), timeoutMs, "task read").then(
      (rows) => ({ rows, error: undefined as string | undefined }),
      (err) => ({ rows: [] as TaskForDay[], error: errText(err) }),
    ),
  ]);
  const items = mergeDayItems({ date, tz, meetings: cal.meetings, classes: cal.classes, tasks: t.rows });
  return {
    items,
    sources: {
      ...cal.sources,
      tasks: { ok: !t.error, count: t.rows.length, ...(t.error ? { error: t.error } : {}) },
    },
    meetingsMayBeCut: cal.meetingsMayBeCut,
  };
}

/** The real task reader for one local day — the brief's own query (open, non-parked, start_time in the day). */
export function realTaskReader(userEmail: string): (date: string, tz: string) => Promise<TaskForDay[]> {
  return async (date, tz) => {
    const { getScheduledTasksBetween } = await import("./tasks.server");
    const { startIso, endIso } = localDayBoundsUtc(date, tz);
    // ALL the day's tasks, with their category. A category question is narrowed in dayScheduleToolJson,
    // AFTER counting, so a filtered-out task can never make the day read as empty (verifier loop 2 D7).
    const rows = await getScheduledTasksBetween(userEmail, startIso, endIso);
    return rows.map((r) => ({
      id: r.id,
      title: String(r.title ?? "").trim() || "(untitled)",
      startIso: r.start_time ? new Date(r.start_time).toISOString() : null,
      status: r.status,
      category: r.category ?? null,
    }));
  };
}

/**
 * The Schedule tab's merged Today rows. PURE. Task rows keep the widget's own WidgetTaskRow (so the
 * Doing/Done controls act on the real task); meetings and classes are read-only rows (AC-31..36).
 */
export function composeTodayItems(input: {
  todayKey: string;
  tz: string;
  cal: CalendarDayRead;
  todaySchedule: WidgetTaskRow[];
  /** The task read failed: meetings still list, and the tab says tasks are missing (AC-19/35). */
  tasksError?: string;
}): { todayItems: ScheduleDayEntry[]; todayProblems: string[]; todayNote?: string } {
  const { todayKey, tz, cal, todaySchedule, tasksError } = input;
  const byId = new Map(todaySchedule.map((r) => [r.id, r]));
  const merged = mergeDayItems({
    date: todayKey,
    tz,
    meetings: cal.meetings,
    classes: cal.classes,
    tasks: todaySchedule.map((r) => ({ id: r.id, title: r.title, startIso: r.startTime, endIso: r.endTime, status: r.status })),
  });
  const todayItems: ScheduleDayEntry[] = [];
  for (const it of merged) {
    if (it.kind === "task") {
      const task = it.taskId ? byId.get(it.taskId) : undefined;
      if (task) todayItems.push({ kind: "task", task, ...(it.conflict ? { conflict: true } : {}) });
      continue;
    }
    todayItems.push({
      kind: it.kind,
      title: it.title,
      startTime: it.startIso,
      endTime: it.endIso,
      allDay: it.allDay,
      location: it.location,
    });
  }
  const todayProblems = sourceProblems(
    { ...cal.sources, ...(tasksError ? { tasks: { ok: false, error: tasksError, count: 0 } } : {}) },
    cal.meetingsMayBeCut,
  );
  const calCount = todayItems.filter((i) => i.kind !== "task").length;
  const taskCount = todayItems.length - calCount;
  const todayNote =
    !tasksError && taskCount === 0 && calCount > 0
      ? `No tasks are placed today — today has ${calCount} ${calCount === 1 ? "meeting or class" : "meetings and classes"}.`
      : undefined;
  return { todayItems, todayProblems, ...(todayNote ? { todayNote } : {}) };
}

/** Read today's calendar for the Schedule tab; a failure becomes a stated problem, never an empty day. */
export async function readTodayCalendar(
  todayKey: string,
  tz: string,
  caller: { entra_object_id?: string; entra_email?: string } | undefined,
  fallbackMailbox?: string,
): Promise<CalendarDayRead> {
  return readCalendarDay(todayKey, tz, realCalendarDeps({ caller, fallbackMailbox }));
}
