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

