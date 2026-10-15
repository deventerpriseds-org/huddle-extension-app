# schedule-brief-fix — evidence log

WHAT:       running log for the schedule-brief (Bug A) + duplicate review-digest (Bug B) fix.
WHY:        Iris 8am/8pm brief never delivered (0 schedule-brief-% turns ever); review digests arrive in pairs.
SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; branch claude_schedule-brief-fix.

## Findings (appended as discovered)

### A1 — brief reads the WRONG MAILBOX (code read, confirmed)
- `schedule-brief.server.ts` `meetingsForDate` calls `getGraphCalendarEvents({startISO,endISO,timeZone})`
  with NO `mailbox`. `getGraphCalendarEvents` then falls back to `defaultFrom()` = first entry of
  `HUDDLE_EMAIL_FROM` (default `dev@enterpriseds.io`) — the SENDING mailbox, not the owner's calendar.
- The working agent tool `get_external_calendar_events` (huddle.functions.ts ~4436, realtime-tools.server.ts ~512)
  passes `mailbox = resolveTaskEmail(caller) ?? caller.entra_email` (canonical owner email).
- So the brief queried a different calendar than the one the owner's meetings live in.

### A2 — Graph times are zone-less (code read)
- Graph with `Prefer: outlook.timezone="America/New_York"` returns `start.dateTime` like
  `2026-10-15T09:00:00.0000000` with NO offset. `briefLines`/`clock()` does `new Date(iso)`, which on the
  server (UTC) treats it as UTC -> rendered 4h early. The sort also mixes Nexus (offset) and Graph (no offset).

### B1 — duplicate-job fix ALREADY on main (#68, c1c9e32, merged 2026-10-15 16:07 UTC)
- `scheduledJobId` now keys on user_id (`<prefix>-u-<userId>`), `retireDuplicateScheduledJobs` disables
  other rows of the same job_type + user_id. The observation may predate this deploy; checking live.
