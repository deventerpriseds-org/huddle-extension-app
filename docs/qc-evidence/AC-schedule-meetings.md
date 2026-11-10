<!--
WHAT:          independent, adversarial acceptance criteria for "chat schedule answers + Schedule tab
               include meetings and classes, not tasks only" (incident 2026-11-10, Iris 7:05 AM ET).
WHY:           "What is my schedule for today?" returned "no items scheduled for today" on a day with
               8 meetings + an evening class. Owner: "catastrophic ... I could have missed my appointments".
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      read cold from origin/main 6d6d7bc2 (2026-11-10). File:line citations below.
               Written by the AC subagent, which shares no context with the implementer.
-->

# Acceptance Criteria — chat schedule + Schedule tab show meetings, classes and tasks

**Task:** chat schedule answers (`schedule_and_priorities` view `scheduled`, `get_calendar_events`) and
the Schedule tab's "Today's schedule" use the SAME meeting and class readers the brief uses
(`meetingsForDate`, `classesForDate`), merged with tasks, ordered by time, each item labelled
meeting / class / task.

**Tier:** 1. This answer decides whether the owner believes he is free. A false "nothing scheduled"
is the accusation-grade failure. It also parses user phrasing (routing), so a spelling table applies.

**Sources read (origin/main 6d6d7bc2):**
- `src/features/huddle/lib/tasks/tools.ts` (tool schema 17-55, `PRIORITIZE_SYSTEM_HINT` 361,
  `dispatchPrioritize` 368-470, `dispatchScheduleWidget` 321-345)
- `src/features/huddle/lib/huddle.functions.ts` 4738-4770 (OpenAI path), 6178-6215 (Lovable path),
  4941-4985 and 6508-6534 (`get_external_calendar_events`)
- `src/features/huddle/lib/tasks/schedule-brief.server.ts` 34-90, 200-235 (`classesForDate`),
  300-370 (`meetingsForDate`), 375-487 (`buildScheduleBrief`)
- `src/features/huddle/lib/email/graph-email.server.ts` 560-620 (`getOwnerCalendarEvents`,
  `getGraphCalendarEvents`)
- `src/features/huddle/lib/tasks/widgets.server.ts` 396-430 (`buildScheduleSections`)
- `src/features/huddle/lib/tasks/widgets.functions.ts` 57-95 (`getScheduleWidget`)
- `src/features/huddle/components/JourneyWidgets.tsx` 1375-1400
- `src/features/huddle/lib/voice/realtime-tools.server.ts` 60, 109-111, 538-601
- `src/features/huddle/lib/calendar/tools.ts` 1-10, `src/features/huddle/lib/nexus/nexus.server.ts` 308

**Existing system this extends (not duplicates):** `meetingsForDate` + `classesForDate` +
`localDayBoundsUtc` in `schedule-brief.server.ts`, and `getOwnerCalendarEvents` (EDS Graph + OneDrive
work feed) in `graph-email.server.ts`. The fix must call these. A second Graph reader, a second
work-feed parser, a second Nexus class reader, or a new read of journey `public.external_calendar_events`
standing next to them is a parallel system and fails AC-30.

## Root-cause check (the implementer's reading, verified cold)

| Claim | Verdict | Evidence |
|---|---|---|
| `get_calendar_events` and `schedule_and_priorities` both run `dispatchPrioritize` | CONFIRMED | `huddle.functions.ts:4738-4753`; Lovable `6196`, `6213`; voice `realtime-tools.server.ts:593-601` |
| `dispatchPrioritize` reads tasks only | CONFIRMED | `tools.ts:420` `getTasksForUser`; no Graph, feed or Nexus call anywhere in 368-470 |
| `scheduled` view is NOT limited to today | CONFIRMED, and it is a second cause | `tools.ts:430` `return !!t.is_scheduled` with no date filter, so a day with 0 tasks returns Wednesday's tasks, which is exactly what Iris said ("next scheduled items begin Wednesday") |
| the tool has no date argument | CONFIRMED | schema `tools.ts:23-45` has `view`, `category`, `limit` only. "tomorrow" and "Thursday" cannot be expressed as an argument |
| Schedule tab today section is tasks only | CONFIRMED | `widgets.server.ts:410-412` filters `widgetRows` (from `getBoardTasks`) on `isScheduled` |
| brief reads meetings + classes | CONFIRMED | `schedule-brief.server.ts:405`, `410` |
| descriptions promise calendar items | CONFIRMED | `huddle.functions.ts:6207` "COMBINED nightly schedule (tasks + calendar)"; `tools.ts:19` |
| the two Lovable descriptions contradict each other | NEW FINDING | `6183` says "Only an explicit 'external/Outlook calendar' ask uses get_calendar_events instead"; `6207` says get_calendar_events is the combined schedule and the raw read is `get_external_calendar_events` |
| EDS and work-feed events are de-duplicated | NOT DONE | `graph-email.server.ts:586` concatenates `[...r.events, ...feed.events]` and sorts, with no key. The brief inherits this |
| classes are de-duplicated across programmes | NOT DONE | `classesForDate` loops `programIds` and pushes every session (`schedule-brief.server.ts:213-231`). The same session under two programme codes shows twice. This is a candidate cause of the duplicated 19:00-22:00 class |
| Graph read is bounded in size | PARTLY | `$top` defaults 50, max 100 (`graph-email.server.ts:608`); no `@odata.nextLink` follow seen. Fine for one day, a risk for a week |
| Graph/feed/Nexus reads have a timeout | NOT SEEN | no AbortController or timeout in `meetingsForDate` or `classesForDate`. The chat turn has a ~45s ceiling |

Ground-truth caveat. The incident says the day lives in journey `public.external_calendar_events`.
The brief does NOT read that table: it reads Graph + the OneDrive feed + Nexus. I did not query the
table or the live calendar, so "the brief's readers return the same 9 items" is an inference from the
owner's statement that the 8 PM brief listed them. AC-29 makes that a checked fact rather than an
assumption.

## Fixture used by several ACs: INCIDENT-DAY

Owner zone `America/New_York`. Date 2026-11-10 (EST, UTC-5). Tasks scheduled today: **0** (the planner
placed none, `no_fit`). One task is scheduled on Wednesday 2026-11-11 at 10:00. Calendar sources return:

| # | local time | source | title (fixture) |
|---|---|---|---|
| E1 | 09:30-10:00 | EDS Graph | Standup |
| E2 | 10:00-11:30 | work feed | Client review |
| E3 | 11:00-12:00 | EDS Graph | 1:1 |
| E4 | 11:30-12:00 | work feed | Sync |
| E5 | 13:00-14:00 | EDS Graph | Planning |
| E6 | 14:00-15:00 | work feed | Vendor call |
| E7 | 15:00-16:00 | EDS Graph | Design review |
| E8 | 19:00-22:00 | Nexus class | MBA Strategy |
| E9 | 19:00-22:00 | EDS Graph (calendar copy of the class) | MBA Strategy |

The fixture is built at the reader boundary (stub `getOwnerCalendarEvents` and `executeNexusTool`),
NOT by stubbing the new merge function, so the test proves the real readers are called.

## Acceptance criteria

Category key: HP happy path, ED edge, ER error, TZ time/day, DD de-dup, UI Schedule tab, RG regression,
PF performance, RT routing. "origin/main" column = my hypothesis of today's behaviour, with the line read.

| # | Given / When / Then | Cat | Observed via | origin/main (hypothesis) |
|---|---|---|---|---|
| AC-1 | Given INCIDENT-DAY, when `get_calendar_events` is dispatched with `{}` at 07:05 ET, then the returned JSON holds exactly 8 items for 2026-11-10, in the order E1, E2, E3, E4, E5, E6, E7, E8/E9 (one row), each with `kind` in {meeting, class, task}, a local start and end, and NO item from Wednesday | HP | unit test on dispatcher output | FAILS: returns the Wednesday task, 0 meetings (`tools.ts:430`, `4738-4753`) |
| AC-2 | Same fixture, same call through `schedule_and_priorities` `{view:"scheduled"}`: identical item list to AC-1 (same ids, same order) | HP | unit test, deep-equal of the two outputs | FAILS (`tools.ts:430`) |
| AC-3 | Same fixture, the voice path (`realtime-tools.server.ts` `get_calendar_events`) returns the same item list as AC-1 | HP | unit test on `realtime-tools` executor | FAILS (`realtime-tools.server.ts:593-601`) |
| AC-4 | Same fixture, the Lovable path tools (`huddle.functions.ts:6181`, `6205`) return the same list as AC-1 | HP | unit test or harness | FAILS (`6196`, `6213`) |
| AC-5 | Given INCIDENT-DAY, when the owner asks Iris "What is my schedule for today?" in a 1:1 (live, `test-agent-serverfn`, `journey:{enabled:false}`), then the reply names all 8 items with times, says 9:30 is first, and contains none of: "no items", "nothing scheduled", "clear", "free day", "begin Wednesday" | HP | harness reply text + tool trace showing the schedule tool ran | FAILS (incident) |
| AC-6 | Overlapping items are NOT treated as duplicates: E2 (10:00-11:30), E3 (11:00-12:00) and E4 (11:30-12:00) all appear | DD | unit test | n/a today (no meetings) |
| AC-7 | E8 and E9 (same normalized title, same start, same end, one a class and one a calendar copy) appear ONCE, labelled `class` (the more specific source wins), with the location from whichever source has one | DD | unit test | FAILS: no de-dup anywhere (`graph-email.server.ts:586`, `schedule-brief.server.ts:213-231`) |
| AC-8 | Two items at the same time with DIFFERENT titles both appear (de-dup must never hide a real meeting) | DD | unit test | n/a |
| AC-9 | The same Graph event returned by both the EDS calendar and the work feed (same iCalUId, or same normalized title + start + end) appears once | DD | unit test with a duplicated event across the two sources | FAILS (`graph-email.server.ts:586` concatenates) |
| AC-10 | The same class session returned under two programme codes appears once | DD | unit test, two `programIds` returning one session id | FAILS (`schedule-brief.server.ts:213`) |
| AC-11 | A task that is ALSO a calendar block (same normalized title, start within 5 min) appears once, labelled `task` and carrying its task id, so task actions (done, doing) still work on it | DD | unit test | n/a |
| AC-12 | A task and a meeting at the same time with different titles both appear, flagged as a clash (`conflict: true` or equivalent) | ED | unit test | n/a |
| AC-13 | Given a day with 0 tasks and 0 calendar items and ALL sources read OK, then the answer says nothing is scheduled. This is the ONLY condition under which "nothing scheduled" may be said | ED | unit test on the JSON (`sources` all ok, `items: []`) | partly: today it says it when only the task source was read |
| AC-14 | Given 0 tasks and calendar read FAILS (Graph throws), then the JSON carries `items` from the sources that worked plus a per-source error, and the reply says in words "I couldn't read your calendar, so meetings may be missing", and does NOT say "nothing scheduled" or "you're free" | ER | unit test + one harness turn with the reader stubbed to throw | FAILS: calendar never read, so the gap is invisible |
| AC-15 | Graph 403 (consent missing) produces the AC-14 behaviour, and the error text names the cause (permission) rather than "calendar read failed" | ER | unit test | FAILS |
| AC-16 | Graph not configured (`graphEmailConfigured()` false) produces the AC-14 behaviour ("meetings were not read"), never an empty-day answer | ER | unit test, mirrors `schedule-brief.server.ts:323-325` | FAILS |
| AC-17 | Work feed missing or stale (the `warnings` array from `getOwnerCalendarEvents`) is carried to the answer: "work meetings may be missing / out of date as of <time>". EDS meetings still listed | ER | unit test | FAILS |
| AC-18 | Classes read fails (Nexus error, or `resolveProgramIds` fails) produces a stated "couldn't read your classes" while meetings and tasks still list | ER | unit test | FAILS |
| AC-19 | Task mirror read fails but calendar reads succeed: meetings and classes still list, plus "couldn't read your tasks". Today a task failure returns a top-level error and loses everything (`tools.ts` catch) | ER | unit test | FAILS |
| AC-20 | A source that exceeds its time bound (see AC-41) is reported as "timed out" with the same wording rule as AC-14, and the other sources' items are returned | ER/PF | unit test with a reader that never resolves | FAILS (no timeout in `meetingsForDate`) |
| AC-21 | Every failure in AC-14..AC-20 appears in `recordToolUse` detail, so the tool trace shows which source failed (today `ok` keys on top-level `error` only, `huddle.functions.ts:4757-4762`) | ER | tool trace in harness output | FAILS |
| AC-22 | The model is instructed, in the tool result itself (not only the prompt), that a partial read is not an empty day: the JSON carries `complete: false` when any source failed | ER | unit test on JSON | FAILS |
