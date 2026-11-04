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

## Step 2 — Build (resumed after a container restart, 2026-11-04)

### journey-voice: NOT pushed — blocked by this agent's worktree isolation
This agent runs worktree-isolated in huddle-extension-app. Its harness REFUSED every git
operation on journey-voice (`cd` into it, `git -C`, and even shell lines naming the repo's
GitHub URL). Routing around that block via the GitHub MCP `push_files` or a scratchpad clone
was deliberately NOT done. The journey change was built and tested out of tree at
`<scratchpad>/journey-patch/` and must be applied by a session that may write journey:
- NEW `supabase/functions/_shared/calendar-edit.ts` — find (event_id, or match_title +
  match_start_time within +/-90 min against the caller's own `external_calendar_events` rows),
  ambiguity -> `candidates` and no provider call, PATCH/DELETE on Graph `/me/events/{id}` or
  Google `calendars/primary/events/{id}`, token path mirrors create's (calendar_connections by
  user_id + provider + is_active, decrypt_token, 5-min-buffer refresh). Delete refuses unless
  `user_explicitly_requested === true`. Original duration kept when only a new start is given.
- NEW `supabase/functions/_shared/calendar-edit.test.ts` — 14 tests, mocked fetch + DB.
- HUNKS for `execute-tool/index.ts` (1 import, 2 new cases after `create_calendar_event`, 1 new
  helper) and `_shared/tool-definitions.ts` (2 definitions after `create_calendar_event`).
  No existing line changes. Base: journey origin/main 8b7bd07 (local checkout was a stale
  branch; execute-tool and tool-definitions both have commits on main newer than it).

Evidence (run in scratchpad, node v22.22.0, same flags as checks.yml `npm test`):
- `node --experimental-strip-types --test calendar-edit.test.ts` -> pass 14 / fail 0
- `node scripts/undef-check.mjs calendar-edit.ts calendar-edit.test.ts` -> 0 NEW, exit 0
  (first run flagged `fetchImpl` — the guard misses a parameter bound after an arrow-typed
  param; fixed by binding through `const http`.)
- Mutations (scripted harness, anchor-count==1 else NOT-APPLIED, restore md5-asserted;
  mutate.sh needs a git-tracked file, which the out-of-tree copy is not):
  FIRED delete GUARD (consent check -> false); FIRED ambiguity (`=== 1` -> `>= 1`);
  FIRED already-gone (404/410 branch -> false).
- NOT run: full journey `npm test` (needs the journey tree), deploy-staleness guard (unrelated).

### Huddle: no runtime code needed — confirmed and pinned
- Text: `ensureJourneyTools()` (huddle.functions.ts L923-941) returns null unless a member has
  `agents[id].journey.enabled` -> the new tools are opt-in exactly like create.
- Voice: `buildRealtimeToolset` pushes the catalog only `if (opts.journey !== false)` (L454).
- NEW `scripts/journey-calendar-edit-exposure.test.ts` (+ `npm run test:calendar-edit`): 13/13.

### Huddle verification
- `npx tsc --noEmit -p .` -> exit 0, no output
- `npm run test:calendar-edit` -> 13 passed, 0 failed; `npm run test:voice-tools` -> 36 passed, 0 failed (regression control)
- mutate.sh (all FIRED, restore matched HEAD each time):
  - realtime-tools `if (opts.journey !== false) {` -> `if (true) {` -> FIRED 'voice journey:false does NOT offer delete_calendar_event'
  - HIDDEN_FROM_HUDDLE += delete_calendar_event -> FIRED 'catalog: delete_calendar_event passes HIDDEN_FROM_HUDDLE'
  - UI_ONLY_JOURNEY_TOOLS += update_calendar_event -> FIRED 'invokeJourneyTool forwards update_calendar_event (not UI-only)'
- No real calendar call, no live app, no DB touched.

## NEEDS OWNER 👍

| Today | Becomes | Why | Impact | Reversible |
|---|---|---|---|---|
| Create's token code (connection pick, decrypt, refresh) lives privately in send-unified-notification; edit/delete carry a second, matching copy in `_shared/calendar-edit.ts` | Create moves onto the shared copy, so there's one token path | Two copies of OAuth refresh logic will drift | Create's code path changes (it should behave the same) and needs a live re-test of event creation | Yes, git revert |
| `external_calendar_events` is written only by calendar-delta-sync (plus task-linked Outlook creates) | Edit/delete also update or remove the mirror row right away | Until the next delta sync, a moved event still shows at its old time to briefs, alarms and a second find-by-time | Briefs and reads would see changes sooner; this is the data path the brief froze | Yes |
| Delete consent is a model-set flag (`user_explicitly_requested: true`) plus the tool description | Optionally a hard user confirmation (a confirm card, or UI-only like `delete_task`) | The flag is the model's own claim, not proof the user asked | Adds a confirm step before deletes | Yes |
| Google edits target `primary` only (same as delta-sync reads) | Edit events on other Google calendars | Events on secondary calendars can't be found or edited | None today; it's a known limit | n/a |
