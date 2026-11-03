# BUILD-calendar-edit — agents can move/retime and delete the owner's calendar events

# WHAT:       build log for two new journey execute-tool cases, `update_calendar_event` + `delete_calendar_event`, and their Huddle exposure
# WHY:        journey had create-only calendar tools (`create_calendar_event`/`create_google_event`/`create_outlook_event`), so "move my 3pm with Dana to 4" / "cancel tomorrow's study block" could not be done
# SUPERSEDES: nothing
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   this file; branches `claude_calendar-edit` in deventerprisesds/journey-voice and deventerpriseds-org/huddle-extension-app

Scope rule: ADDITIVE ONLY. Event creation, calendar reads, briefs and alarms must behave exactly as before.

## Step 1 — Investigation (read from source, journey origin/main 0796822)

### Q1. How do the create_* cases get Google/Outlook tokens?
- `execute-tool/index.ts` `createOutlookEvent` / `createGoogleEvent` (L2232-2340) do NOT touch tokens. They
  `supabase.functions.invoke('send-unified-notification', {channels:['OUTLOOK_EVENT'|'GOOGLE_EVENT'], ...})`.
  `createCalendarEvent` (L2342) just picks one of those two by `args.calendar` (default outlook).
- Tokens live in `send-unified-notification/index.ts`:
  - `getCalendarConnectionForUser(client, userId, providers, label)` (L151) reads `public.calendar_connections`
    filtered `user_id = userId`, `provider IN (...)` (`['office365','outlook']` or `['google']`), `is_active = true`,
    preferring a non-expired row, then decrypts via RPC `decrypt_token(encrypted_token, p_user_id)`.
  - Refresh: `refreshOutlookToken` (MICROSOFT_CLIENT_ID/SECRET, scope `Calendars.ReadWrite offline_access`) and
    `refreshGoogleToken` (GOOGLE_CLIENT_ID/SECRET), both re-encrypt with `encrypt_token` and write back to the row.
  - Calls: Graph `POST /me/calendar/events`, Google `POST /calendar/v3/calendars/primary/events`.
- So the token path is DELEGATED per-user OAuth (journey's own tokens), scoped by `user_id`. The Outlook refresh
  scope is already `Calendars.ReadWrite`, so edit/delete needs no new consent on the Outlook side.

### Q2. Is an events table / external event id stored, so an existing event can be found?
- YES: `public.external_calendar_events` (migration 20250928025947): `user_id`, `connection_id -> calendar_connections(id)`,
  `external_event_id` (provider id), `title`, `start_time`, `end_time`, `calendar_id`, `is_all_day`, `location`,
  later `is_recurring`; UNIQUE(connection_id, external_event_id).
- Written by `calendar-delta-sync` (Outlook `calendarView/delta`, Google `calendars/primary/events`), and by
  `send-unified-notification` for task-linked Outlook creates (`source_task_id`).
- Provider of a row = `calendar_connections.provider` via `connection_id`. Google rows store the organizer email in
  `calendar_id` (not a calendar id) and delta-sync only reads `primary`, so Google edits target `primary`.
- `tasks.external_event_id` also exists (task <-> event link).

### Q3. How does Huddle read events?
- `get_calendar_events` (Huddle-native) = Microsoft Graph app-only `GET /users/{mailbox}/calendarView`
  (`email/graph-email.server.ts`), Outlook only.
- `get_external_calendar_events` = raw Outlook Graph read (huddle.functions.ts ~L4710, voice/realtime-tools.server.ts ~L553).
- Huddle has NO calendar write of its own. Journey tools reach Huddle through `fetchJourneyToolDefinitionsForHuddle()`
  (`journey/proxy.functions.ts`) = journey's `/tools` catalog minus `HIDDEN_FROM_HUDDLE = {web_search, send_email}`.
  journey `huddle-proxy` serves `/tools` from execute-tool's definitions and `/tool` delegates to execute-tool.
  => adding the two definitions to journey's `_shared/tool-definitions.ts` exposes them to Huddle with NO Huddle code.
- Gating already in place for every journey tool:
  - text: `ensureJourneyTools()` returns null unless a member has `agents[id].journey.enabled` (opt-in);
  - voice: the catalog is only pushed when `opts.journey !== false`.
- `UI_ONLY_JOURNEY_TOOLS = {delete_task}` in `invokeJourneyTool` blocks model calls to user-only tools.
  `delete_calendar_event` is deliberately NOT added there: the brief asks that agents can delete on an explicit
  user request, so the delete guard lives in journey (Step 2).
