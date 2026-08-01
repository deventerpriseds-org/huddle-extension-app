// Canonical, SINGLE-SOURCE schema for the `get_calendar_events` agent tool.
//
// WHY THIS FILE EXISTS: every other governed tool already has one shared definition that BOTH channels
// import — `PRIORITIZE_TOOL` (tasks/tools), `SCHEDULE_REMINDER_TOOL` (tasks/reminders),
// `GROOM_BACKLOG_TOOL` (tasks/groom), `TAVILY_WEB_SEARCH_TOOL` (tavily-search.functions). Calendar was
// the ONE exception: it was declared inline in the text turn engine (huddle.functions.ts) AND
// re-declared in the voice toolset (voice/realtime-tools.server.ts). Two copies = two Irises that drift
// — which is exactly how "what's my schedule" came to mean the combined `prioritize` schedule in one
// channel and raw Outlook in the other. There is ONE Iris; a channel is just "audio attached or not".
// Both the text path and the voice path import THIS constant now, so a wording/behaviour change happens
// in one place and every channel stays in lock-step.
//
// Executor: `getGraphCalendarEvents` in email/graph-email.server.ts (Microsoft Graph, app-only). Pure
// data here (no server deps) so it is safe to static-import from either path.
//
// LANE (must match the prioritize house-style, or tool choice drifts): this tool reads the user's RAW
// external (Microsoft/Outlook) calendar EVENTS only. The user's SCHEDULE / agenda / day / priorities is
// the COMBINED nightly schedule (tasks + calendar) served by `prioritize` (view 'scheduled') — the
// description below tells the model to route "schedule" there, not here.
export const GET_CALENDAR_EVENTS_TOOL = {
  type: "function" as const,
  name: "get_calendar_events",
  description:
    "Read the user's RAW EXTERNAL Microsoft/Outlook calendar directly. RARE — use this ONLY when the user EXPLICITLY says \"external calendar\", \"Outlook calendar\", or \"Microsoft calendar\" (they want to bypass their normal schedule and see the raw external calendar). Do NOT use it for ANY other wording — \"what's on my calendar / schedule / agenda / day / plate / today\", meetings, appointments, free/busy, tasks, priorities, or backlog ALL go to the `prioritize` tool (view 'scheduled'), which is the user's COMBINED nightly schedule with their external calendar items ALREADY merged in — that is the source of truth. Reads REAL calendar data — never answer from memory. Dates are ISO (YYYY-MM-DD or full ISO datetime). Returns Microsoft/Outlook events; a Google-only calendar won't appear.",
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
