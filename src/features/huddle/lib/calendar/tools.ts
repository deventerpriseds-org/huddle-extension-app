// SINGLE-SOURCE schemas for the two calendar-facing tools. There is ONE executor for "the user's
// calendar/day" — dispatchPrioritize (the combined nightly schedule) — and `get_calendar_events` is
// just an ALIAS that routes into it (see the dispatch paths), so there's ONE place to update. The
// separate raw-Outlook read is quarantined behind an explicit name.
//
// Why: Huddle's native Microsoft/Outlook calendar read (getGraphCalendarEvents, added 2026-07-22)
// started shadowing "what's on my calendar", but Outlook Graph is 403 (no Calendars.Read consent),
// so calendar questions broke. The combined schedule (tasks + external calendar, built nightly) is the
// real source of truth and is what should answer "calendar/schedule/day". So:
//   - get_calendar_events        → the combined schedule (alias → dispatchPrioritize, view 'scheduled')
//   - get_external_calendar_events → the RAW external Outlook/Microsoft calendar (Graph), explicit-only

/** Calendar/day for the user — an ALIAS whose executor is the same combined schedule as
 *  schedule_and_priorities (dispatch forces view 'scheduled'). No separate executor to keep in sync. */
export const GET_CALENDAR_EVENTS_TOOL = {
  type: "function" as const,
  name: "get_calendar_events",
  description:
    "The user's calendar / day / schedule — their COMBINED nightly schedule (tasks + calendar items), the source of truth. Use this for \"what's on my calendar / schedule / agenda / day / plate / today\", meetings, or appointments. Returns the day's scheduled items with times already in the user's timezone. (For the user's RAW external Outlook/Microsoft calendar specifically, use get_external_calendar_events instead — only when they explicitly ask for their external/Outlook calendar.)",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      category: {
        type: "string",
        description: "Optional domain to scope to (LIFE, VENTURES, CAREER, EDUCATION, PERSONAL, PROF_EDUCATION). Omit to span everything.",
      },
    },
    required: [] as string[],
  },
  strict: false,
};

/** RAW external Microsoft/Outlook calendar (Graph). Executor: getGraphCalendarEvents. Explicit-only —
 *  needs Calendars.Read admin consent (403 until granted). */
export const GET_EXTERNAL_CALENDAR_EVENTS_TOOL = {
  type: "function" as const,
  name: "get_external_calendar_events",
  description:
    "Read the user's RAW EXTERNAL Microsoft/Outlook calendar directly. RARE — use this ONLY when the user EXPLICITLY says \"external calendar\", \"Outlook calendar\", or \"Microsoft calendar\" (they want to bypass their normal schedule and see the raw external calendar). Do NOT use it for ANY other wording — \"what's on my calendar / schedule / agenda / day / plate / today\", meetings, appointments, tasks, priorities, or backlog ALL go to get_calendar_events / schedule_and_priorities. Reads REAL calendar data — never answer from memory. Dates are ISO (YYYY-MM-DD or full ISO datetime). Returns Microsoft/Outlook events; a Google-only calendar won't appear.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      start: {
        type: "string",
        description: "Start of the range, ISO date or datetime (e.g. 2026-07-21). Defaults to today.",
      },
      end: {
        type: "string",
        description: "End of the range, ISO date or datetime. Defaults to the end of the start day.",
      },
    },
    required: [] as string[],
  },
  // Responses/Chat API field; the Realtime path strips it via toRealtimeTool (Realtime rejects `strict`).
  strict: false,
};
