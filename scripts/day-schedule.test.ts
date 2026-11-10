// WHAT:       Proves "what's on my day" returns meetings + classes + tasks for ONE local day, merged,
//             de-duplicated and labelled, and that a source that fails is SAID, never read as an empty day.
// WHY:        2026-11-10 07:06 ET Iris said "no items scheduled for today" on a day with 8 meetings and a
//             class: every chat schedule tool read tasks only (and offered Wednesday's task as today's).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/AC-schedule-meetings.md (INCIDENT-DAY fixture, AC numbers below).
// RUN IT:     bun scripts/day-schedule.test.ts

import { readFileSync } from "node:fs";
import {
  composeTodayItems,
  dayScheduleToolJson,
  isComplete,
  mergeDayItems,
  readCalendarDay,
  readDaySchedule,
  resolveDayArg,
  type CalendarDeps,
  type TaskForDay,
} from "../src/features/huddle/lib/tasks/day-schedule.server";
import type { BriefItem } from "../src/features/huddle/lib/tasks/schedule-brief.server";
import type { WidgetTaskRow } from "../src/features/huddle/lib/tasks/widgets.server";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${detail}`}`);
}

const TZ = "America/New_York";
const DATE = "2026-11-10"; // a Tuesday, EST (UTC-5)
// 07:05 ET on the incident day.
const NOW = Date.parse("2026-11-10T12:05:00Z");
const at = (hhmm: string, date = DATE) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + ((h + 5) * 60 + m) * 60_000).toISOString();
};
const mtg = (id: string, s: string, e: string, title: string, location: string | null = null): BriefItem => ({
  sourceId: id, kind: "meeting", title, startIso: at(s), endIso: at(e), location, day: DATE,
});
const MEETINGS: BriefItem[] = [
  mtg("e1", "09:30", "10:00", "Standup"),
  mtg("e2", "10:00", "11:30", "Client review"),
  mtg("e3", "11:00", "12:00", "1:1"),
  mtg("e4", "11:30", "12:00", "Sync"),
  mtg("e5", "13:00", "14:00", "Planning"),
  mtg("e6", "14:00", "15:00", "Vendor call"),
  mtg("e7", "15:00", "16:00", "Design review"),
  mtg("e9", "19:00", "22:00", "MBA Strategy", "Room 204"), // calendar copy of the class
];
const CLASSES: BriefItem[] = [
  { sourceId: "c8", kind: "class", title: "MBA Strategy", startIso: at("19:00"), endIso: at("22:00"), location: null },
];
const WEDNESDAY_TASK: TaskForDay = { id: "t-wed", title: "Wednesday task", startIso: at("10:00", "2026-11-11") };

const okDeps = (over: Partial<CalendarDeps> = {}): CalendarDeps => ({
  meetings: async () => ({ items: MEETINGS }),
  classes: async () => ({ items: CLASSES }),
  ...over,
});

// The real task reader filters by the day in SQL; the stub mimics that so the Wednesday task never reaches today.
const tasksFor = (all: TaskForDay[]) => async (date: string) =>
  all.filter((t) => t.startIso && new Date(Date.parse(t.startIso) - 5 * 3_600_000).toISOString().slice(0, 10) === date);

// --- AC-1 / AC-6 / AC-7: the incident day --------------------------------------------------------
{
  const day = await readDaySchedule(DATE, TZ, { ...okDeps(), tasks: tasksFor([WEDNESDAY_TASK]) });
  const j = dayScheduleToolJson({ date: DATE, tz: TZ, ...day }) as Record<string, any>;
  const titles = j.items.map((i: any) => i.title);
  check("AC-1 eight items for today", j.count === 8, JSON.stringify(titles));
  check(
    "AC-1 time order E1..E8",
    JSON.stringify(titles) ===
      JSON.stringify(["Standup", "Client review", "1:1", "Sync", "Planning", "Vendor call", "Design review", "MBA Strategy"]),
    JSON.stringify(titles),
  );
  check("AC-1 no Wednesday item", !titles.includes("Wednesday task"));
  check("AC-1 first item is 9:30 AM", j.items[0].start === "9:30 AM", j.items[0].start);
  check("AC-1 every item has a kind label", j.items.every((i: any) => ["Meeting", "Class", "Task"].includes(i.kind)));
  check("AC-6 overlapping meetings all kept", ["Client review", "1:1", "Sync"].every((t) => titles.includes(t)));
  const mba = j.items.filter((i: any) => i.title === "MBA Strategy");
  check("AC-7 class + calendar copy shown once", mba.length === 1, JSON.stringify(mba));
  check("AC-7 the class label wins", mba[0]?.kind === "Class", JSON.stringify(mba));
  check("AC-7 location filled from the copy", mba[0]?.location === "Room 204", JSON.stringify(mba));
  check("AC-13 complete when every source read OK", j.complete === true);
  check("answer rule says list every item", /List EVERY item/.test(j.answer_rule));
  check("weekday is Tuesday", j.weekday === "Tuesday", j.weekday);
}

// --- AC-8: same time, different titles, both stay ------------------------------------------------
{
  const items = mergeDayItems({
    date: DATE, tz: TZ, classes: [], tasks: [],
    meetings: [mtg("a", "13:00", "14:00", "Planning"), mtg("b", "13:00", "14:00", "Budget")],
  });
  check("AC-8 two different meetings at one time both appear", items.length === 2);
}

// --- AC-9 / AC-10: duplicates across feeds / programme codes ---------------------------------------
{
  const items = mergeDayItems({
    date: DATE, tz: TZ, tasks: [],
    meetings: [mtg("x", "09:30", "10:00", "Standup"), mtg("x-feed", "09:30", "10:00", "standup!")],
    classes: [CLASSES[0], CLASSES[0]],
  });
  check("AC-9 same meeting from two feeds once", items.filter((i) => i.kind === "meeting").length === 1, JSON.stringify(items));
  check("AC-10 same class under two programmes once", items.filter((i) => i.kind === "class").length === 1);
}

// --- AC-11 / AC-12: task twin and clash --------------------------------------------------------------
{
  const items = mergeDayItems({
    date: DATE, tz: TZ, classes: [],
    meetings: [mtg("b1", "13:00", "14:00", "Write the deck"), mtg("p", "15:00", "16:00", "Design review")],
    tasks: [
      { id: "t1", title: "Write the deck", startIso: at("13:03") },
      { id: "t2", title: "Pay rent", startIso: at("15:30") },
    ],
  });
  const deck = items.filter((i) => /deck/i.test(i.title));
  check("AC-11 task that IS the block shown once, as the task", deck.length === 1 && deck[0].kind === "task" && deck[0].taskId === "t1", JSON.stringify(deck));
  const rent = items.find((i) => i.taskId === "t2");
  check("AC-12 task inside a meeting is flagged as a clash", rent?.conflict === true, JSON.stringify(rent));
}

// --- AC-13: a genuinely empty day may be called empty ------------------------------------------------
{
  const day = await readDaySchedule(DATE, TZ, {
    meetings: async () => ({ items: [] }),
    classes: async () => ({ items: [] }),
    tasks: async () => [],
  });
  const j = dayScheduleToolJson({ date: DATE, tz: TZ, ...day }) as Record<string, any>;
  check("AC-13 empty + complete => may say nothing scheduled", j.complete === true && /nothing scheduled/.test(j.answer_rule));
}

// --- AC-14..22: failures are said, never an empty day --------------------------------------------------
async function failing(over: Partial<CalendarDeps>, tasks?: () => Promise<TaskForDay[]>, timeoutMs?: number) {
  const day = await readDaySchedule(DATE, TZ, { ...okDeps(over), tasks: tasks ?? (async () => []) }, timeoutMs);
  return dayScheduleToolJson({ date: DATE, tz: TZ, ...day }) as Record<string, any>;
}
{
  const j = await failing({ meetings: async () => { throw new Error("Graph exploded"); }, classes: async () => ({ items: [] }) });
  check("AC-14 calendar throws => complete:false", j.complete === false);
  check("AC-14 rule forbids calling the day empty", /NEVER say the day is empty/.test(j.answer_rule), j.answer_rule);
  check("AC-14 rule names the calendar", /calendar/.test(j.answer_rule), j.answer_rule);
  check("AC-21 sources show the failure", /FAILED: Graph exploded/.test(j.sources.meetings), JSON.stringify(j.sources));
}
{
  const j = await failing({ meetings: async () => ({ items: [], error: "Graph calendarView 403 Forbidden" }) });
  check("AC-15 403 names permission", j.problems?.some((p: string) => /permission/.test(p)), JSON.stringify(j.problems));
  check("AC-15 classes still listed", j.items.some((i: any) => i.kind === "Class"));
}
{
  const j = await failing({ meetings: async () => ({ items: [], error: "Microsoft Graph is not configured, so meetings were not read" }) });
  check("AC-16 Graph not configured => incomplete, stated", j.complete === false && /not configured/.test(j.answer_rule + JSON.stringify(j.problems)));
}
{
  const j = await failing({ meetings: async () => ({ items: MEETINGS.slice(0, 2), warnings: ["work calendar feed last refreshed 3 days ago"] }) });
  check("AC-17 stale feed warning carried, EDS items still listed", j.complete === false && j.count >= 2 && j.problems.some((p: string) => /3 days ago/.test(p)));
}
{
  const j = await failing({ classes: async () => ({ items: [], error: "no programme matched DBA" }) });
  check("AC-18 class read fails => meetings still list + stated", j.count >= 7 && j.problems.some((p: string) => /class schedule/.test(p)));
}
{
  const j = await failing({}, async () => { throw new Error("pg pool down"); });
  check("AC-19 task read fails => meetings + classes still list", j.count === 8 && /FAILED: pg pool down/.test(j.sources.tasks), JSON.stringify(j.sources));
}
{
  const t0 = Date.now();
  const j = await failing({ meetings: () => new Promise(() => {}) }, undefined, 300);
  const took = Date.now() - t0;
  check("AC-20 a hung calendar read times out and is stated", /timed out/.test(j.sources.meetings), JSON.stringify(j.sources));
  check("AC-41 the hung source does not hold the answer past its bound", took < 1500, `${took}ms`);
  check("AC-20 other sources' items still returned", j.items.some((i: any) => i.kind === "Class"));
  check("AC-22 complete:false on a partial read", j.complete === false);
}
check("AC-43 a full Graph page marks meetings possibly cut", !isComplete({ m: { ok: true, count: 50 } }, true));
{
  const many = Array.from({ length: 50 }, (_, i) => mtg(`m${i}`, "09:00", "09:30", `M${i}`));
  const cal = await readCalendarDay(DATE, TZ, okDeps({ meetings: async () => ({ items: many }) }));
  check("AC-43 50 events => meetingsMayBeCut", cal.meetingsMayBeCut === true);
}

// --- AC-23..27: which day ------------------------------------------------------------------------------
check("AC-23 00:30 ET is that day, not yesterday", resolveDayArg(undefined, Date.parse("2026-11-10T05:30:00Z"), TZ) === "2026-11-10");
check("AC-24 23:30 ET is still that day", resolveDayArg("today", Date.parse("2026-11-11T04:30:00Z"), TZ) === "2026-11-10");
check("AC-27 tomorrow", resolveDayArg("tomorrow", NOW, TZ) === "2026-11-11");
check("AC-27 thursday (next one)", resolveDayArg("Thursday", NOW, TZ) === "2026-11-12");
check("AC-27 tuesday today counts", resolveDayArg("tue", NOW, TZ) === "2026-11-10");
check("AC-27 explicit date", resolveDayArg("2026-11-13", NOW, TZ) === "2026-11-13");
check("AC-27 bad date rejected", resolveDayArg("2026-02-30", NOW, TZ) === null && resolveDayArg("someday", NOW, TZ) === null);
check("date 'all' keeps the old every-day path", resolveDayArg("all", NOW, TZ) === "all");
{
  const late: BriefItem = { sourceId: "late", kind: "meeting", title: "Late call", startIso: at("23:00"), endIso: at("01:00", "2026-11-11"), location: null };
  const d10 = mergeDayItems({ date: DATE, tz: TZ, meetings: [late], classes: [], tasks: [] });
  const d11 = mergeDayItems({ date: "2026-11-11", tz: TZ, meetings: [late], classes: [], tasks: [] });
  check("AC-25 an event crossing midnight shows on both days", d10.length === 1 && d11.length === 1);
  const wed: BriefItem = { sourceId: "wed", kind: "meeting", title: "Wednesday meeting", startIso: at("10:00", "2026-11-11"), endIso: at("11:00", "2026-11-11"), location: null };
  const tue = mergeDayItems({ date: DATE, tz: TZ, meetings: [wed], classes: [], tasks: [] });
  check("AC-1 a timed item on another day never lands on today", tue.length === 0, JSON.stringify(tue));
  const allDay: BriefItem = { sourceId: "ad", kind: "meeting", title: "Holiday", startIso: null, endIso: null, location: null, day: DATE };
  const prev = mergeDayItems({ date: "2026-11-09", tz: TZ, meetings: [allDay], classes: [], tasks: [] });
  const same = mergeDayItems({ date: DATE, tz: TZ, meetings: [allDay], classes: [], tasks: [] });
  check("AC-26 all-day event stays on its own date", prev.length === 0 && same.length === 1 && same[0].allDay);
  const j = dayScheduleToolJson({
    date: DATE, tz: TZ, items: same,
    sources: { meetings: { ok: true, count: 1 }, classes: { ok: true, count: 0 }, tasks: { ok: true, count: 0 } },
  }) as Record<string, any>;
  check("AC-26 all-day rendered as all_day", j.items[0].all_day === true);
}
{
  // DST: 2026-11-02 is EST; a 09:30 local meeting reads 9:30 AM.
  const iso = new Date(Date.parse("2026-11-02T14:30:00Z")).toISOString();
  const items = mergeDayItems({ date: "2026-11-02", tz: TZ, meetings: [{ sourceId: "d", kind: "meeting", title: "DST", startIso: iso, endIso: null, location: null }], classes: [], tasks: [] });
  const j = dayScheduleToolJson({ date: "2026-11-02", tz: TZ, items, sources: { meetings: { ok: true, count: 1 }, classes: { ok: true, count: 0 }, tasks: { ok: true, count: 0 } } }) as Record<string, any>;
  check("AC-28 after the DST change 09:30 stays 9:30 AM", j.items[0].start === "9:30 AM", j.items[0].start);
}

// --- AC-31..36: the Schedule tab's merged Today ----------------------------------------------------------
const wrow = (id: string, title: string, start: string): WidgetTaskRow => ({
  id, title, status: "TODO", category: "JOB", isPriority: false, priorityRank: null, dueDate: null,
  startTime: at(start), endTime: null, isScheduled: true, tags: [], assignedAgent: null, isToday: true,
});
{
  const cal = await readCalendarDay(DATE, TZ, okDeps());
  const t = composeTodayItems({ todayKey: DATE, tz: TZ, cal, todaySchedule: [] });
  check("AC-31 tab shows the 8 merged items", t.todayItems.length === 8, String(t.todayItems.length));
  check("AC-31 tab rows carry a kind", t.todayItems.every((i) => ["meeting", "class", "task"].includes(i.kind)));
  check("AC-36 note when no tasks are placed but the calendar has items", /No tasks are placed today/.test(t.todayNote ?? ""), String(t.todayNote));
  check("AC-35 no problems when every source read", t.todayProblems.length === 0);
}
{
  const cal = await readCalendarDay(DATE, TZ, okDeps());
  const t = composeTodayItems({ todayKey: DATE, tz: TZ, cal, todaySchedule: [wrow("t1", "Pay rent", "17:30")] });
  const task = t.todayItems.find((i) => i.kind === "task");
  check("AC-33 task row keeps the real WidgetTaskRow (controls act on it)", task?.kind === "task" && task.task.id === "t1");
  check("AC-36 no 'no tasks' note when a task is placed", !t.todayNote);
  check("task sorted after Design review (17:30)", t.todayItems.findIndex((i) => i.kind === "task") === 7);
}
{
  const cal = await readCalendarDay(DATE, TZ, okDeps({ meetings: async () => { throw new Error("Graph down"); } }));
  const t = composeTodayItems({ todayKey: DATE, tz: TZ, cal, todaySchedule: [] });
  check("AC-35 tab states a failed calendar read", t.todayProblems.some((p) => /Couldn't read your calendar/.test(p)), JSON.stringify(t.todayProblems));
}

// --- AC-30: extend, don't duplicate ------------------------------------------------------------------------
{
  const src = readFileSync("src/features/huddle/lib/tasks/day-schedule.server.ts", "utf8");
  check("AC-30 reuses meetingsForDate + classesForDate", /meetingsForDate\(/.test(src) && /classesForDate\(/.test(src));
  check("AC-30 no new Graph calendarView call / journey table read", !/calendarView|external_calendar_events/.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));
}

// --- AC-2..4 / AC-45: every chat path reaches the same day reader ------------------------------------------
{
  const tools = readFileSync("src/features/huddle/lib/tasks/tools.ts", "utf8");
  check("AC-2 the 'scheduled' view runs the day reader", /view === "scheduled" && !category[\s\S]{0,600}readDaySchedule/.test(tools));
  const fns = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
  const starts = [...fns.matchAll(/(?<!function )dispatchPrioritize\(/g)].map((m) => m.index ?? 0);
  const withCaller = starts.filter((i) => fns.slice(i, i + 400).includes("{ caller: data.caller }"));
  check("AC-3/4 OpenAI + both Lovable calls pass the caller", starts.length === 3 && withCaller.length === 3, `${withCaller.length}/${starts.length}`);
  const voice = readFileSync("src/features/huddle/lib/voice/realtime-tools.server.ts", "utf8");
  check("AC-3 voice passes the caller", /dispatchPrioritize\([^;]*\{ caller: ctx\.caller \}/.test(voice));
  check("AC-45 Lovable descriptions no longer contradict", !/Outlook calendar' ask uses get_calendar_events instead/.test(fns));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
